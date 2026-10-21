import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_BACKUP_PHOTO_BYTES } from "./accounts/photoBackupRendition";
import { largestCrop, PARK_COVER_ASPECT } from "./photoCrop";
import {
  base64Bytes,
  encodePhoto,
  fitWithin,
  jpegBase64,
  MAX_ORIGINAL_EDGE,
  MAX_PHOTO_BYTES,
  MAX_PHOTO_EDGE,
  ORIGINAL_QUALITY,
  originalFromBlob,
  PHOTO_QUALITY,
  prepareOriginal,
} from "./photoEncode";

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

describe("encoding applies the crop", () => {
  type Draw = unknown[];
  function installCanvas(bytes = 600_000) {
    const draws: Draw[] = [];
    const sizes: Array<[number, number]> = [];
    const qualities: number[] = [];
    vi.stubGlobal("document", {
      createElement: vi.fn(() => {
        const canvas = {
          width: 0,
          height: 0,
          getContext: () => ({ drawImage: (...args: unknown[]) => draws.push(args), translate: vi.fn(), scale: vi.fn() }),
          toDataURL: (_type: string, quality: number) => {
            sizes.push([canvas.width, canvas.height]);
            qualities.push(quality);
            return `data:image/jpeg;base64,${"A".repeat(Math.ceil((bytes * 4) / 3))}`;
          },
        };
        return canvas;
      }),
    });
    return { draws, sizes, qualities };
  }

  afterEach(() => vi.unstubAllGlobals());

  const source = {} as CanvasImageSource;

  it("draws only the crop, at its upload size", () => {
    const { draws, sizes } = installCanvas();
    const crop = { x: 0.5, y: 0.25, width: 0.28125, height: 0.5 };
    const photo = encodePhoto({ source, width: 2048, height: 1536 }, { crop });
    expect(draws).toEqual([[source, 1024, 384, 576, 768, 0, 0, 576, 768]]);
    expect(sizes).toEqual([[576, 768]]);
    expect([photo.width, photo.height]).toEqual([576, 768]);
  });

  it("scales a large crop down to 1,280 px on the long edge", () => {
    const { draws } = installCanvas();
    const crop = largestCrop(3024, 4032);
    const photo = encodePhoto({ source, width: 3024, height: 4032 }, { crop });
    expect(draws[0]).toEqual([source, 0, 0, 3024, 4032, 0, 0, 960, 1280]);
    expect([photo.width, photo.height]).toEqual([960, 1280]);
  });

  it("encodes a founder's 16:9 cover crop of an upright photo at 1,280 x 720", () => {
    const { draws } = installCanvas();
    const crop = largestCrop(1536, 2048, PARK_COVER_ASPECT);
    const photo = encodePhoto({ source, width: 1536, height: 2048 }, { crop, aspect: PARK_COVER_ASPECT });
    expect(draws[0]).toEqual([source, 0, 592, 1536, 864, 0, 0, 1280, 720]);
    expect([photo.width, photo.height]).toEqual([1280, 720]);
  });

  it("keeps the upload size limit for a 16:9 cover too", () => {
    installCanvas(MAX_PHOTO_BYTES + 1);
    expect(() => encodePhoto({ source, width: 2048, height: 1536 }, { crop: largestCrop(2048, 1536, PARK_COVER_ASPECT), aspect: PARK_COVER_ASPECT })).toThrow(
      /too large/,
    );
  });

  it("keeps the upload size limit: steps quality down, then refuses", () => {
    const { qualities } = installCanvas(MAX_PHOTO_BYTES + 1);
    expect(() => encodePhoto({ source, width: 2048, height: 1536 }, { crop: largestCrop(2048, 1536) })).toThrow(/too large/);
    expect(qualities).toEqual([PHOTO_QUALITY, 0.72, 0.6]);
  });

  it("keeps the original whole, at most 2,048 px, as a JPEG blob", () => {
    const { draws, sizes, qualities } = installCanvas(900_000);
    const { photo, drawable } = prepareOriginal({ source, width: 4032, height: 3024 });
    expect(draws[0]).toEqual([source, 0, 0, MAX_ORIGINAL_EDGE, 1536]);
    expect(sizes).toEqual([[MAX_ORIGINAL_EDGE, 1536]]);
    expect(qualities).toEqual([ORIGINAL_QUALITY]);
    expect(photo.blob.type).toBe("image/jpeg");
    expect(photo.blob.size).toBe(photo.bytes);
    expect([photo.width, photo.height, drawable.width, drawable.height]).toEqual([2048, 1536, 2048, 1536]);
  });

  it("keeps the original within the backup limit", () => {
    installCanvas(MAX_BACKUP_PHOTO_BYTES + 1);
    expect(() => prepareOriginal({ source, width: 4032, height: 3024 })).toThrow(/too large/);
  });
});

