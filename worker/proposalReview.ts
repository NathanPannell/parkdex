import { database } from "./db.js";
import { distanceToMultiPolygon, interiorPoint, pointInMultiPolygon, type MultiPolygon, type OsmClient, type OsmFeature, type OsmRef } from "./osmParks.js";
import { parkFromProposal, publishProposalPark, type SqlRunner } from "./parkPublish.js";
import { provinceFor, provinceOfOutline } from "./provinces.js";
import { HttpError } from "./validation.js";
import { catalogueMatch } from "./catalogueMatch.js";

/**
 * Checks a park proposal with the moderation model and, when the model clearly approves a
 * proposal that names an OpenStreetMap outline, publishes the park straight away. Anything
 * else waits for the operator, with the model's answers saved on the proposal.
 */

export const DEFAULT_APPROVE_THRESHOLD = 0.8;
/** The pin must be inside the outline or within this many metres of it, as the search offers. */
const MAX_PIN_DISTANCE_M = 1_000;
const MIN_AREA_M2 = 100;
const MAX_AREA_M2 = 50_000_000;
// Wide enough to catch a big catalogue park whose centre is a few km from the pin.
const NEARBY_KM = 5;
const REGION_KM = 30;

export type Decision = "approved" | "rejected" | "unsure" | "skipped";

/** A choice question in the moderation module's Decisions API format. */
export interface ChoiceQuestion {
  type: "choice";
  instructions: string;
  criteria: Record<string, string>;
}

export interface ChoiceAnswer {
  choice: string | null;
  probabilities: Record<string, number>;
}

/**
 * The shared moderation module, adapted to choice questions. Resolves null when the model is not
 * configured, fails or times out, so callers fall back to the operator.
 */
export type ProposalModerator = (input: { kind: string; state: unknown; questions: Record<string, ChoiceQuestion> }) =>
  Promise<{ model: string | null; answers: Record<string, ChoiceAnswer> } | null>;

export const QUESTIONS: Record<"park" | "name" | "duplicate", ChoiceQuestion> = {
  park: {
    type: "choice",
    instructions: "A player of a park-visiting game proposed adding this place to the game's park catalogue. Using the OpenStreetMap feature and the player's note, decide whether it is a real park or green space that members of the public can freely visit.",
    criteria: {
      approve: "A real, publicly accessible park, nature reserve, public garden or protected green space that people can walk into.",
      reject: "Private land, a backyard, a business, a school yard or sports facility with no public park, a road or building, a joke, spam, offensive content, or not a real place.",
      unsure: "Not enough information to tell.",
    },
  },
  name: {
    type: "choice",
    instructions: "Does the player's proposed park name refer to the same place as the OpenStreetMap feature? If the feature has no name, decide whether the proposed name is a plausible, inoffensive name for it.",
    criteria: {
      match: "The proposed name is the feature's name, a common variant of it, or a plausible inoffensive name for an unnamed feature.",
      mismatch: "The proposed name describes a different place, is misleading, or is offensive.",
      unsure: "Not enough information to tell.",
    },
  },
  duplicate: {
    type: "choice",
    instructions: "Is the proposed place the same as one of the existing catalogue parks listed in nearbyParks (for example the same park under a different name, or a part of one)?",
    criteria: {
      new: "None of the nearby catalogue parks is this place.",
      duplicate: "One of the nearby catalogue parks is this place or contains it.",
      unsure: "Not enough information to tell.",
    },
  },
};

export function approveThreshold(value: string | undefined): number {
  const number = value === undefined || value.trim() === "" ? NaN : Number(value);
  return Number.isFinite(number) && number >= 0.5 && number <= 1 ? number : DEFAULT_APPROVE_THRESHOLD;
}

function probability(answer: ChoiceAnswer | undefined, label: string): number {
  if (!answer) return 0;
  const value = answer.probabilities[label];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return answer.choice === label ? 1 : 0;
}

function highest(answer: ChoiceAnswer | undefined): string | null {
  if (!answer) return null;
  const entries = Object.entries(answer.probabilities).filter(([, value]) => Number.isFinite(value));
  if (!entries.length) return answer.choice;
  return entries.sort((a, b) => b[1] - a[1])[0][0];
}

/**
 * Approve only when every answer clearly favours publishing: the place is a public park, the
 * name fits and it is not already in the catalogue, each at or above the threshold.
 */
