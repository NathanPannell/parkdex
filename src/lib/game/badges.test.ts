import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PROVINCE_BY_REGION } from "../dex/regions";
import { BADGES, badgeArtUrl, drawablePatches, MAX_PATCHES, progressLabel, shelfBadges, togglePatch } from "./badges";

const root = new URL("../../../", import.meta.url);
const migration = readFileSync(new URL("database/migrations/game_004_badges.sql", root), "utf8");

/** The (id, metric, goal) rows of kip_game.badge_rules() in game_004_badges.sql. */
function sqlRules(): Array<{ id: string; metric: string; goal: number }> {
  const body = migration.slice(migration.indexOf("FUNCTION kip_game.badge_rules()"), migration.indexOf("FUNCTION kip_game.region_province"));
  return [...body.matchAll(/\('([a-z0-9-]+)', '([a-z_]+)', (\d+), \d+\)/g)].map((match) => ({ id: match[1], metric: match[2], goal: Number(match[3]) }));
}

/** The lower-cased region lists of kip_game.region_province(), by province. */
function sqlRegions(): Map<string, string> {
  const body = migration.slice(migration.indexOf("FUNCTION kip_game.region_province"), migration.indexOf("FUNCTION kip_game.badge_metrics"));
  const regions = new Map<string, string>();
  for (const match of body.matchAll(/IN \(([^)]*)\)\s*THEN '([^']+)'/g)) {
    for (const region of match[1].matchAll(/'([^']+)'/g)) regions.set(region[1], match[2]);
  }
  return regions;
}

describe("badge catalogue", () => {
  it("names every badge the server can unlock, in the same order", () => {
    expect(BADGES.map((badge) => badge.id)).toEqual(sqlRules().map((rule) => rule.id));
    expect(new Set(BADGES.map((badge) => badge.id)).size).toBe(BADGES.length);
  });

  it("keeps the region-to-province list in step with My Dex", () => {
    expect(new Map([...sqlRegions()].sort())).toEqual(new Map([...PROVINCE_BY_REGION].sort()));
  });

  it("bundles each badge's art, with its source recorded beside it", () => {
    const sources = JSON.parse(readFileSync(new URL("public/art/achievements/sources.json", root), "utf8")) as {
      badges: Record<string, { scene: string; parkId: string | null; sourceSha256: string; bundledSha256: string }>;
    };
    expect(Object.keys(sources.badges).sort()).toEqual(BADGES.map((badge) => badge.id).sort());
    for (const badge of BADGES) {
      const file = new URL(`public${badgeArtUrl(badge.id)}`, root);
      expect(existsSync(file), badge.id).toBe(true);
      const source = sources.badges[badge.id];
      expect(source.sourceSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(createHash("sha256").update(readFileSync(file)).digest("hex"), badge.id).toBe(source.bundledSha256);
      // Only coast-to-coast uses the generic coast scene; every other badge is one park's art.
      expect(source.parkId === null, badge.id).toBe(badge.id === "coast-to-coast");
    }
  });

  it("never lowers rarity as a family gets harder", () => {
    const order = ["common", "uncommon", "rare", "epic", "legendary"];
    const rules = new Map(sqlRules().map((rule) => [rule.id, rule]));
    for (const a of BADGES) {
      for (const b of BADGES) {
        const ra = rules.get(a.id)!;
        const rb = rules.get(b.id)!;
        if (ra.metric === rb.metric && ra.goal < rb.goal) expect(order.indexOf(a.rarity), `${a.id} <= ${b.id}`).toBeLessThanOrEqual(order.indexOf(b.rarity));
      }
    }
  });
});

describe("badge shelf", () => {
  it("shows every known badge with the server's progress, earned or locked", () => {
    const shelf = shelfBadges([
      { id: "parks-1", progress: 1, goal: 1, unlockedAt: "2026-10-01T00:00:00Z" },
      { id: "parks-10", progress: 4, goal: 10, unlockedAt: null },
      { id: "future-badge", progress: 1, goal: 1, unlockedAt: "2026-10-01T00:00:00Z" },
    ]);
    expect(shelf.map((badge) => badge.id)).toEqual(BADGES.map((badge) => badge.id));
    expect(shelf[0]).toMatchObject({ id: "parks-1", unlocked: true, unlockedAt: "2026-10-01T00:00:00Z", progress: 1, goal: 1 });
    expect(shelf[1]).toMatchObject({ id: "parks-10", unlocked: false, progress: 4, goal: 10 });
    expect(shelf.find((badge) => badge.id === "hold-30")).toMatchObject({ unlocked: false, progress: null, goal: null });
    expect(progressLabel(shelf[1])).toBe("4 of 10");
    expect(progressLabel(shelf[0])).toBeNull();
    expect(shelfBadges(undefined).every((badge) => !badge.unlocked)).toBe(true);
  });
});

describe("patch picking", () => {
  const unlocked = new Set(["parks-1", "hold-7", "crew-1", "founder"]);

  it("sews on unlocked badges, up to 3, and never pushes one off", () => {
    let patches: string[] = [];
    for (const id of ["parks-1", "hold-7", "crew-1"]) {
      const next = togglePatch(patches, id, unlocked);
      expect(next).toMatchObject({ changed: true, full: false });
      patches = next.patches;
    }
    expect(patches).toEqual(["parks-1", "hold-7", "crew-1"]);
    expect(togglePatch(patches, "founder", unlocked)).toEqual({ patches, changed: false, full: true });
    expect(MAX_PATCHES).toBe(3);
  });

  it("takes a patch off, and refuses locked badges", () => {
    expect(togglePatch(["parks-1", "hold-7"], "parks-1", unlocked)).toEqual({ patches: ["hold-7"], changed: true, full: false });
    expect(togglePatch(["parks-1"], "hold-30", unlocked)).toEqual({ patches: ["parks-1"], changed: false, full: false });
  });

  it("draws only known patches, once each, at most 3", () => {
    expect(drawablePatches(["parks-1", "nope", "parks-1", "hold-7", "crew-1", "founder"])).toEqual(["parks-1", "hold-7", "crew-1"]);
    expect(drawablePatches(undefined)).toEqual([]);
  });
});
