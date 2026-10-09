import { readJsonBody } from "../../../worker/validation.js";
import type { DashboardEnv, SectionContext } from "../api.js";
import { allowMethods, databaseUrl, HttpError, json } from "../http.js";
import { createNeonLiveParkStore, validateExpected, validateLiveChanges, type LiveParkStore } from "./liveParks.js";

/** Parks section under /api/parks: reading and editing parks that are already live in Parkdex. */

/** Settings this section reads from the deployment. */
export interface ParksEnv {}

export interface ParksDependencies {
  liveParkStore?(env: DashboardEnv): LiveParkStore;
}

const ID = /^[a-z0-9][a-z0-9-]{0,159}$/;

async function load(parks: LiveParkStore, id: string) {
  const park = await parks.get(id);
  if (!park) throw new HttpError(404, "not_found", "That park is not in Parkdex.");
  return park;
}

export async function parksRoutes(request: Request, context: SectionContext): Promise<Response | null> {
  const { path } = context;
  const parks = () => context.dependencies.liveParkStore?.(context.env) ?? createNeonLiveParkStore(databaseUrl(context.env));

  if (path === "/api/parks") {
    allowMethods(request, "GET");
    return json({ parks: await parks().list() });
  }
  // Checked before /api/parks/<id>; no park id is a bare word like this.
  if (path === "/api/parks/regions") {
    allowMethods(request, "GET");
    return json({ regions: await parks().regions() });
  }

  const match = /^\/api\/parks\/([^/]+)$/.exec(path);
  if (!match) return null;
  const id = match[1];
  if (!ID.test(id)) throw new HttpError(404, "not_found", "That park is not in Parkdex.");
  const store = parks();
  if (request.method === "GET") return json({ park: await load(store, id) });
  allowMethods(request, "GET", "PATCH");
  context.requireSameOrigin();
  const body = await readJsonBody(request, 512 * 1024) as Record<string, unknown>;
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new HttpError(400, "invalid_request", "Send expected and changes.");
  const expected = validateExpected(body.expected);
  if (expected.id !== id) throw new HttpError(400, "invalid_request", "Send the park as you opened it.");
  const changes = validateLiveChanges(body.changes);
  if (!Object.keys(changes).length) throw new HttpError(400, "invalid_request", "Nothing to save.");
  const revision = await store.update(id, expected, changes);
  return json({ revision, park: await load(store, id) });
}