/** A camera JPEG's header: EXIF with `orientation`, then the frame stored at `width` x `height`. */
function cameraJpeg(orientation: number, width: number, height: number): Uint8Array<ArrayBuffer> {
  const tiff = [0x49, 0x49, 42, 0, 8, 0, 0, 0, 1, 0, 0x12, 0x01, 3, 0, 1, 0, 0, 0, orientation, 0, 0, 0, 0, 0, 0, 0];
  const exif = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff];
  const app1 = [0xff, 0xe1, (exif.length + 2) >> 8, (exif.length + 2) & 0xff, ...exif];
  const sof0 = [0xff, 0xc0, 0x00, 0x11, 8, height >> 8, height & 0xff, width >> 8, width & 0xff, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1];
  return new Uint8Array([0xff, 0xd8, ...app1, ...sof0, 0xff, 0xda, 0x00, 0x02]);
}

describe("a photo from the browser's camera capture", () => {
  afterEach(() => vi.unstubAllGlobals());

  function installDecoder(decoded: { width: number; height: number }) {
    const bitmapOptions: unknown[] = [];
    const transforms: unknown[] = [];
    const sizes: Array<[number, number]> = [];
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(async (_blob: Blob, options: unknown) => {
        bitmapOptions.push(options);
        return { ...decoded, close: vi.fn() };
      }),
    );
    vi.stubGlobal("document", {
      createElement: vi.fn(() => {
        const canvas = {
          width: 0,
          height: 0,
          getContext: () => ({ drawImage: vi.fn(), translate: vi.fn(), scale: vi.fn(), setTransform: (...args: unknown[]) => transforms.push(args) }),
          toDataURL: () => {
            sizes.push([canvas.width, canvas.height]);
            return `data:image/jpeg;base64,${"A".repeat(800)}`;
          },
        };
        return canvas;
      }),
    });
    return { bitmapOptions, transforms, sizes };
  }

  // A portrait phone photo: stored 4032 x 3024 on its side, EXIF orientation 6 (turn right).
  const portrait = () => new File([cameraJpeg(6, 4032, 3024)], "IMG_0001.jpg", { type: "image/jpeg" });

  it("asks the decoder to honour EXIF orientation and keeps the original at 2,048 px", async () => {
    const { bitmapOptions, transforms, sizes } = installDecoder({ width: 3024, height: 4032 });
    const { photo } = await originalFromBlob(portrait());
    expect(bitmapOptions).toEqual([{ imageOrientation: "from-image" }]);
    expect(transforms).toEqual([]);
    expect(sizes).toEqual([[1536, MAX_ORIGINAL_EDGE]]);
    expect([photo.width, photo.height]).toEqual([1536, 2048]);
  });

  it("turns it upright itself when the decoder ignored the orientation", async () => {
    const { transforms, sizes } = installDecoder({ width: 4032, height: 3024 });
    const { photo } = await originalFromBlob(portrait());
    expect(transforms).toHaveLength(1);
    // The upright canvas, then the original drawn from it.
    expect(sizes).toEqual([[1536, MAX_ORIGINAL_EDGE]]);
    expect([photo.width, photo.height]).toEqual([1536, 2048]);
  });
});
