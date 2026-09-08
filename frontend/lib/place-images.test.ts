import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { getPlaceImage, PLACE_IMAGE_COUNT, PLACE_IMAGES } from "./place-images";

const assetDirectory = fileURLToPath(new URL("../public", import.meta.url));
const places = JSON.parse(readFileSync(resolve(process.cwd(), "../data/places.json"), "utf8")) as Array<{ id: string }>;

describe("place image manifest", () => {
  it("only references tracked places and distinct local assets", () => {
    const knownIds = new Set(places.map((place) => place.id));
    const imagePaths = Object.values(PLACE_IMAGES).map((image) => image.src);

    expect(PLACE_IMAGE_COUNT).toBe(17);
    expect(new Set(imagePaths).size).toBe(imagePaths.length);
    for (const [placeId, image] of Object.entries(PLACE_IMAGES)) {
      expect(knownIds.has(placeId), placeId).toBe(true);
      expect(image.src.startsWith("/places/")).toBe(true);
      expect(image.alt.length).toBeGreaterThan(20);
    }
  });

  it("ships compact assets with traceable, reusable licenses", () => {
    for (const image of Object.values(PLACE_IMAGES)) {
      const localPath = `${assetDirectory}${image.src.replaceAll("/", "\\")}`;
      expect(existsSync(localPath), image.src).toBe(true);
      expect(statSync(localPath).size, image.src).toBeLessThan(500_000);
      expect(image.sourceUrl).toMatch(/^https:\/\/commons\.wikimedia\.org\/wiki\/File:/);
      expect(image.originalUrl).toMatch(/^https:\/\/upload\.wikimedia\.org\/wikipedia\/commons\//);
      expect(image.licenseUrl).toMatch(/^https:\/\/creativecommons\.org\//);
    }
  });

  it("uses a verified Artlish image and leaves unverified remote parks empty", () => {
    expect(getPlaceImage("provincial-artlish-caves-park")?.sourceTitle).toBe("Artlish River Cave");
    expect(getPlaceImage("provincial-gold-muchalat-park")).toBeUndefined();
    expect(getPlaceImage("provincial-lower-nimpkish-park")).toBeUndefined();
    expect(getPlaceImage("provincial-white-river-park")).toBeUndefined();
    expect(getPlaceImage("provincial-woss-lake-park")).toBeUndefined();
  });
});
