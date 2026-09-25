import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { pruneAndroidCatalogueAssets } from "./prune-android-catalogue-assets.mjs";

it("ships the Android shell and small index without preloading all place content", async () => {
  const directory = await mkdtemp(join(tmpdir(), "parkdex-android-assets-"));
  try {
    await mkdir(join(directory, "places"));
    await mkdir(join(directory, "data"));
    for (const file of ["index.html", "places/place-placeholder.png", "places/park-photo.webp", "data/boundaries-index.v1.json", "data/boundaries.v1.geojson", "data/boundaries-display.v1.geojson"]) {
      await writeFile(join(directory, file), "fixture");
    }
    await pruneAndroidCatalogueAssets(directory);
    for (const file of ["index.html", "places/place-placeholder.png", "data/boundaries-index.v1.json"]) {
      expect(await readFile(join(directory, file), "utf8")).toBe("fixture");
    }
    for (const file of ["places/park-photo.webp", "data/boundaries.v1.geojson", "data/boundaries-display.v1.geojson"]) {
      await expect(readFile(join(directory, file))).rejects.toMatchObject({ code: "ENOENT" });
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
