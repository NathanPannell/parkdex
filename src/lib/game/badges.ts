import type { Rarity, Shape } from "../parks";

/**
 * Badges (#175): decorative achievements made from park art, earned by play and worn as patches
 * on the player's flag. They never add points. The server decides what is unlocked
 * (database/migrations/game_004_badges.sql, `kip_game.badge_rules()`); this list gives each badge
 * its name, its hint, its frame and its art. To add a badge, add its rule there and its entry here,
 * with its art at `public/art/achievements/<id>.webp` and a line in `sources.json` beside it.
 */

export type BadgeDefinition = {
  id: string;
  name: string;
  /** How to earn it, shown under a locked badge. */
  hint: string;
  rarity: Rarity;
  shape: Shape;
};

export const BADGES: readonly BadgeDefinition[] = [
  { id: "parks-1", name: "Over the Bridge", hint: "Visit your first park", rarity: "common", shape: "circle" },
  { id: "parks-10", name: "Swimming Upstream", hint: "Visit 10 parks", rarity: "uncommon", shape: "circle" },
  { id: "parks-25", name: "Trestle Walker", hint: "Visit 25 parks", rarity: "uncommon", shape: "circle" },
  { id: "parks-50", name: "Edge of the Map", hint: "Visit 50 parks", rarity: "rare", shape: "circle" },
  { id: "parks-100", name: "Old Growth", hint: "Visit 100 parks", rarity: "legendary", shape: "circle" },
  { id: "regular-3", name: "Creature of Habit", hint: "Visit the same park on 3 days", rarity: "common", shape: "arch" },
  { id: "regular-10", name: "Part of the Scenery", hint: "Visit the same park on 10 days", rarity: "uncommon", shape: "arch" },
  { id: "regular-25", name: "Arbutus Roots", hint: "Visit the same park on 25 days", rarity: "rare", shape: "arch" },
  { id: "planter-5", name: "Seed Planter", hint: "Plant flags in 5 empty parks", rarity: "uncommon", shape: "shield" },
  { id: "taker-5", name: "Sea Lion's Share", hint: "Take 5 flags", rarity: "uncommon", shape: "shield" },
  { id: "taker-25", name: "Eight Arms", hint: "Take 25 flags", rarity: "rare", shape: "shield" },
  { id: "hold-7", name: "King of the Hill", hint: "Hold one flag for 7 days", rarity: "uncommon", shape: "hex" },
  { id: "hold-30", name: "Lighthouse Keeper", hint: "Hold one flag for 30 days", rarity: "legendary", shape: "hex" },
  { id: "crew-1", name: "Shore Party", hint: "Hold a flag with a crew", rarity: "common", shape: "seal" },
  { id: "crew-10", name: "Beach Crew", hint: "Hold flags with 10 crews", rarity: "rare", shape: "seal" },
  { id: "biomes-5", name: "Falls Chaser", hint: "Visit 5 kinds of landscape", rarity: "uncommon", shape: "hex" },
  { id: "regions-3", name: "Plateau Pathfinder", hint: "Visit parks in 3 regions", rarity: "uncommon", shape: "hex" },
  { id: "founder", name: "Spelunker", hint: "Found a park", rarity: "rare", shape: "shield" },
  { id: "coast-to-coast", name: "Coast to Coast", hint: "Visit a park in BC and one in Nova Scotia", rarity: "legendary", shape: "seal" },
];

export const MAX_PATCHES = 3;

const BY_ID = new Map(BADGES.map((badge) => [badge.id, badge]));

export function badgeById(id: string): BadgeDefinition | null {
  return BY_ID.get(id) ?? null;
}

/** The bundled art of a badge. Bundled, so it works offline and in every environment. */
export function badgeArtUrl(id: string): string {
  return `/art/achievements/${id}.webp`;
}

/** One badge as the server reports it: progress toward the goal, and when it unlocked. */
export type BadgeStatus = { id: string; progress: number; goal: number; unlockedAt: string | null };

export type ShelfBadge = BadgeDefinition & {
  unlocked: boolean;
  unlockedAt: string | null;
  /** Null when the server did not report progress for this badge. */
  progress: number | null;
  goal: number | null;
};

/**
 * The shelf: every badge this build knows, in order, with the server's progress. Badges the server
 * knows and this build does not are left out until an update brings their art.
 */
export function shelfBadges(statuses: readonly BadgeStatus[] | null | undefined): ShelfBadge[] {
  const byId = new Map((statuses ?? []).map((status) => [status.id, status]));
  return BADGES.map((badge) => {
    const status = byId.get(badge.id);
    return {
      ...badge,
      unlocked: !!status?.unlockedAt,
      unlockedAt: status?.unlockedAt ?? null,
      progress: status ? Math.min(status.progress, status.goal) : null,
      goal: status?.goal ?? null,
    };
  });
}

/** Patches this build can draw, in the order they were sewn on: known IDs only, at most 3. */
export function drawablePatches(patches: readonly string[] | null | undefined): string[] {
  return [...new Set(patches ?? [])].filter((id) => BY_ID.has(id)).slice(0, MAX_PATCHES);
}

export type PatchToggle = { patches: string[]; changed: boolean; full: boolean };

/**
 * Sews a badge on, or takes it off. Only unlocked badges can be sewn on, and only 3 at once: a
 * fourth is refused with `full` rather than pushing one off, so the player chooses what goes.
 */
export function togglePatch(current: readonly string[], id: string, unlocked: ReadonlySet<string>): PatchToggle {
  const patches = [...new Set(current)];
  if (patches.includes(id)) return { patches: patches.filter((patch) => patch !== id), changed: true, full: false };
  if (!unlocked.has(id)) return { patches, changed: false, full: false };
  if (patches.length >= MAX_PATCHES) return { patches, changed: false, full: true };
  return { patches: [...patches, id], changed: true, full: false };
}

/** "4 of 10", or null for a badge without progress to show. */
export function progressLabel(badge: Pick<ShelfBadge, "unlocked" | "progress" | "goal">): string | null {
  if (badge.unlocked || badge.progress === null || badge.goal === null || badge.goal <= 1) return null;
  return `${badge.progress} of ${badge.goal}`;
}

const SEEN_KEY = "parkdex-badges-seen-v1";

function storage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

/** Badges this device has already celebrated, per account, so a "New" mark shows once. */
export function readSeenBadges(accountId: string): Set<string> {
  try {
    const parsed: unknown = JSON.parse(storage()?.getItem(SEEN_KEY) ?? "null");
    const list = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>)[accountId] : null;
    return new Set(Array.isArray(list) ? list.filter((id): id is string => typeof id === "string") : []);
  } catch {
    return new Set();
  }
}

export function markBadgesSeen(accountId: string, ids: Iterable<string>): void {
  try {
    const parsed: unknown = JSON.parse(storage()?.getItem(SEEN_KEY) ?? "null");
    const all = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
    const next = new Set([...readSeenBadges(accountId), ...ids]);
    storage()?.setItem(SEEN_KEY, JSON.stringify({ ...all, [accountId]: [...next] }));
  } catch {
    // Without storage the mark shows again next time; nothing else depends on it.
  }
}