export function decide(answers: Record<string, ChoiceAnswer>, threshold: number): { decision: Exclude<Decision, "skipped">; reasons: string[] } {
  const reasons: string[] = [];
  const park = answers.park, name = answers.name, duplicate = answers.duplicate;
  if (highest(park) === "reject" || probability(park, "reject") > 0.5) return { decision: "rejected", reasons: ["The model judged this is not a public park."] };
  if (highest(name) === "mismatch" || probability(name, "mismatch") > 0.5) return { decision: "rejected", reasons: ["The model judged the name does not fit the mapped place."] };
  if (highest(duplicate) === "duplicate" || probability(duplicate, "duplicate") > 0.5) return { decision: "rejected", reasons: ["The model judged this is already in the catalogue."] };
  if (highest(park) !== "approve" || probability(park, "approve") < threshold) reasons.push("Not clearly a public park.");
  if (highest(name) !== "match" || probability(name, "match") < threshold) reasons.push("Not clearly the same place as the name.");
  if (highest(duplicate) !== "new" || probability(duplicate, "new") < threshold) reasons.push("Might already be in the catalogue.");
  return reasons.length ? { decision: "unsure", reasons } : { decision: "approved", reasons: [] };
}

// ---------------------------------------------------------------- store

export interface NearbyPark {
  id: string;
  name: string;
  region: string;
  lat: number;
  lng: number;
  boundary: MultiPolygon | null;
}

export interface ReviewState {
  decision: Decision | null;
  publishedParkId: string | null;
}

export interface ModerationRecord {
  version: 1;
  checkedAt: string;
  model: string | null;
  threshold: number | null;
  answers: Record<string, ChoiceAnswer> | null;
  reasons: string[];
  osm: { type: string; id: number; name: string | null; kind: string; areaM2: number; distanceM: number; containsPin: boolean } | null;
  nearby: { id: string; name: string; distanceM: number; overlaps: boolean }[];
  publishError?: string;
}

export interface ProposalReviewStore {
  state(proposalId: string): Promise<ReviewState | null>;
  nearbyParks(lat: number, lng: number, km: number): Promise<NearbyPark[]>;
  record(proposalId: string, decision: Decision, moderation: ModerationRecord): Promise<void>;
  /** The database runner for the publish transaction. */
  sql(): SqlRunner;
}

export function createSqlProposalReviewStore(db: SqlRunner): ProposalReviewStore {
  return {
    async state(proposalId) {
      const rows = await db.query("SELECT decision, published_park_id FROM kip_proposals.parks WHERE id = $1::uuid", [proposalId]);
      if (!rows[0]) return null;
      return { decision: (rows[0].decision as Decision | null) ?? null, publishedParkId: (rows[0].published_park_id as string | null) ?? null };
    },
    async nearbyParks(lat, lng, km) {
      const dLat = km / 110.54, dLng = km / (111.32 * Math.cos((lat * Math.PI) / 180));
      const rows = await db.query(
        `SELECT p.id, p.name, p.region, p.lat, p.lng, b.feature->'geometry' AS geometry
         FROM public.parks p LEFT JOIN public.boundaries b ON b.park_id = p.id
         WHERE p.lat BETWEEN $1 AND $2 AND p.lng BETWEEN $3 AND $4
         ORDER BY (p.lat - $5) ^ 2 + (p.lng - $6) ^ 2 LIMIT 80`,
        [lat - dLat, lat + dLat, lng - dLng, lng + dLng, lat, lng],
      );
      return rows.map((row) => {
        const geometry = row.geometry as MultiPolygon | null;
        return {
          id: String(row.id), name: String(row.name), region: String(row.region), lat: Number(row.lat), lng: Number(row.lng),
          boundary: geometry && geometry.type === "MultiPolygon" && Array.isArray(geometry.coordinates) ? geometry : null,
        };
      });
    },
    async record(proposalId, decision, moderation) {
      await db.query(
        `UPDATE kip_proposals.parks SET decision = $2, moderation = $3::jsonb, decided_at = now(), updated_at = now() WHERE id = $1::uuid`,
        [proposalId, decision, JSON.stringify(moderation)],
      );
    },
    sql: () => db,
  };
}

/** Every query goes through database() so it is recorded like the rest of the API. */
export function databaseSqlRunner(databaseUrl: string): SqlRunner {
  const sql = database(databaseUrl);
  return {
    query: (text, params = []) => sql.query(text, params) as Promise<Record<string, unknown>[]>,
    transaction: (statements) => sql.transaction(statements.map(({ text, params }) => sql.query(text, params))) as Promise<Record<string, unknown>[][]>,
  };
}

