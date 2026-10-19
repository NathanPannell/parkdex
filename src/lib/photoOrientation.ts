/**
 * EXIF orientation for photos from the camera. Browsers and the Android WebView normally turn a
 * photo upright while decoding it. These helpers find the rare decoder that did not, so the
 * crop (#173) is always made against the photo the way the player saw it.
 */

/** 1 is upright. 2–8 are the EXIF mirror and rotation codes; 5–8 swap width and height. */
export type Orientation = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

function u16(bytes: Uint8Array, offset: number, little: boolean): number {
  return little ? bytes[offset] | (bytes[offset + 1] << 8) : (bytes[offset] << 8) | bytes[offset + 1];
}

function u32(bytes: Uint8Array, offset: number, little: boolean): number {
  return little
    ? (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0
    : ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
}

/** The orientation tag in an EXIF block (the APP1 body after "Exif\0\0"), or 1. */
function tiffOrientation(bytes: Uint8Array, start: number, end: number): Orientation {
  if (start + 8 > end) return 1;
  const order = String.fromCharCode(bytes[start], bytes[start + 1]);
  if (order !== "II" && order !== "MM") return 1;
  const little = order === "II";
  if (u16(bytes, start + 2, little) !== 42) return 1;
  const ifd = start + u32(bytes, start + 4, little);
  if (ifd + 2 > end) return 1;
  const entries = u16(bytes, ifd, little);
  for (let index = 0; index < entries; index += 1) {
    const entry = ifd + 2 + index * 12;
    if (entry + 12 > end) return 1;
    if (u16(bytes, entry, little) !== 0x0112) continue;
    const value = u16(bytes, entry + 8, little);
    return value >= 1 && value <= 8 ? (value as Orientation) : 1;
  }
  return 1;
}

/** The EXIF orientation of a JPEG, read from its first bytes. 1 when there is none. */
export function jpegOrientation(bytes: Uint8Array): Orientation {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return 1;
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return 1;
    const marker = bytes[offset + 1];
    // Start of scan or end of image: no metadata follows.
    if (marker === 0xda || marker === 0xd9) return 1;
    const length = u16(bytes, offset + 2, false);
    if (length < 2) return 1;
    const body = offset + 4;
    const end = Math.min(bytes.length, offset + 2 + length);
    if (marker === 0xe1 && end - body >= 6 && String.fromCharCode(...bytes.subarray(body, body + 6)) === "Exif\0\0") {
      return tiffOrientation(bytes, body + 6, end);
    }
    offset += 2 + length;
  }
  return 1;
}

/** The size of the photo once it is upright. */
export function uprightSize(width: number, height: number, orientation: Orientation): { width: number; height: number } {
  return orientation >= 5 ? { width: height, height: width } : { width, height };
}

/**
 * The canvas transform (a, b, c, d, e, f) that draws the stored pixels, `width` by `height`,
 * upright into a canvas of `uprightSize`.
 */
export function orientationTransform(orientation: Orientation, width: number, height: number): [number, number, number, number, number, number] {
  switch (orientation) {
    case 2:
      return [-1, 0, 0, 1, width, 0];
    case 3:
      return [-1, 0, 0, -1, width, height];
    case 4:
      return [1, 0, 0, -1, 0, height];
    case 5:
      return [0, 1, 1, 0, 0, 0];
    case 6:
      return [0, 1, -1, 0, height, 0];
    case 7:
      return [0, -1, -1, 0, height, width];
    case 8:
      return [0, -1, 1, 0, 0, width];
    default:
      return [1, 0, 0, 1, 0, 0];
  }
}

/**
 * True when a decoder ignored a quarter-turn orientation: the decoded image still has the stored
 * width and height. Mirror-only and half-turn codes keep the size, so they cannot be told apart
 * and are left to the decoder; camera apps write 1, 3, 6 or 8.
 */
export function decoderIgnoredOrientation(
  orientation: Orientation,
  stored: { width: number; height: number },
  decoded: { width: number; height: number },
): boolean {
  return orientation >= 5 && stored.width !== stored.height && decoded.width === stored.width && decoded.height === stored.height;
}
