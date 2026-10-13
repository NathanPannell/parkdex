import { MAX_BACKUP_PHOTO_BYTES, jpegDimensions } from "./accounts/photoBackupRendition";
import { cropPixels, type PhotoCrop } from "./photoCrop";
import { decoderIgnoredOrientation, jpegOrientation, orientationTransform, uprightSize } from "./photoOrientation";

/**
 * Photo encoding, all through a canvas, which also drops EXIF (it can carry GPS and device
 * details). Two renditions come from one capture (#173):
 *
 * - the original: upright, at most 2,048 px on the long edge and 2.5 MB, the same limits as the
 *   private photo backup (`accounts/photoBackupRendition.ts`). It is kept with its crop.
 * - the upload: the crop of the original, at most 1,280 px on the long edge and 1.5 MB. Founder
 *   moderation and the public cover use this one.
 */

export const MAX_PHOTO_EDGE = 1280;
export const PHOTO_QUALITY = 0.82;
// The server refuses photos over 1.5 MB; step the quality down before that happens.
export const MAX_PHOTO_BYTES = 1_500_000;
const FALLBACK_QUALITIES = [0.72, 0.6];

export const MAX_ORIGINAL_EDGE = 2048;
export const ORIGINAL_QUALITY = 0.9;
const ORIGINAL_FALLBACK_QUALITIES = [0.82, 0.72, 0.6];

export type EncodedPhoto = { dataUrl: string; base64: string; width: number; height: number; bytes: number };

/** The photo as taken, made upright and re-encoded without metadata. Its crop is kept beside it. */
export type OriginalPhoto = { blob: Blob; dataUrl: string; width: number; height: number; bytes: number };

/** One finished capture: the original, the player's crop of it, and the cropped upload. */
export type CapturedPhoto = { original: OriginalPhoto; crop: PhotoCrop; cropped: EncodedPhoto };

/** Something a canvas can draw, with its upright size. */
export type Drawable = { source: CanvasImageSource; width: number; height: number };