// ---------------------------------------------------------------- review

export interface ReviewInput {
  id: string;
  name: string;
  note: string;
  point: [number, number];
  osm: OsmRef | null;
  createdAt: string;
}

export interface ReviewDependencies {
  store: ProposalReviewStore;
  osm: OsmClient;
  /** Null when OPENROUTER_API_KEY is not set: every proposal waits for the operator. */
  moderate: ProposalModerator | null;
  threshold: number;
  now(): Date;
}

export type ReviewOutcome =
  | { decision: "approved"; parkId: string; parkName: string }
  /** The outline is a park Parkdex already has; nothing new is published. */
  | { decision: "already_listed"; parkId: string; parkName: string }
  | { decision: "pending" };

function distanceKm(a: [number, number], b: [number, number]): number {
  const kx = 111.32 * Math.cos((a[1] * Math.PI) / 180);
  return Math.hypot((a[0] - b[0]) * kx, (a[1] - b[1]) * 110.54);
}

function overlaps(feature: OsmFeature, park: NearbyPark): boolean {
  if (pointInMultiPolygon([park.lng, park.lat], feature.geometry)) return true;
  return park.boundary !== null && pointInMultiPolygon(interiorPoint(feature.geometry), park.boundary);
}

function regionFrom(parks: NearbyPark[], point: [number, number], province: string): string | null {
  return parks.find((park) =>
    park.region.trim() && distanceKm(point, [park.lng, park.lat]) <= REGION_KM && provinceFor([park.lng, park.lat]) === province,
  )?.region ?? null;
}

/**
 * The region of the nearest catalogue park in the same province that has one, looking up to
 * REGION_KM away, else the province's name. The province is the one that holds the outline
 * when there is one, else the point's.
 */
export async function regionFor(
  store: Pick<ProposalReviewStore, "nearbyParks">,
  nearby: NearbyPark[],
  point: [number, number],
  outline?: MultiPolygon,
): Promise<string> {
  const province = outline ? provinceOfOutline(outline) : provinceFor(point);
  return regionFrom(nearby, point, province) ??
    regionFrom(await store.nearbyParks(point[1], point[0], REGION_KM), point, province) ??
    province;
}

/**
 * Runs once per proposal. A retried submission with a stored decision returns that decision
 * without asking the model again.
 */
