/**
 * A small JPEG segment walker for founder photos. It checks the file is a baseline or
 * progressive JPEG, reads its dimensions, and drops the segments that carry metadata: APP1 to
 * APP15 (EXIF with GPS position and device details, XMP, ICC profiles, maker notes) and COM.
 * APP0 (JFIF) and every segment the decoder needs stay as they are, so the image is unchanged.
 * Nothing after the end-of-image marker is kept, so trailing data cannot hide anything.
 */

export interface StrippedJpeg {
  bytes: Uint8Array;
  width: number;
  height: number;
  /** How many metadata segments were removed. */
  removed: number;
}

export class JpegError extends Error {}

const SOI = 0xd8;
const EOI = 0xd9;
const SOS = 0xda;
const COM = 0xfe;
const TEM = 0x01;

function isRestart(marker: number): boolean {
  return marker >= 0xd0 && marker <= 0xd7;
}

function isMetadata(marker: number): boolean {
  return (marker >= 0xe1 && marker <= 0xef) || marker === COM;
}

/** Start-of-frame markers carry the dimensions. C4 (DHT), C8 (JPG) and CC (DAC) are not frames. */
function isFrame(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

export function stripJpegMetadata(input: Uint8Array): StrippedJpeg {
  const n = input.length;
  if (n < 4 || input[0] !== 0xff || input[1] !== SOI) throw new JpegError("not a JPEG");
  const kept: Uint8Array[] = [input.subarray(0, 2)];
  let i = 2;
  let width = 0;
  let height = 0;
  let scans = 0;
  let removed = 0;
  let ended = false;
  while (i < n) {
    if (input[i] !== 0xff) throw new JpegError("expected a marker");
    // Any number of 0xFF fill bytes may precede a marker.
    while (i < n && input[i] === 0xff) i += 1;
    if (i >= n) throw new JpegError("truncated marker");
    const marker = input[i];
    const start = i - 1;
    i += 1;
    if (marker === EOI) {
      kept.push(input.subarray(start, i));
      ended = true;
      break;
    }
    if (marker === SOI || marker === 0x00) throw new JpegError("unexpected marker");
    if (isRestart(marker) || marker === TEM) {
      kept.push(input.subarray(start, i));
      continue;
    }
    if (i + 2 > n) throw new JpegError("truncated segment");
    const length = (input[i] << 8) | input[i + 1];
    if (length < 2 || i + length > n) throw new JpegError("bad segment length");
    const end = i + length;
    if (isFrame(marker)) {
      if (length < 8) throw new JpegError("bad frame header");
      if (width || height) throw new JpegError("more than one frame");
      height = (input[i + 3] << 8) | input[i + 4];
      width = (input[i + 5] << 8) | input[i + 6];
      if (!width || !height) throw new JpegError("missing dimensions");
    }
    if (isMetadata(marker)) removed += 1;
    else kept.push(input.subarray(start, end));
    i = end;
    if (marker === SOS) {
      if (!width) throw new JpegError("scan before frame");
      scans += 1;
      // Entropy-coded data runs until a marker other than a stuffed 0x00 or a restart marker.
      let j = i;
      while (j < n) {
        if (input[j] !== 0xff) { j += 1; continue; }
        const next = input[j + 1];
        if (next === undefined) throw new JpegError("truncated scan");
        if (next === 0x00 || isRestart(next)) { j += 2; continue; }
        if (next === 0xff) { j += 1; continue; }
        break;
      }
      kept.push(input.subarray(i, j));
      i = j;
    }
  }
  if (!ended) throw new JpegError("missing end of image");
  if (!scans) throw new JpegError("no image data");
  const size = kept.reduce((total, part) => total + part.length, 0);
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of kept) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return { bytes, width, height, removed };
}
