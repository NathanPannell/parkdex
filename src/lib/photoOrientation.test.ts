import { describe, expect, it } from "vitest";
import { decoderIgnoredOrientation, jpegOrientation, orientationTransform, uprightSize, type Orientation } from "./photoOrientation";

/** A minimal JPEG header: SOI, an EXIF APP1 with one orientation entry, then SOS. */
function jpegWithOrientation(orientation: number, littleEndian: boolean): Uint8Array {
  const u16 = (value: number) => (littleEndian ? [value & 0xff, value >> 8] : [value >> 8, value & 0xff]);
  const u32 = (value: number) =>
    littleEndian
      ? [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, value >>> 24]
      : [value >>> 24, (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
  const tiff = [
    ...(littleEndian ? [0x49, 0x49] : [0x4d, 0x4d]),
    ...u16(42),
    ...u32(8),
    ...u16(2),
    ...u16(0x010f),
    ...u16(2),
    ...u32(4),
    0x41,
    0x42,
    0x43,
    0x00, // Make: "ABC"
    ...u16(0x0112),
    ...u16(3),
    ...u32(1),
    ...u16(orientation),
    0,
    0,
    ...u32(0),
  ];
  const body = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff];
  const length = body.length + 2;
  return new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xe1, length >> 8, length & 0xff, ...body, 0xff, 0xda, 0x00, 0x02]);
}

/** Where the stored pixel (x, y) lands after the transform. */
function apply([a, b, c, d, e, f]: number[], x: number, y: number): [number, number] {
  return [a * x + c * y + e, b * x + d * y + f];
}

describe("jpegOrientation", () => {
  it("reads the orientation in either byte order", () => {
    for (const orientation of [1, 3, 6, 8]) {
      expect(jpegOrientation(jpegWithOrientation(orientation, true))).toBe(orientation);
      expect(jpegOrientation(jpegWithOrientation(orientation, false))).toBe(orientation);
    }
  });

  it("is upright for a JPEG without EXIF, a broken tag or something that is not a JPEG", () => {
    expect(jpegOrientation(new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0x00, 0x02]))).toBe(1);
    expect(jpegOrientation(jpegWithOrientation(9, true))).toBe(1);
    expect(jpegOrientation(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBe(1);
    expect(jpegOrientation(jpegWithOrientation(6, true).slice(0, 30))).toBe(1);
  });
});

describe("turning a photo upright", () => {
  it("swaps width and height only for the quarter turns", () => {
    expect(uprightSize(4032, 3024, 1)).toEqual({ width: 4032, height: 3024 });
    expect(uprightSize(4032, 3024, 3)).toEqual({ width: 4032, height: 3024 });
    for (const orientation of [5, 6, 7, 8] as Orientation[]) expect(uprightSize(4032, 3024, orientation)).toEqual({ width: 3024, height: 4032 });
  });

  it("maps every stored corner inside the upright canvas", () => {
    const width = 400;
    const height = 300;
    for (const orientation of [1, 2, 3, 4, 5, 6, 7, 8] as Orientation[]) {
      const size = uprightSize(width, height, orientation);
      const matrix = orientationTransform(orientation, width, height);
      for (const [x, y] of [
        [0, 0],
        [width, 0],
        [0, height],
        [width, height],
      ]) {
        const [ux, uy] = apply(matrix, x, y);
        expect(ux).toBeGreaterThanOrEqual(0);
        expect(uy).toBeGreaterThanOrEqual(0);
        expect(ux).toBeLessThanOrEqual(size.width);
        expect(uy).toBeLessThanOrEqual(size.height);
      }
    }
  });

  it("turns orientation 6 a quarter clockwise: the stored top-left goes to the top-right", () => {
    expect(apply(orientationTransform(6, 400, 300), 0, 0)).toEqual([300, 0]);
    expect(apply(orientationTransform(8, 400, 300), 0, 0)).toEqual([0, 400]);
  });

  it("spots a decoder that left a quarter-turn photo sideways", () => {
    const stored = { width: 4032, height: 3024 };
    expect(decoderIgnoredOrientation(6, stored, { width: 4032, height: 3024 })).toBe(true);
    expect(decoderIgnoredOrientation(6, stored, { width: 3024, height: 4032 })).toBe(false);
    expect(decoderIgnoredOrientation(1, stored, { width: 4032, height: 3024 })).toBe(false);
    expect(decoderIgnoredOrientation(3, stored, { width: 4032, height: 3024 })).toBe(false);
    expect(decoderIgnoredOrientation(8, { width: 2000, height: 2000 }, { width: 2000, height: 2000 })).toBe(false);
  });
});
