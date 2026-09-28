import { createHash, webcrypto } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Park } from "../parks";
import { createPhotoBackupRendition, MAX_BACKUP_PHOTO_BYTES, MAX_PHOTO_CONVERSION_INPUT_BYTES, sceneSvg } from "./photoBackupRendition";

// Frozen fields from the saved 1,740-byte Thetis desktop demo photo fixture.
const THETIS: Park = {
  id: "regional-thetis-lake-regional-park", name: "Thetis Lake Regional Park", short: "Thetis Lake",
  category: "regional", region: "Capital Region", lat: 48.48123, lng: -123.4774,
  biome: "lake", shape: "hex", rarity: "common", seed: 331,
  blurb: "Two lakes, cliff-jump rumours and a forest loop that ends in a swim. Summer's favourite badge.",
  scene: "lake-a",
};
const THETIS_SHA256 = "3afacd5977a531aa126b3fd873887378f003164123c3d5035c3a3ca1d56f2145";
const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0xff, 0xd9]);

function installImageBrowser(options: {
  width?: number;
  height?: number;
  decodeFails?: boolean;
  jpeg?: Blob | null;
} = {}) {
  const createUrl = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:photo-test");
  const revokeUrl = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  let imageCreations = 0;
  class FakeImage {
    naturalWidth = options.width ?? 600;
    naturalHeight = options.height ?? 800;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor() { imageCreations += 1; }
    set src(_value: string) {
      queueMicrotask(() => options.decodeFails ? this.onerror?.() : this.onload?.());
    }
  }
  vi.stubGlobal("Image", FakeImage);
  const fills: string[] = [];
  const encodedSizes: Array<[number, number]> = [];
  const toBlob = vi.fn(function (this: { width: number; height: number }, callback: (blob: Blob | null) => void, _type: string, _quality: number) {
    encodedSizes.push([this.width, this.height]);
    callback(options.jpeg === undefined ? new Blob([JPEG_BYTES], { type: "image/jpeg" }) : options.jpeg);
  });
  vi.stubGlobal("document", {
    createElement: vi.fn(() => ({
      width: 0, height: 0,
      getContext: () => ({
        set fillStyle(value: string) { fills.push(value); },
        fillRect: vi.fn(), drawImage: vi.fn(),
      }),
      toBlob,
    })),
  });
  vi.stubGlobal("crypto", webcrypto);
  return { createUrl, revokeUrl, toBlob, encodedSizes, fills, imageCreations: () => imageCreations };
}

function oversizedWebpVp8l(height: number) {
  const bytes = new Uint8Array(MAX_BACKUP_PHOTO_BYTES + 1);
  bytes.set(new TextEncoder().encode("RIFF"), 0);
  bytes.set(new TextEncoder().encode("WEBPVP8L"), 8);
  bytes[20] = 0x2f;
  const heightBits = height - 1;
  bytes[22] = (heightBits & 0x03) << 6;
  bytes[23] = (heightBits >>> 2) & 0xff;
  bytes[24] = (heightBits >>> 10) & 0x0f;
  return new Blob([bytes], { type: "image/webp" });
}

