import { PALETTES, type Park } from "../parks";

export const MAX_BACKUP_PHOTO_BYTES = 2_621_440;
export const MAX_PHOTO_CONVERSION_INPUT_BYTES = 20 * 1024 * 1024;
const MAX_INPUT_DIMENSION = 8_192;
const MAX_INPUT_PIXELS = 32_000_000;
const MAX_OUTPUT_DIMENSION = 2_048;
const JPEG_TYPE = "image/jpeg" as const;

export type SupportedPhotoType = "image/jpeg" | "image/png" | "image/webp";
export type ConvertedPhotoRendition = {
  blob: Blob;
  contentType: SupportedPhotoType;
  sizeBytes: number;
  sha256: string;
};

/** Keep byte-for-byte in sync with the desktop fallback photo made by the Camera screen. */
export function sceneSvg(park: Park) {
  const p = PALETTES[park.biome];
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 800" preserveAspectRatio="xMidYMid slice">
<defs><linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${p.skyTop}"/><stop offset="1" stop-color="${p.skyBottom}"/></linearGradient></defs>
<rect width="600" height="800" fill="url(#s)"/>
<circle cx="${180 + (park.seed % 240)}" cy="220" r="70" fill="${p.sun}"/>
<path d="M0 420 Q120 330 240 400 T480 370 T600 390 L600 800 L0 800Z" fill="${p.far}"/>
<path d="M0 500 Q150 430 300 490 T600 470 L600 800 L0 800Z" fill="${p.mid}"/>
<path d="M0 560 L600 540 L600 800 L0 800Z" fill="${p.water}" opacity=".85"/>
<path d="M0 640 Q160 590 320 650 T600 630 L600 800 L0 800Z" fill="${p.near}"/>
${Array.from({ length: 7 }, (_, i) => {
    const x = 30 + i * 90 + ((park.seed * (i + 3)) % 40);
    const h = 120 + ((park.seed * (i + 7)) % 90);
    return `<path d="M${x} ${700 - h} l${h * 0.28} ${h * 0.55} h-${h * 0.12} l${h * 0.2} ${h * 0.45} h-${h * 0.72} l${h * 0.2} -${h * 0.45} h-${h * 0.12}Z" fill="#14231C" opacity=".9"/>`;
  }).join("")}
</svg>`;
}

function dimensionsAreSafe(width: number, height: number): boolean {
  return Number.isSafeInteger(width) && Number.isSafeInteger(height) && width > 0 && height > 0 &&
    width <= MAX_INPUT_DIMENSION && height <= MAX_INPUT_DIMENSION && width * height <= MAX_INPUT_PIXELS;
}

function bigEndian32(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
}

function littleEndian24(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

/** The stored width and height of a JPEG, from its frame header. */
export function jpegDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  const frameMarkers = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    while (bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset++];
    if (marker === 0xd9 || marker === 0xda) return null;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
    if (offset + 2 > bytes.length) return null;
    const segmentLength = (bytes[offset] << 8) | bytes[offset + 1];
    if (segmentLength < 2 || offset + segmentLength > bytes.length) return null;
    if (frameMarkers.has(marker)) {
      if (segmentLength < 7) return null;
      return {
        height: (bytes[offset + 3] << 8) | bytes[offset + 4],
        width: (bytes[offset + 5] << 8) | bytes[offset + 6],
      };
    }
    offset += segmentLength;
  }
  return null;
}

function rasterDimensions(bytes: Uint8Array, contentType: string): { width: number; height: number } | null {
  if (contentType === "image/png") {
    if (bytes.length < 24 || ascii(bytes, 0, 8) !== "\x89PNG\r\n\x1a\n" || ascii(bytes, 12, 4) !== "IHDR") return null;
    return { width: bigEndian32(bytes, 16), height: bigEndian32(bytes, 20) };
  }
  if (contentType === "image/jpeg") return jpegDimensions(bytes);
  if (contentType !== "image/webp" || bytes.length < 30 || ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 4) !== "WEBP") return null;

  const chunk = ascii(bytes, 12, 4);
  if (chunk === "VP8X") return { width: 1 + littleEndian24(bytes, 24), height: 1 + littleEndian24(bytes, 27) };
  if (chunk === "VP8L" && bytes[20] === 0x2f) {
    return {
      width: 1 + ((bytes[22] & 0x3f) << 8) + bytes[21],
      height: 1 + ((bytes[22] & 0xc0) >> 6) + (bytes[23] << 2) + ((bytes[24] & 0x0f) << 10),
    };
  }
  if (chunk === "VP8 " && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
    return {
      width: ((bytes[27] << 8) | bytes[26]) & 0x3fff,
      height: ((bytes[29] << 8) | bytes[28]) & 0x3fff,
    };
  }
  return null;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) if (left[index] !== right[index]) return false;
  return true;
}

function isSupportedRasterHeader(bytes: Uint8Array, contentType: string): contentType is SupportedPhotoType {
  if (contentType === "image/jpeg") return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (contentType === "image/png") return bytes.length >= 8 && ascii(bytes, 0, 8) === "\x89PNG\r\n\x1a\n";
  return contentType === "image/webp" && bytes.length >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP";
}

type LoadedImage = { image: HTMLImageElement; release: () => void };

function loadImage(blob: Blob): Promise<LoadedImage> {
  if (typeof Image !== "function" || !globalThis.URL?.createObjectURL) return Promise.reject(new Error("Browser image conversion is unavailable."));
  const url = URL.createObjectURL(blob);
  return new Promise((resolve, reject) => {
    let image: HTMLImageElement;
    try { image = new Image(); }
    catch {
      URL.revokeObjectURL(url);
      reject(new Error("The saved photo could not be decoded."));
      return;
    }
    let settled = false;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      URL.revokeObjectURL(url);
    };
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (error) {
        release();
        reject(error);
      } else resolve({ image, release });
    };
    image.onload = () => {
      void (async () => {
        try {
          if (typeof image.decode === "function") await image.decode();
          finish();
        } catch {
          finish(new Error("The saved photo could not be decoded."));
        }
      })();
    };
    image.onerror = () => finish(new Error("The saved photo could not be decoded."));
    try { image.src = url; }
    catch { finish(new Error("The saved photo could not be decoded.")); }
  });
}

function canvasJpeg(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) reject(new Error("The saved photo could not be encoded."));
      else resolve(blob);
    }, JPEG_TYPE, quality);
  });
}

async function encodeJpeg(image: CanvasImageSource, sourceWidth: number, sourceHeight: number, initialMaxDimension: number): Promise<Blob | null> {
  if (typeof document === "undefined") return null;
  let scale = Math.min(1, initialMaxDimension / Math.max(sourceWidth, sourceHeight));
  let quality = 0.82;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const width = Math.max(1, Math.floor(sourceWidth * scale));
    const height = Math.max(1, Math.floor(sourceHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    try {
      const context = canvas.getContext("2d");
      if (!context) return null;
      context.fillStyle = "#fff";
      context.fillRect(0, 0, width, height);
      context.drawImage(image, 0, 0, width, height);
      const result = await canvasJpeg(canvas, quality);
      if (result.type.toLowerCase() === JPEG_TYPE && result.size > 0 && result.size <= MAX_BACKUP_PHOTO_BYTES) return result;
    } catch { return null; }
    finally { canvas.width = 0; canvas.height = 0; }
    scale *= 0.78;
    quality = Math.max(0.56, quality - 0.07);
  }
  return null;
}

async function digest(blob: Blob): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error("Photo integrity checks are unavailable.");
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", await blob.arrayBuffer()));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function rendition(blob: Blob): Promise<ConvertedPhotoRendition | null> {
  if (blob.type.toLowerCase() !== JPEG_TYPE || blob.size <= 0 || blob.size > MAX_BACKUP_PHOTO_BYTES) return null;
  const bytes = new Uint8Array(await blob.slice(0, 3).arrayBuffer());
  if (!isSupportedRasterHeader(bytes, JPEG_TYPE)) return null;
  return { blob, contentType: JPEG_TYPE, sizeBytes: blob.size, sha256: await digest(blob) };
}

/**
 * Convert only the exact desktop fallback SVG or a bounded oversized raster.
 * SVG content is never parsed or loaded unless every input byte matches the
 * locally generated scene for the frozen park snapshot.
 */
export async function createPhotoBackupRendition(original: Blob, parkSnapshot: Park | null): Promise<ConvertedPhotoRendition | null> {
  if (original.size <= 0 || original.size > MAX_PHOTO_CONVERSION_INPUT_BYTES) return null;
  const contentType = original.type.toLowerCase();

  if (contentType === "image/svg+xml") {
    if (!parkSnapshot) return null;
    let expected: Uint8Array;
    let actual: Uint8Array;
    try {
      expected = new TextEncoder().encode(sceneSvg(parkSnapshot));
      actual = new Uint8Array(await original.arrayBuffer());
    } catch { return null; }
    if (!sameBytes(actual, expected)) return null;
    try {
      const safeSvg = sceneSvg(parkSnapshot).replace("<svg ", '<svg width="600" height="800" ');
      const safeSvgBytes = new TextEncoder().encode(safeSvg);
      const loaded = await loadImage(new Blob([safeSvgBytes.slice().buffer as ArrayBuffer], { type: "image/svg+xml;charset=utf-8" }));
      try {
        const image = loaded.image;
        if (!dimensionsAreSafe(image.naturalWidth, image.naturalHeight)) return null;
        return rendition(await encodeJpeg(image, image.naturalWidth, image.naturalHeight, 960) ?? new Blob());
      } finally { loaded.release(); }
    } catch { return null; }
  }

  if (contentType !== "image/jpeg" && contentType !== "image/png" && contentType !== "image/webp") return null;
  if (original.size <= MAX_BACKUP_PHOTO_BYTES) return null;
  let bytes: Uint8Array;
  try { bytes = new Uint8Array(await original.arrayBuffer()); }
  catch { return null; }
  if (!isSupportedRasterHeader(bytes, contentType)) return null;
  const dimensions = rasterDimensions(bytes, contentType);
  if (!dimensions || !dimensionsAreSafe(dimensions.width, dimensions.height)) return null;
  try {
    const loaded = await loadImage(original);
    try {
      const image = loaded.image;
      const sameDimensions = image.naturalWidth === dimensions.width && image.naturalHeight === dimensions.height;
      const exifOrientedDimensions = image.naturalWidth === dimensions.height && image.naturalHeight === dimensions.width;
      if ((!sameDimensions && !exifOrientedDimensions) || !dimensionsAreSafe(image.naturalWidth, image.naturalHeight)) return null;
      const converted = await encodeJpeg(image, image.naturalWidth, image.naturalHeight, MAX_OUTPUT_DIMENSION);
      return converted ? rendition(converted) : null;
    } finally { loaded.release(); }
  } catch { return null; }
}
