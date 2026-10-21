/**
 * My Dex choices kept per device (#174): the "Only my visits" switch, which regions are
 * collapsed and which segment was open. Storage can be unavailable (private modes); the
 * defaults then apply for the session.
 */

const ONLY_MINE_KEY = "parkdex-dex-only-mine";
const COLLAPSED_KEY = "parkdex-dex-collapsed";

type StorageLike = Pick<Storage, "getItem" | "setItem">;

function storage(): StorageLike | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** The player's own choice on this device, or null when they never touched the switch. */
export function storedOnlyMine(store: StorageLike | null = storage()): boolean | null {
  try {
    const value = store?.getItem(ONLY_MINE_KEY);
    return value === "true" ? true : value === "false" ? false : null;
  } catch {
    return null;
  }
}

/**
 * Whether My Dex shows only visited parks. Until the player chooses, it follows their progress:
 * the whole catalogue while they have no visits (an empty page teaches nothing), their own parks after.
 */
export function readOnlyMine(store: StorageLike | null = storage(), hasVisits = true): boolean {
  return storedOnlyMine(store) ?? hasVisits;
}

export function writeOnlyMine(value: boolean, store: StorageLike | null = storage()): void {
  try {
    store?.setItem(ONLY_MINE_KEY, value ? "true" : "false");
  } catch {
    /* The choice lasts for this session only. */
  }
}

export function readCollapsed(store: StorageLike | null = storage()): Set<string> {
  try {
    const value: unknown = JSON.parse(store?.getItem(COLLAPSED_KEY) ?? "[]");
    return new Set(Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").slice(0, 500) : []);
  } catch {
    return new Set();
  }
}

export function writeCollapsed(value: ReadonlySet<string>, store: StorageLike | null = storage()): void {
  try {
    store?.setItem(COLLAPSED_KEY, JSON.stringify([...value].slice(0, 500)));
  } catch {
    /* The choice lasts for this session only. */
  }
}

export type DexSegment = "collection" | "flags";

// Which segment My Dex opens on. Not stored: the app starts on Collection.
let nextSegment: DexSegment = "collection";

/** Open My Dex on this segment next time, such as "Your flags" after planting a flag. */
export function openDexOn(segment: DexSegment): void {
  nextSegment = segment;
}

/** The segment My Dex opens on. My Dex resets it to Collection once it has opened. */
export function dexStartSegment(): DexSegment {
  return nextSegment;
}
