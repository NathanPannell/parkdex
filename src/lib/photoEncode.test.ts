import { describe, expect, it } from "vitest";
import { base64Bytes, fitWithin, jpegBase64, MAX_PHOTO_EDGE } from "./photoEncode";

describe("fitWithin", () => {
  it("scales the long edge down to 1,280 px and keeps the shape", () => {
    expect(fitWithin(4032, 3024)).toEqual({ width: MAX_PHOTO_EDGE, height: 960 });
    expect(fitWithin(3024, 4032)).toEqual({ width: 960, height: MAX_PHOTO_EDGE });
    expect(fitWithin(1920, 1080)).toEqual({ width: 1280, height: 720 });
  });

  it("never enlarges a small photo", () => {
    expect(fitWithin(800, 600)).toEqual({ width: 800, height: 600 });
  });

  it("refuses an image with no size", () => {
    expect(() => fitWithin(0, 600)).toThrow();
  });
});

describe("JPEG data", () => {
  it("takes the base64 body of a JPEG data URL only", () => {
    expect(jpegBase64("data:image/jpeg;base64,/9j/4AAQ")).toBe("/9j/4AAQ");
    expect(() => jpegBase64("data:image/png;base64,iVBOR")).toThrow(/JPEG/);
  });

  it("counts decoded bytes, padding included", () => {
    expect(base64Bytes(btoa("abc"))).toBe(3);
    expect(base64Bytes(btoa("abcd"))).toBe(4);
    expect(base64Bytes(btoa("abcde"))).toBe(5);
  });
});