function oversizedJpeg(width: number, height: number) {
  const bytes = new Uint8Array(MAX_BACKUP_PHOTO_BYTES + 1);
  bytes.set([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08,
    (height >>> 8) & 0xff, height & 0xff, (width >>> 8) & 0xff, width & 0xff], 0);
  return new Blob([bytes], { type: "image/jpeg" });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("photo backup rendition", () => {
  it("converts the exact saved Thetis SVG to a separate JPEG without changing its original bytes", async () => {
    const original = new Blob([sceneSvg(THETIS)], { type: "image/svg+xml" });
    const before = Buffer.from(await original.arrayBuffer());
    expect(original.size).toBe(1_740);
    expect(createHash("sha256").update(before).digest("hex")).toBe(THETIS_SHA256);
    const browser = installImageBrowser();

    const converted = await createPhotoBackupRendition(original, THETIS);

    expect(converted).toMatchObject({ contentType: "image/jpeg", sizeBytes: JPEG_BYTES.length });
    expect(converted?.blob).not.toBe(original);
    expect(new Uint8Array(await converted!.blob.arrayBuffer())).toEqual(JPEG_BYTES);
    expect(converted?.sha256).toBe(createHash("sha256").update(JPEG_BYTES).digest("hex"));
    expect(Buffer.from(await original.arrayBuffer())).toEqual(before);
    expect(browser.createUrl).toHaveBeenCalledTimes(1);
    expect(browser.revokeUrl).toHaveBeenCalledWith("blob:photo-test");
    expect(browser.fills[0]).toBe("#fff");
  });

  it("rejects altered or active SVG bytes before creating an image decoder", async () => {
    const browser = installImageBrowser();
    const valid = sceneSvg(THETIS);
    for (const text of [valid.replace("#FFD08A", "#FFD08B"), `${valid}<script>alert(1)</script>`]) {
      expect(await createPhotoBackupRendition(new Blob([text], { type: "image/svg+xml" }), THETIS)).toBeNull();
    }
    expect(await createPhotoBackupRendition(new Blob([valid], { type: "image/svg+xml" }), null)).toBeNull();
    expect(browser.imageCreations()).toBe(0);
    expect(browser.createUrl).not.toHaveBeenCalled();
  });

  it("rejects excessive input bytes and the packed VP8L height beyond the dimension limit before decode", async () => {
    const browser = installImageBrowser();
    expect(await createPhotoBackupRendition(
      new Blob([new Uint8Array(MAX_PHOTO_CONVERSION_INPUT_BYTES + 1)], { type: "image/webp" }), THETIS,
    )).toBeNull();
    expect(await createPhotoBackupRendition(oversizedWebpVp8l(8_193), THETIS)).toBeNull();
    expect(browser.imageCreations()).toBe(0);
    expect(browser.createUrl).not.toHaveBeenCalled();
  });

  it("checks decoded dimensions and handles failed decode or invalid JPEG output", async () => {
    const original = oversizedWebpVp8l(2_049);
    const mismatch = installImageBrowser({ width: 1, height: 2_048 });
    expect(await createPhotoBackupRendition(original, THETIS)).toBeNull();
    expect(mismatch.revokeUrl).toHaveBeenCalledTimes(1);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();

    const failedDecode = installImageBrowser({ width: 1, height: 2_049, decodeFails: true });
    expect(await createPhotoBackupRendition(original, THETIS)).toBeNull();
    expect(failedDecode.revokeUrl).toHaveBeenCalledTimes(1);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();

    const invalidOutput = installImageBrowser({ width: 1, height: 2_049, jpeg: new Blob(["not jpeg"], { type: "image/jpeg" }) });
    expect(await createPhotoBackupRendition(original, THETIS)).toBeNull();
    expect(invalidOutput.toBlob).toHaveBeenCalledWith(expect.any(Function), "image/jpeg", expect.any(Number));
    vi.restoreAllMocks();
    vi.unstubAllGlobals();

    const wrongType = installImageBrowser({ width: 1, height: 2_049, jpeg: new Blob([JPEG_BYTES], { type: "image/png" }) });
    expect(await createPhotoBackupRendition(original, THETIS)).toBeNull();
    expect(wrongType.toBlob).toHaveBeenCalledTimes(5);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();

    const oversizedJpeg = new Uint8Array(MAX_BACKUP_PHOTO_BYTES + 1);
    oversizedJpeg.set(JPEG_BYTES);
    const tooLarge = installImageBrowser({ width: 1, height: 2_049, jpeg: new Blob([oversizedJpeg], { type: "image/jpeg" }) });
    expect(await createPhotoBackupRendition(original, THETIS)).toBeNull();
    expect(tooLarge.toBlob).toHaveBeenCalledTimes(5);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();

    const accepted = installImageBrowser({ width: 1, height: 2_049 });
    expect(await createPhotoBackupRendition(original, THETIS)).toMatchObject({ contentType: "image/jpeg", sizeBytes: JPEG_BYTES.length });
    expect(accepted.toBlob).toHaveBeenCalledTimes(1);
  });

  it("accepts an exact EXIF width and height swap and encodes from decoded dimensions", async () => {
    const original = oversizedJpeg(2_049, 1_000);
    const browser = installImageBrowser({ width: 1_000, height: 2_049 });

    expect(await createPhotoBackupRendition(original, THETIS)).toMatchObject({ contentType: "image/jpeg" });
    expect(browser.encodedSizes).toEqual([[999, 2_048]]);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();

    const unrelated = installImageBrowser({ width: 1_000, height: 2_048 });
    expect(await createPhotoBackupRendition(original, THETIS)).toBeNull();
    expect(unrelated.toBlob).not.toHaveBeenCalled();
  });
});
