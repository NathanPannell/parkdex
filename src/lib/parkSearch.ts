import type { Park } from "./parks";

// Accents and punctuation are ignored, so "saint" style typing finds "St." names loosely.
export function normalizeQuery(text: string): string {
  return text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function score(park: Park, words: string[]): number | null {
  const name = normalizeQuery(`${park.short} ${park.name}`);
  const region = normalizeQuery(park.region);
  let total = 0;
  for (const word of words) {
    if (name.startsWith(word) || name.includes(` ${word}`)) total += 0;
    else if (name.includes(word)) total += 1;
    else if (region.includes(word)) total += 2;
    else return null;
  }
  return total;
}

/** Every park matching all typed words, best matches first and nearer parks first within a tier. */
export function searchParks<T extends { park: Park; km: number }>(items: readonly T[], query: string): T[] {
  const words = normalizeQuery(query).split(" ").filter(Boolean);
  if (!words.length) return [];
  return items
    .map((item) => ({ item, rank: score(item.park, words) }))
    .filter((entry): entry is { item: T; rank: number } => entry.rank !== null)
    .sort((a, b) => a.rank - b.rank || a.item.km - b.item.km)
    .map((entry) => entry.item);
}