/** The size that fits within `maxEdge` on the long side, keeping the shape and never enlarging. */
export function fitWithin(width: number, height: number, maxEdge = MAX_PHOTO_EDGE): { width: number; height: number } {
  if (!(width > 0) || !(height > 0)) throw new Error("The photo has no size.");
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

const JPEG_PREFIX = "data:image/jpeg;base64,";

/** The base64 body of a JPEG data URL. */
export function jpegBase64(dataUrl: string): string {
  if (!dataUrl.startsWith(JPEG_PREFIX)) throw new Error("The photo could not be encoded as JPEG.");
  return dataUrl.slice(JPEG_PREFIX.length);
}

/** How many bytes a base64 string decodes to. */
export function base64Bytes(base64: string): number {
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
}

function blobFromBase64(base64: string, type: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new Blob([bytes], { type });
}

function openCanvas(width: number, height: number): { canvas: HTMLCanvasElement; context: CanvasRenderingContext2D } {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("A photo canvas could not be opened.");
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  return { canvas, context };
}

/** Encodes a canvas as JPEG, stepping the quality down until it fits `maxBytes`. */
function encodeCanvas(canvas: HTMLCanvasElement, qualities: number[], maxBytes: number): EncodedPhoto {
  let encoded: EncodedPhoto | null = null;
  for (const quality of qualities) {
    const dataUrl = canvas.toDataURL("image/jpeg", quality);
    const base64 = jpegBase64(dataUrl);
    encoded = { dataUrl, base64, width: canvas.width, height: canvas.height, bytes: base64Bytes(base64) };
    if (encoded.bytes <= maxBytes) break;
  }
  if (!encoded || encoded.bytes > maxBytes) throw new Error("This photo is too large. Try another one.");
  return encoded;
}

/**
 * The upload rendition: draws the crop of the image (or all of it without one) at its upload size
 * and encodes it, stepping quality down if it is too large.
 */
export function encodePhoto({ source, width, height }: Drawable, options: { crop?: PhotoCrop } = {}): EncodedPhoto {
  const area = options.crop ? cropPixels(options.crop, width, height) : { sx: 0, sy: 0, sw: width, sh: height };
  const size = fitWithin(area.sw, area.sh);
  const { canvas, context } = openCanvas(size.width, size.height);
  context.drawImage(source, area.sx, area.sy, area.sw, area.sh, 0, 0, size.width, size.height);
  return encodeCanvas(canvas, [PHOTO_QUALITY, ...FALLBACK_QUALITIES], MAX_PHOTO_BYTES);
}

/**
 * The original rendition, plus the canvas it was drawn from so the crop can be encoded without
 * decoding the photo again. `mirror` bakes a front-camera preview's mirroring into the original.
 */
export function prepareOriginal({ source, width, height }: Drawable, options: { mirror?: boolean } = {}): { photo: OriginalPhoto; drawable: Drawable } {
  const size = fitWithin(width, height, MAX_ORIGINAL_EDGE);
  const { canvas, context } = openCanvas(size.width, size.height);
  if (options.mirror) {
    context.translate(size.width, 0);
    context.scale(-1, 1);
  }
  context.drawImage(source, 0, 0, size.width, size.height);
  const encoded = encodeCanvas(canvas, [ORIGINAL_QUALITY, ...ORIGINAL_FALLBACK_QUALITIES], MAX_BACKUP_PHOTO_BYTES);
  return {
    photo: { blob: blobFromBase64(encoded.base64, "image/jpeg"), dataUrl: encoded.dataUrl, width: encoded.width, height: encoded.height, bytes: encoded.bytes },
    drawable: { source: canvas, width: canvas.width, height: canvas.height },
  };
}

type Decoded = Drawable & { release: () => void };

/** EXIF and the frame header sit near the start of a JPEG; this is plenty for camera photos. */
const HEADER_BYTES = 256 * 1024;

/** Turns a decoded image upright when the decoder ignored a quarter-turn EXIF orientation. */
async function upright(blob: Blob, decoded: Decoded): Promise<Decoded> {
  if (blob.type.toLowerCase() !== "image/jpeg" && blob.type !== "") return decoded;
  const header = new Uint8Array(await blob.slice(0, HEADER_BYTES).arrayBuffer());
  const orientation = jpegOrientation(header);
  const stored = jpegDimensions(header);
  if (!stored || !decoderIgnoredOrientation(orientation, stored, decoded)) return decoded;
  const size = uprightSize(decoded.width, decoded.height, orientation);
  const { canvas, context } = openCanvas(size.width, size.height);
  context.setTransform(...orientationTransform(orientation, decoded.width, decoded.height));
  context.drawImage(decoded.source, 0, 0, decoded.width, decoded.height);
  decoded.release();
  return { source: canvas, width: size.width, height: size.height, release: () => {} };
}

/** Decodes a captured image upright, honouring its EXIF orientation. */
export async function decodePhoto(blob: Blob): Promise<Decoded> {
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(blob, { imageOrientation: "from-image" });
      return await upright(blob, { source: bitmap, width: bitmap.width, height: bitmap.height, release: () => bitmap.close() });
    } catch {
      // Some WebViews cannot decode into a bitmap; fall back to an image element.
    }
  }
  const url = URL.createObjectURL(blob);
  try {
    const image = await loadImage(url);
    return await upright(blob, { source: image, width: image.naturalWidth, height: image.naturalHeight, release: () => {} });
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Decodes a captured image and prepares its original rendition. */
export async function originalFromBlob(blob: Blob): Promise<{ photo: OriginalPhoto; drawable: Drawable }> {
  const decoded = await decodePhoto(blob);
  try {
    return prepareOriginal(decoded);
  } finally {
    decoded.release();
  }
}

export async function originalFromDataUrl(dataUrl: string): Promise<{ photo: OriginalPhoto; drawable: Drawable }> {
  const blob = await (await fetch(dataUrl)).blob();
  return originalFromBlob(blob);
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("This photo could not be opened. Try another one."));
    image.src = src;
  });
}
