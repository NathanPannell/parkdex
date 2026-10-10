/**
 * Prepares a founder photo for upload: at most 1,280 px on the long edge, re-encoded as JPEG
 * through a canvas. Re-encoding also drops EXIF, which can carry GPS and device details.
 */

export const MAX_PHOTO_EDGE = 1280;
export const PHOTO_QUALITY = 0.82;
// The server refuses photos over 1.5 MB; step the quality down before that happens.
export const MAX_PHOTO_BYTES = 1_500_000;
const FALLBACK_QUALITIES = [0.72, 0.6];

export type EncodedPhoto = { dataUrl: string; base64: string; width: number; height: number; bytes: number };

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

type Drawable = { source: CanvasImageSource; width: number; height: number };

/** Draws the image at its upload size and encodes it, stepping quality down if it is too large. */
export function encodePhoto({ source, width, height }: Drawable, options: { mirror?: boolean } = {}): EncodedPhoto {
  const size = fitWithin(width, height);
  const canvas = document.createElement("canvas");
  canvas.width = size.width;
  canvas.height = size.height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("A photo canvas could not be opened.");
  if (options.mirror) {
    context.translate(size.width, 0);
    context.scale(-1, 1);
  }
  context.drawImage(source, 0, 0, size.width, size.height);
  let encoded: EncodedPhoto | null = null;
  for (const quality of [PHOTO_QUALITY, ...FALLBACK_QUALITIES]) {
    const dataUrl = canvas.toDataURL("image/jpeg", quality);
    const base64 = jpegBase64(dataUrl);
    encoded = { dataUrl, base64, width: size.width, height: size.height, bytes: base64Bytes(base64) };
    if (encoded.bytes <= MAX_PHOTO_BYTES) break;
  }
  if (!encoded || encoded.bytes > MAX_PHOTO_BYTES) throw new Error("This photo is too large. Try another one.");
  return encoded;
}

/** Decodes a picked or captured image, honouring its EXIF rotation, then encodes it for upload. */
export async function encodePhotoBlob(blob: Blob): Promise<EncodedPhoto> {
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(blob, { imageOrientation: "from-image" });
      try {
        return encodePhoto({ source: bitmap, width: bitmap.width, height: bitmap.height });
      } finally {
        bitmap.close();
      }
    } catch (error) {
      if (error instanceof Error && /too large|canvas|JPEG/.test(error.message)) throw error;
      // Some WebViews cannot decode into a bitmap; fall back to an image element.
    }
  }
  const url = URL.createObjectURL(blob);
  try {
    const image = await loadImage(url);
    return encodePhoto({ source: image, width: image.naturalWidth, height: image.naturalHeight });
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function encodePhotoDataUrl(dataUrl: string): Promise<EncodedPhoto> {
  const blob = await (await fetch(dataUrl)).blob();
  return encodePhotoBlob(blob);
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("This photo could not be opened. Try another one."));
    image.src = src;
  });
}
