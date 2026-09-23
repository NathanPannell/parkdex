import { describe, expect, it, vi } from "vitest";

import {
  normalizeVisitPhoto,
  VISIT_PHOTO_MAX_BYTES,
  type VisitPhotoProcessingPrimitives,
} from "./photo-processing";

function photo(size = 2_000_000) {
  return { file: new File([new Uint8Array(size)], "field.heic", { type: "image/heic" }), mimeType: "image/heic" };
}

describe("visit photo processing", () => {
  it("bounds dimensions, strips the input type, and returns the first encoding below the field limit", async () => {
    const close = vi.fn();
    const encode = vi.fn()
      .mockResolvedValueOnce(new Blob([new Uint8Array(VISIT_PHOTO_MAX_BYTES + 1)], { type: "image/jpeg" }))
      .mockResolvedValueOnce(new Blob([new Uint8Array(700_000)], { type: "image/jpeg" }));
    const primitives: VisitPhotoProcessingPrimitives = {
      decode: vi.fn().mockResolvedValue({ width: 4_000, height: 3_000, source: {} as CanvasImageSource, close }),
      encode,
    };

    const result = await normalizeVisitPhoto(photo(), primitives);

    expect(result.file.type).toBe("image/jpeg");
    expect(result.processingState).toBe("prepared");
    expect(result.file.name).toBe("field.jpg");
    expect(result.file.size).toBe(700_000);
    expect(encode).toHaveBeenNthCalledWith(1, expect.anything(), { width: 1_600, height: 1_200, quality: 0.82 });
    expect(encode).toHaveBeenNthCalledWith(2, expect.anything(), { width: 1_600, height: 1_200, quality: 0.72 });
    expect(close).toHaveBeenCalledOnce();
  });

  it("uses bounded quality and resize attempts and closes decoded resources on failure", async () => {
    const close = vi.fn();
    const encode = vi.fn().mockResolvedValue(new Blob([new Uint8Array(VISIT_PHOTO_MAX_BYTES + 1)], { type: "image/jpeg" }));
    const primitives: VisitPhotoProcessingPrimitives = {
      decode: vi.fn().mockResolvedValue({ width: 1_600, height: 800, source: {} as CanvasImageSource, close }),
      encode,
    };

    await expect(normalizeVisitPhoto(photo(), primitives)).rejects.toThrow(/too detailed/i);
    expect(encode).toHaveBeenCalledTimes(12);
    expect(encode).toHaveBeenLastCalledWith(expect.anything(), { width: 1_072, height: 536, quality: 0.52 });
    expect(close).toHaveBeenCalledOnce();
  });

  it("rejects invalid decoded dimensions without attempting an encode", async () => {
    const encode = vi.fn();
    await expect(normalizeVisitPhoto(photo(), {
      decode: vi.fn().mockResolvedValue({ width: 0, height: 100, source: {} as CanvasImageSource }),
      encode,
    })).rejects.toThrow(/invalid dimensions/i);
    expect(encode).not.toHaveBeenCalled();
  });

  it("returns a valid prepared JPEG byte-identically without decoding it again", async () => {
    const file = new File(["prepared-bytes"], "prepared.jpg", { type: "image/jpeg" });
    const prepared = { file, mimeType: "image/jpeg", processingState: "prepared" as const };
    const decode = vi.fn();
    const encode = vi.fn();

    const result = await normalizeVisitPhoto(prepared, { decode, encode });

    expect(result).toBe(prepared);
    expect(result.file).toBe(file);
    expect(await result.file.text()).toBe("prepared-bytes");
    expect(decode).not.toHaveBeenCalled();
    expect(encode).not.toHaveBeenCalled();
  });
});
