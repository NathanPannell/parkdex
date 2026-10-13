import { fetchAuthenticated } from "../accounts/authClient";
import type { ServerDexPark } from "./collection";

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const REQUEST_TIMEOUT_MS = 10_000;

function instant(value: unknown): string | null {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;
}

/** `GET /api/game/dex`, keeping only well-formed rows. */
export function parseDex(body: unknown): ServerDexPark[] {
  const parks = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>).parks : null;
  if (!Array.isArray(parks)) throw new Error("Parkdex sent a Dex this version cannot read.");
  return parks.flatMap((item): ServerDexPark[] => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const row = item as Record<string, unknown>;
    const firstVisitAt = instant(row.firstVisitAt);
    const lastVisitAt = instant(row.lastVisitAt);
    if (typeof row.parkId !== "string" || !row.parkId || !firstVisitAt || !lastVisitAt) return [];
    const days = Array.isArray(row.days) ? row.days.filter((day): day is string => typeof day === "string" && DAY.test(day)) : [];
    return [{ parkId: row.parkId, days, firstVisitAt, lastVisitAt, hidden: row.hidden === true }];
  });
}

/** The parks this account visited, from the server. Throws when offline or unavailable. */
export async function fetchDex(accountId: string): Promise<ServerDexPark[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetchAuthenticated("/api/game/dex", { signal: controller.signal }, accountId);
    if (!response.ok) throw new Error(`My Dex is unavailable (${response.status}).`);
    return parseDex(await response.json());
  } finally {
    clearTimeout(timeout);
  }
}
