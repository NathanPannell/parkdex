import assert from "node:assert/strict";
import { test } from "node:test";
import { EXIF_GPS_JPEG } from "./fixtures/exif-gps-jpeg.ts";
import { JpegError, stripJpegMetadata } from "./jpeg.ts";

const text = (bytes: Uint8Array) => Buffer.from(bytes).toString("latin1");

function markers(bytes: Uint8Array): number[] {
  // Segment markers up to the first scan, which is where metadata lives.
  const found: number[] = [];
  let i = 2;
  while (i < bytes.length && bytes[i] === 0xff) {
    const marker = bytes[i + 1];
    found.push(marker);
    if (marker === 0xda) break;
    i += 2 + ((bytes[i + 2] << 8) | bytes[i + 3]);
  }
  return found;
}

/** A hand-built JPEG layout: enough for the walker, which never decodes the image. */
function synthetic(scan: number[], extra: number[] = []): Uint8Array {
  const segment = (marker: number, body: number[]) => [0xff, marker, (body.length + 2) >> 8, (body.length + 2) & 0xff, ...body];
  return new Uint8Array([
    0xff, 0xd8,
    ...segment(0xe0, [0x4a, 0x46, 0x49, 0x46, 0x00, 1, 1, 0, 0, 1, 0, 1, 0, 0]),
    ...segment(0xc0, [8, 0, 3, 0, 4, 1, 1, 0x11, 0]),
    ...segment(0xda, [1, 1, 0, 0, 63, 0]),
    ...scan,
    0xff, 0xd9,
    ...extra,
  ]);
}

test("a phone JPEG loses its EXIF GPS, XMP and comment and keeps everything the image needs", () => {
  const original = new Uint8Array(EXIF_GPS_JPEG);
  assert.ok(text(original).includes("QA Camera Maker") && text(original).includes("GPSLatitude") && text(original).includes("QA secret comment"));
  assert.deepEqual(markers(original).filter((marker) => marker === 0xe1 || marker === 0xfe), [0xe1, 0xe1, 0xfe]);

  const stripped = stripJpegMetadata(original);
  assert.equal(stripped.width, 16);
  assert.equal(stripped.height, 12);
  assert.equal(stripped.removed, 3);
  for (const secret of ["QA Camera Maker", "QA Phone 9", "GPSLatitude", "Exif", "QA secret comment", "xmpmeta"]) {
    assert.ok(!text(stripped.bytes).includes(secret), secret);
  }
  // SOI, APP0 (JFIF), quantisation tables, the frame, Huffman tables and the scan stay in order.
  assert.deepEqual(markers(stripped.bytes), [0xe0, 0xdb, 0xdb, 0xc0, 0xc4, 0xc4, 0xc4, 0xc4, 0xda]);
  assert.deepEqual([...stripped.bytes.subarray(0, 2)], [0xff, 0xd8]);
  assert.deepEqual([...stripped.bytes.subarray(-2)], [0xff, 0xd9]);
  // The image data itself is byte for byte the same.
  const scanStart = (bytes: Uint8Array) => text(bytes).indexOf("\xff\xda");
  assert.deepEqual(stripped.bytes.subarray(scanStart(stripped.bytes)), original.subarray(scanStart(original)));
  // Stripping is idempotent.
  assert.deepEqual(stripJpegMetadata(stripped.bytes).bytes, stripped.bytes);
  assert.equal(stripJpegMetadata(stripped.bytes).removed, 0);
});

test("scan data with stuffed bytes, restart markers and fill bytes passes through; data after the end is dropped", () => {
  const scan = [0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56, 0xff, 0xd7, 0x78];
  const input = synthetic(scan, [0x50, 0x4b, 0x03, 0x04, 0x73, 0x65, 0x63, 0x72, 0x65, 0x74]);
  const stripped = stripJpegMetadata(input);
  assert.equal(stripped.width, 4);
  assert.equal(stripped.height, 3);
  assert.deepEqual([...stripped.bytes], [...input.subarray(0, input.length - 10)]);
  // Extra 0xFF fill bytes before a marker are allowed.
  const filled = synthetic([0x11, 0xff, 0xff, 0xff, 0xd0, 0x22]);
  assert.equal(stripJpegMetadata(filled).width, 4);
});

test("metadata between scans of a progressive image is removed too", () => {
  const base = synthetic([0x01, 0x02]);
  const comment = [0xff, 0xfe, 0x00, 0x06, 0x68, 0x69, 0x21, 0x21];
  const secondScan = [0xff, 0xda, 0x00, 0x08, 1, 1, 0, 0, 63, 0, 0x03, 0x04];
  const input = new Uint8Array([...base.subarray(0, base.length - 2), ...comment, ...secondScan, 0xff, 0xd9]);
  const stripped = stripJpegMetadata(input);
  assert.equal(stripped.removed, 1);
  assert.ok(!text(stripped.bytes).includes("hi!!"));
  assert.deepEqual([...stripped.bytes.subarray(-14)], [...secondScan, 0xff, 0xd9]);
});

test("anything that is not a whole JPEG is refused", () => {
  const good = synthetic([0x01, 0x02]);
  const cases: [string, Uint8Array][] = [
    ["empty", new Uint8Array()],
    ["PNG", new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
    ["no end of image", good.subarray(0, good.length - 2)],
    ["truncated segment", good.subarray(0, 12)],
    ["no frame", new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0x00, 0x08, 1, 1, 0, 0, 63, 0, 0x01, 0xff, 0xd9])],
    ["no scan", new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 8, 0, 3, 0, 4, 1, 1, 0x11, 0, 0xff, 0xd9])],
    ["bad length", new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x01, 0xff, 0xd9])],
    ["garbage between segments", new Uint8Array([0xff, 0xd8, 0x00, 0xff, 0xd9])],
    // Height and width are bytes 25 to 28: after SOI, the 18-byte APP0 and the frame's marker, length and precision.
    ["zero dimensions", synthetic([0x01]).map((value, index) => (index >= 25 && index <= 28 ? 0 : value))],
  ];
  for (const [name, bytes] of cases) assert.throws(() => stripJpegMetadata(bytes), JpegError, name);
});
