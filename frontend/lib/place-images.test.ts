import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { getPlaceImage, getPlaceImages, PLACE_IMAGE_COUNT, PLACE_IMAGE_GALLERY, PLACE_IMAGE_RECORD_COUNT, PLACE_IMAGES } from "./place-images";

const assetDirectory = fileURLToPath(new URL("../public", import.meta.url));
const places = JSON.parse(readFileSync(resolve(process.cwd(), "../data/places.json"), "utf8")) as Array<{ id: string }>;
const majorIslandSource = readFileSync(resolve(process.cwd(), "../scripts/bc-major-islands.mjs"), "utf8");
const curatedIslandIds = [...majorIslandSource.matchAll(/name:\s*'([^']+)'/g)].map(([, name]) =>
  `island-${name.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`,
);
const THUMBNAIL_BUDGET = 64_000;
const DETAIL_BUDGET = 425_000;
const imageEntries = [
  ...Object.entries(PLACE_IMAGES),
  ...Object.entries(PLACE_IMAGE_GALLERY).flatMap(([placeId, images]) =>
    images.map((image) => [placeId, image] as const),
  ),
];

describe("place image manifest", () => {
  it("only references tracked places and distinct local assets", () => {
    const knownIds = new Set([...places.map((place) => place.id), ...curatedIslandIds]);
    const imagePaths = imageEntries.flatMap(([, image]) => [image.thumbnail.src, image.detail.src]);

    expect(PLACE_IMAGE_COUNT).toBe(221);
    expect(PLACE_IMAGE_RECORD_COUNT).toBe(236);
    expect(new Set(imagePaths).size).toBe(imagePaths.length);
    for (const [placeId, image] of imageEntries) {
      expect(knownIds.has(placeId), `unknown place ID: ${placeId}`).toBe(true);
      expect(PLACE_IMAGES[placeId], `alternate without primary: ${placeId}`).toBeDefined();
      expect(image.thumbnail.src, placeId).toMatch(/^\/places\/[a-z0-9-]+-thumb\.webp$/);
      expect(image.detail.src, placeId).toMatch(/^\/places\/[a-z0-9-]+\.webp$/);
      expect(image.thumbnail.width, placeId).toBeLessThanOrEqual(320);
      expect(image.detail.width, placeId).toBeLessThanOrEqual(960);
    }
  });

  it("ships every asset within its documented size budget", () => {
    for (const [, image] of imageEntries) {
      for (const [variant, asset, budget] of [
        ["thumbnail", image.thumbnail, THUMBNAIL_BUDGET],
        ["detail", image.detail, DETAIL_BUDGET],
      ] as const) {
        const localPath = resolve(assetDirectory, `.${asset.src}`);
        expect(existsSync(localPath), `missing ${variant}: ${asset.src}`).toBe(true);
        expect(statSync(localPath).size, `oversized ${variant}: ${asset.src}`).toBeLessThanOrEqual(budget);
      }
    }
  });

  it("requires complete, reusable source provenance", () => {
    for (const [placeId, image] of imageEntries) {
      expect(image.alt.length, placeId).toBeGreaterThan(20);
      expect(image.creator.trim(), placeId).not.toBe("");
      expect(image.sourceTitle.trim(), placeId).not.toBe("");
      expect(image.locationEvidence.length, placeId).toBeGreaterThan(30);
      expect(image.locationEvidenceUrl, placeId).toMatch(/^https:\/\/(?:bcparks\.ca|commons\.wikimedia\.org|www\.crd\.ca|(?:www\.)?cvrd\.ca|rdn\.bc\.ca|www\.flickr\.com)\//);
      expect(image.changes.length, placeId).toBeGreaterThan(20);
      expect(image.sourceUrl, placeId).toMatch(/^https:\/\/(?:commons\.wikimedia\.org\/wiki\/File:|www\.flickr\.com\/photos\/)/);
      expect(image.originalUrl, placeId).toMatch(/^https:\/\/(?:upload\.wikimedia\.org\/wikipedia\/commons\/|live\.staticflickr\.com\/)/);
      expect(image.license, placeId).toMatch(/^(CC BY(?:-SA)? [234]\.0|CC0 1\.0|Public domain)$/);
      expect(image.licenseUrl, placeId).toMatch(/^https:\/\/creativecommons\.org\//);
    }
  });

  it("keeps reviewed photo-search gaps unavailable", () => {
    expect(getPlaceImage("provincial-gold-muchalat-park")).toBeUndefined();
    expect(getPlaceImage("provincial-lower-nimpkish-park")).toBeUndefined();
    expect(getPlaceImage("provincial-white-river-park")).toBeUndefined();
    expect(getPlaceImage("provincial-woss-lake-park")).toBeUndefined();
    expect(getPlaceImage("regional-kwaksistah-regional-park")).toBeUndefined();
    expect(getPlaceImage("regional-mount-cain-alpine-park")).toBeUndefined();
  });

  it("keeps the primary image first and exposes approved alternates only through galleries", () => {
    const primary = getPlaceImage("provincial-bear-creek-park");
    const gallery = getPlaceImages("provincial-bear-creek-park");

    expect(primary).toBeDefined();
    expect(gallery).toHaveLength(2);
    expect(gallery[0]).toBe(primary);
    expect(gallery[1]).toBe(PLACE_IMAGE_GALLERY["provincial-bear-creek-park"]?.[0]);
    expect(getPlaceImages("provincial-woss-lake-park")).toEqual([]);
  });
});