export async function reviewProposal(proposal: ReviewInput, deps: ReviewDependencies): Promise<ReviewOutcome> {
  const existing = await deps.store.state(proposal.id);
  if (existing?.publishedParkId) return { decision: "approved", parkId: existing.publishedParkId, parkName: proposal.name };
  if (existing?.decision) return { decision: "pending" };

  const record: ModerationRecord = { version: 1, checkedAt: deps.now().toISOString(), model: null, threshold: null, answers: null, reasons: [], osm: null, nearby: [] };
  const wait = async (decision: Decision, reason: string): Promise<ReviewOutcome> => {
    record.reasons.push(reason);
    await deps.store.record(proposal.id, decision, record);
    return { decision: "pending" };
  };

  if (!deps.moderate) return wait("skipped", "The moderation model is not configured.");
  if (!proposal.osm) return wait("skipped", "No OpenStreetMap outline was chosen.");

  let feature: OsmFeature | null;
  try {
    feature = await deps.osm.feature(proposal.osm);
  } catch {
    return wait("skipped", "OpenStreetMap was unavailable.");
  }
  if (!feature) return wait("rejected", "The chosen OpenStreetMap outline no longer exists or is not a park.");
  const distanceM = Math.round(distanceToMultiPolygon(proposal.point, feature.geometry));
  record.osm = { type: feature.type, id: feature.id, name: feature.name, kind: feature.kind, areaM2: feature.areaM2, distanceM, containsPin: distanceM === 0 };
  if (distanceM > MAX_PIN_DISTANCE_M) return wait("rejected", `The outline is ${distanceM} m from the pin.`);
  if (feature.areaM2 < MIN_AREA_M2 || feature.areaM2 > MAX_AREA_M2) return wait("unsure", "The outline is unusually small or large for a park.");

  const nearby = await deps.store.nearbyParks(proposal.point[1], proposal.point[0], NEARBY_KM);
  record.nearby = nearby.slice(0, 15).map((park) => ({
    id: park.id, name: park.name, distanceM: Math.round(distanceKm(proposal.point, [park.lng, park.lat]) * 1000), overlaps: overlaps(feature!, park),
  }));
  // The app marks these as "Already on the map"; this stops one sent anyway, without asking the model.
  const listed = catalogueMatch(feature, nearby);
  if (listed) {
    await wait("rejected", `Already in Parkdex as ${listed.name} (${listed.parkId}).`);
    return { decision: "already_listed", parkId: listed.parkId, parkName: listed.name };
  }

  record.threshold = deps.threshold;
  const result = await deps.moderate({
    kind: "park_proposal",
    state: {
      proposal: { name: proposal.name, note: proposal.note || null, pin: { lat: proposal.point[1], lng: proposal.point[0] } },
      openStreetMap: { name: feature.name, kind: feature.kind, tags: feature.tags, areaSquareMetres: feature.areaM2, pinInside: distanceM === 0, pinDistanceMetres: distanceM },
      nearbyParks: record.nearby.map(({ name, distanceM: metres, overlaps: overlapping }) => ({ name, distanceMetres: metres, overlapsOutline: overlapping })),
    },
    questions: QUESTIONS,
  }).catch(() => null);
  if (!result) return wait("skipped", "The moderation model was unavailable.");
  record.model = result.model;
  record.answers = result.answers;

  const verdict = decide(result.answers, deps.threshold);
  if (verdict.decision !== "approved") {
    record.reasons.push(...verdict.reasons);
    await deps.store.record(proposal.id, verdict.decision, record);
    return { decision: "pending" };
  }
  const park = parkFromProposal(feature, { id: proposal.id, name: proposal.name, note: proposal.note, point: proposal.point, createdAt: proposal.createdAt }, await regionFor(deps.store, nearby, proposal.point, feature.geometry), proposal.point);
  try {
    const published = await publishProposalPark(deps.store.sql(), park, proposal.id);
    if (published.status === "blocked") {
      record.publishError = published.reason === "park_exists" ? "A park with this id is already in Parkdex." : "A draft with this id already exists.";
      await deps.store.record(proposal.id, "approved", record);
      return { decision: "pending" };
    }
    await deps.store.record(proposal.id, "approved", record);
    return { decision: "approved", parkId: published.parkId, parkName: park.name };
  } catch (error) {
    // Keep database detail out of the stored record; the guard name is enough to act on.
    const guard = error instanceof Error ? /park_exists|park_incomplete|draft_changed|draft_incomplete|draft_missing/.exec(error.message)?.[0] : undefined;
    record.publishError = guard ? `Publishing was rolled back (${guard}).` : "Publishing failed.";
    await deps.store.record(proposal.id, "approved", record).catch(() => undefined);
    return { decision: "pending" };
  }
}

/**
 * The operator approves a waiting proposal from the dashboard: the same outline fetch and
 * publish transaction, without the model. The model's stored answers stay as they were.
 */
export async function publishProposalByOperator(proposal: ReviewInput, deps: Pick<ReviewDependencies, "store" | "osm">): Promise<{ parkId: string; parkName: string }> {
  const state = await deps.store.state(proposal.id);
  if (state?.publishedParkId) return { parkId: state.publishedParkId, parkName: proposal.name };
  if (!proposal.osm) throw new HttpError(422, "no_osm_outline", "This proposal has no OpenStreetMap outline. Create a draft and draw the boundary instead.");
  const feature = await deps.osm.feature(proposal.osm);
  if (!feature) throw new HttpError(422, "osm_missing", "That OpenStreetMap outline no longer exists or is not a park.");
  const nearby = await deps.store.nearbyParks(proposal.point[1], proposal.point[0], NEARBY_KM);
  const park = parkFromProposal(feature, { id: proposal.id, name: proposal.name, note: proposal.note, point: proposal.point, createdAt: proposal.createdAt }, await regionFor(deps.store, nearby, proposal.point, feature.geometry), proposal.point);
  const published = await publishProposalPark(deps.store.sql(), park, proposal.id).catch((error: unknown) => {
    // PostgreSQL errors can include connection details; pass on only the guard name.
    const guard = error instanceof Error ? /park_exists|draft_changed|draft_incomplete|draft_missing/.exec(error.message)?.[0] : undefined;
    throw new HttpError(422, "publish_failed", `Publishing was rolled back${guard ? ` (${guard})` : ""}. Try again.`);
  });
  if (published.status === "blocked") {
    throw new HttpError(409, published.reason, published.reason === "park_exists" ? "A park with this outline is already in Parkdex." : "A draft for this outline already exists. Open it from Drafts.");
  }
  return { parkId: published.parkId, parkName: park.name };
}
