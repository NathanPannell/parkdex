import type { LngLat } from "./geo";
import { activeAppConfig } from "./appConfig";
import { feedbackApiOrigin } from "./feedbackReport";
import { requestContextHeaders } from "./requestContext";

export type OsmRef = { type: "way" | "relation"; id: number };

/** A park the player wants added: a pin, a name, and an OpenStreetMap pick or a rough outline. */
export type ParkProposal = {
  submissionId: string;
  name: string;
  note: string;
  point: LngLat;
  outline: LngLat[] | null;
  osm?: OsmRef | null;
};

/** What the server decided straight away. Older servers send no review, which means pending. */
export type ProposalReview = { decision: "approved"; parkId: string; parkName: string } | { decision: "pending" };

/** A park outline from OpenStreetMap near the pin, as `GET /api/osm/parks` returns it. */
export type OsmParkCandidate = OsmRef & {
  name: string | null;
  kind: string;
  areaM2: number;
  containsPin: boolean;
  distanceM: number;
  geometry: { type: "MultiPolygon"; coordinates: LngLat[][][] };
};

export const MAX_OUTLINE_POINTS = 200;

/** Thin a traced outline to the server's limit while keeping its shape. */
export function simplifyOutline(points: LngLat[], max = MAX_OUTLINE_POINTS): LngLat[] {
  if (points.length <= max) return points;
  const step = points.length / max;
  return Array.from({ length: max }, (_, index) => points[Math.floor(index * step)]);
}

function proposalApiOrigin(): string {
  try {
    return feedbackApiOrigin();
  } catch {
    throw new Error("Park proposals are unavailable in this app build.");
  }
}

function parseCandidate(value: unknown): OsmParkCandidate | null {
  const item = value as Partial<OsmParkCandidate> | null;
  if (!item || (item.type !== "way" && item.type !== "relation") || typeof item.id !== "number" || !Number.isSafeInteger(item.id)) return null;
  const geometry = item.geometry;
  if (!geometry || geometry.type !== "MultiPolygon" || !Array.isArray(geometry.coordinates) || !geometry.coordinates.length) return null;
  return {
    type: item.type,
    id: item.id,
    name: typeof item.name === "string" && item.name.trim() ? item.name.trim() : null,
    kind: typeof item.kind === "string" ? item.kind : "",
    areaM2: typeof item.areaM2 === "number" && Number.isFinite(item.areaM2) ? item.areaM2 : 0,
    containsPin: item.containsPin === true,
    distanceM: typeof item.distanceM === "number" && Number.isFinite(item.distanceM) ? item.distanceM : 0,
    geometry,
  };
}

/** Park outlines from OpenStreetMap around the pin, nearest first. */
export async function searchOsmParks(point: LngLat, signal?: AbortSignal, fetcher: typeof fetch = globalThis.fetch): Promise<OsmParkCandidate[]> {
  const origin = proposalApiOrigin();
  const query = new URLSearchParams({ lat: point[1].toFixed(6), lng: point[0].toFixed(6) });
  let response: Response;
  try {
    response = await fetcher(`${origin}/api/osm/parks?${query}`, { credentials: "omit", cache: "no-store", redirect: "error", signal });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new Error("Couldn't reach OpenStreetMap. Check your connection.");
  }
  if (response.status === 429) throw new Error("Too many map searches. Wait a few minutes.");
  if (!response.ok) throw new Error("OpenStreetMap is busy right now.");
  const body = await response.json().catch(() => null) as { parks?: unknown } | null;
  return Array.isArray(body?.parks) ? body.parks.map(parseCandidate).filter((item): item is OsmParkCandidate => item !== null) : [];
}

function parseReview(body: unknown): ProposalReview {
  const review = (body as { review?: Partial<{ decision: unknown; parkId: unknown; parkName: unknown }> } | null)?.review;
  if (review?.decision === "approved" && typeof review.parkId === "string" && typeof review.parkName === "string") {
    return { decision: "approved", parkId: review.parkId, parkName: review.parkName };
  }
  return { decision: "pending" };
}

// The same submission ID is reused on retry so a lost response never creates a duplicate.
export async function submitParkProposal(proposal: ParkProposal, fetcher: typeof fetch = globalThis.fetch): Promise<ProposalReview> {
  const origin = proposalApiOrigin();
  const config = activeAppConfig();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  let response: Response;
  try {
    response = await fetcher(`${origin}/api/park-proposals`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...requestContextHeaders() },
      body: JSON.stringify({
        ...proposal,
        context: { platform: config.platform, version: typeof __APP_VERSION__ === "undefined" ? "unknown" : __APP_VERSION__, build: String(config.build) },
      }),
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
      signal: controller.signal,
    });
  } catch {
    throw new Error(controller.signal.aborted
      ? "Sending took too long. Try again; your proposal won't be sent twice."
      : "Couldn't reach Parkdex. Check your connection and try again.");
  } finally {
    clearTimeout(timeout);
  }
  if (response.ok) return parseReview(await response.json().catch(() => null));
  if (response.status === 429) throw new Error("You've proposed a lot of parks this hour. Try again a little later.");
  if (response.status >= 500) throw new Error("Parkdex couldn't save this right now. Try again shortly.");
  try {
    const body = await response.json() as { message?: unknown };
    if (typeof body.message === "string" && body.message.length <= 200) throw new Error(body.message);
  } catch (error) {
    if (error instanceof Error && !(error instanceof SyntaxError)) throw error;
  }
  throw new Error("Check the park details and try again.");
}
