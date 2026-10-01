import type { LngLat } from "./geo";
import { activeAppConfig } from "./appConfig";
import { feedbackApiOrigin } from "./feedbackReport";

/** A park the player wants added: a pin, a name and an optional rough outline. */
export type ParkProposal = {
  submissionId: string;
  name: string;
  note: string;
  point: LngLat;
  outline: LngLat[] | null;
};

export const MAX_OUTLINE_POINTS = 200;

/** Thin a traced outline to the server's limit while keeping its shape. */
export function simplifyOutline(points: LngLat[], max = MAX_OUTLINE_POINTS): LngLat[] {
  if (points.length <= max) return points;
  const step = points.length / max;
  return Array.from({ length: max }, (_, index) => points[Math.floor(index * step)]);
}

// The same submission ID is reused on retry so a lost response never creates a duplicate.
export async function submitParkProposal(proposal: ParkProposal, fetcher: typeof fetch = globalThis.fetch): Promise<void> {
  let origin: string;
  try {
    origin = feedbackApiOrigin();
  } catch {
    throw new Error("Park proposals are unavailable in this app build.");
  }
  const config = activeAppConfig();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  let response: Response;
  try {
    response = await fetcher(`${origin}/api/park-proposals`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
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
  if (response.ok) return;
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
