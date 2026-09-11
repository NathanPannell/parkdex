import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { getPlaceImage, PLACE_IMAGE_COUNT, PLACE_IMAGES } from "./place-images";

const assetDirectory = fileURLToPath(new URL("../public", import.meta.url));
const places = JSON.parse(readFileSync(resolve(process.cwd(), "../data/places.json"), "utf8")) as Array<{ id: string }>;
const THUMBNAIL_BUDGET = 64_000;
const DETAIL_BUDGET = 425_000;

describe("place image manifest", () => {
  it("only references tracked places and distinct local assets", () => {
    const knownIds = new Set(places.map((place) => place.id));
    const imagePaths = Object.values(PLACE_IMAGES).flatMap((image) => [image.thumbnail.src, image.detail.src]);

    expect(PLACE_IMAGE_COUNT).toBe(18);
    expect(new Set(imagePaths).size).toBe(imagePaths.length);
    for (const [placeId, image] of Object.entries(PLACE_IMAGES)) {
      expect(knownIds.has(placeId), `unknown place ID: ${placeId}`).toBe(true);
      expect(image.thumbnail.src, placeId).toMatch(/^\/places\/[a-z0-9-]+-thumb\.webp$/);
      expect(image.detail.src, placeId).toMatch(/^\/places\/[a-z0-9-]+\.webp$/);
      expect(image.thumbnail.width, placeId).toBeLessThanOrEqual(320);
      expect(image.detail.width, placeId).toBeLessThanOrEqual(960);
    }
  });

  it("ships every asset within its documented size budget", () => {
    for (const image of Object.values(PLACE_IMAGES)) {
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
    for (const [placeId, image] of Object.entries(PLACE_IMAGES)) {
      expect(image.alt.length, placeId).toBeGreaterThan(20);
      expect(image.creator.trim(), placeId).not.toBe("");
      expect(image.sourceTitle.trim(), placeId).not.toBe("");
      expect(image.locationEvidence.length, placeId).toBeGreaterThan(30);
      expect(image.locationEvidenceUrl, placeId).toMatch(/^https:\/\/(?:bcparks\.ca|commons\.wikimedia\.org)\//);
      expect(image.changes.length, placeId).toBeGreaterThan(20);
      expect(image.sourceUrl, placeId).toMatch(/^https:\/\/commons\.wikimedia\.org\/wiki\/File:/);
      expect(image.originalUrl, placeId).toMatch(/^https:\/\/upload\.wikimedia\.org\/wikipedia\/commons\//);
      expect(image.license, placeId).toMatch(/^(CC BY(?:-SA)? [234]\.0|Public domain)$/);
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
});
