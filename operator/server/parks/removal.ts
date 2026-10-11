import { catalogueMatch, nameKey, type CatalogueMatch } from "../../../worker/catalogueMatch.js";
import { lockStatement, type Statement } from "../../../worker/founding.js";
import type { AnalyticsEnvironment } from "../../../worker/founding-reviews.js";
import type { OsmFeature } from "../../../worker/osmParks.js";
import { osmParkId } from "../../../worker/parkPublish.js";
import { HttpError } from "../../../worker/validation.js";
import type { SqlRunner } from "../drafts.js";
import type { MultiPolygon } from "./geometry.js";
import { deleteGuards, deleteRows, sourceOf, transactionError, type Bbox, type ParkSource } from "./manager.js";
import { catalogueBox, createSqlOsmStore, featureBbox, OSM_LIMIT, parseOsmRef, type CatalogueNeighbour, type OsmStore } from "./osm.js";

/**
 * Remove from map: takes a park off every player's map and unfounds it, but keeps the
 * OpenStreetMap outline in kip_osm.parks, so the in-app search offers the outline as "not in
 * Parkdex" and anyone standing in it can found it again straight away (docs/park-founders.md).
 *
 * One transaction under the founding transaction's advisory lock on the park, so it cannot
 * interleave with a founding: close the park's pending founding reviews as rejected (the player
 * reads that the park was removed), delete the founder row (the cover photo and the founder bonus
 * go with it), then the same draft and park delete as the dashboard's Delete, which writes the
 * park, boundary and drive tombstones in one content revision. Visits and flag tenures keep their
 * park id as history, exactly as Delete leaves them; a same-day founding by someone who already
 * visited records `already_today`, which founding accepts.
 *
 * A park can be removed only when an outline in the table would found it again: its own outline
 * for an osm-* park, or for a curated, legacy or proposed park the named outline that
 * worker/catalogueMatch pairs with it and that no other Parkdex park claims. Otherwise the
 * dashboard disables the action and points at Delete.
 */

/** What the player reads in the app after "Your photo for <park> wasn't approved:". */
export const REMOVED_REASON = "The park was removed from the map before anyone reviewed it.";
/** The route the analytics rows name. */
export const REMOVAL_ROUTE = "POST /operator/parks/:id/remove-from-map";

export interface RemovalOutline {
  type: "way" | "relation";
  id: number;
  name: string | null;
  areaM2: number;
  /** The id a founding of this outline publishes. */
  parkId: string;
}

export type RemovalBlock = "no_outline" | "unnamed_outline" | "outline_is_other_park" | "park_in_enrichment";

export interface RemovalPlan {
  parkId: string;
  name: string;
  source: ParkSource;
  hidden: boolean;
  founder: { handle: string | null; foundedAt: string; source: string } | null;
  /** Pending founding review requests for the park or its outline; all are closed. */
  pendingReviews: number;
  outline: RemovalOutline | null;
  /** Why this park cannot be removed from the map; null when it can. */
  blocked: { code: RemovalBlock; message: string } | null;
  /** False on a database without founders_003, which has no park_removed event type yet. */
  audited: boolean;
}

export interface RemovalResult {
  parkId: string;
  name: string;
  revision: number | null;
  founder: { handle: string | null } | null;
  reviewsClosed: number;
  outline: RemovalOutline;
  audited: boolean;
}

export interface ParkRemovalStore {
  plan(id: string): Promise<RemovalPlan | null>;
  remove(id: string, input: { at: string; environment: AnalyticsEnvironment }): Promise<RemovalResult>;
}

/** The park fields the outline search needs. */
export interface RemovalPark {
  id: string;
  name: string;
  lat: number;
  lng: number;
  geometry: MultiPolygon | null;
}

/** A pin-only park still finds an outline drawn around its pin. */
const PIN_BOX_DEG = 0.003;

const BLOCK_MESSAGES = {
  no_outline: "No OpenStreetMap outline in the park table matches this park, so it couldn't be founded again. Use Delete to remove it for good.",
  unnamed_outline: "Its OpenStreetMap outline has no name, and unnamed outlines can't be founded. Use Delete to remove it for good.",
  park_in_enrichment: "This park is in the art enrichment queue, so it can't be removed from the map. Hide it instead.",
} as const;

function outlineOf(feature: OsmFeature): RemovalOutline {
  return { type: feature.type, id: feature.id, name: feature.name, areaM2: feature.areaM2, parkId: osmParkId(feature) };
}

/**
 * The outline that would found this park again, and why removal is refused when there is none.
 * Several outlines can pair with one catalogue park (a playground inside a big park pairs with
 * it too), so the best is the one no other park claims, named, with the park's own name, largest.
 */
export async function outlineFor(park: RemovalPark, osm: OsmStore): Promise<{ outline: RemovalOutline | null; blocked: RemovalPlan["blocked"] }> {
  const ref = park.id.startsWith("osm-") ? parseOsmRef(park.id.slice(4)) : null;
  const pinBox: Bbox = { west: park.lng - PIN_BOX_DEG, south: park.lat - PIN_BOX_DEG, east: park.lng + PIN_BOX_DEG, north: park.lat + PIN_BOX_DEG };
  let candidates: OsmFeature[];
  let area: Bbox;
  if (ref) {
    const feature = await osm.feature(ref);
    candidates = feature ? [feature] : [];
    area = feature ? featureBbox(feature.geometry) : pinBox;
  } else {
    area = park.geometry ? featureBbox(park.geometry) : pinBox;
    candidates = await osm.inBox(area, OSM_LIMIT);
  }
  if (!candidates.length) return { outline: null, blocked: { code: "no_outline", message: BLOCK_MESSAGES.no_outline } };

  const catalogue = await osm.catalogue(catalogueBox(area));
  const others = catalogue.filter((neighbour) => neighbour.id !== park.id);
  const self: CatalogueNeighbour = catalogue.find((neighbour) => neighbour.id === park.id)
    ?? { id: park.id, name: park.name, region: "", lat: park.lat, lng: park.lng, boundary: park.geometry };
  const mine = ref ? candidates : candidates.filter((feature) => catalogueMatch(feature, [self, ...others])?.parkId === park.id);
  const own = nameKey(park.name);
  const ranked: Array<{ feature: OsmFeature; other: CatalogueMatch | null }> = mine
    .map((feature) => ({ feature, other: catalogueMatch(feature, others) }))
    .sort((a, b) => Number(a.other !== null) - Number(b.other !== null)
      || Number(!a.feature.name) - Number(!b.feature.name)
      || Number(nameKey(a.feature.name) !== own) - Number(nameKey(b.feature.name) !== own)
      || b.feature.areaM2 - a.feature.areaM2
      || a.feature.id - b.feature.id);
  const best = ranked[0];
  if (!best) return { outline: null, blocked: { code: "no_outline", message: BLOCK_MESSAGES.no_outline } };
  const outline = outlineOf(best.feature);
  if (best.other) {
    return {
      outline,
      blocked: {
        code: "outline_is_other_park",
        message: `Its OpenStreetMap outline is also ${best.other.name} in Parkdex, so founding it would found ${best.other.name} instead. Use Delete to remove it for good.`,
      },
    };
  }
  if (!best.feature.name) return { outline, blocked: { code: "unnamed_outline", message: BLOCK_MESSAGES.unnamed_outline } };
  return { outline, blocked: null };
}

/** Which of the newer schemas this database has. Production can run a release behind staging. */
export interface RemovalFeatures {
  founders: boolean;
  reviews: boolean;
  osm: boolean;
  events: boolean;
  /** founders_003: kip_analytics.events accepts park_removed. */
  audited: boolean;
}

interface StatementInput {
  parkId: string;
  outline: { type: string; id: number };
  source: ParkSource;
  at: string;
  environment: AnalyticsEnvironment;
  features: RemovalFeatures;
  uuid(): string;
}

function removedEvent(input: StatementInput): Statement {
  const { parkId, outline, features } = input;
  const founder = features.founders ? "(SELECT account_id FROM kip_founders.parks WHERE park_id = $1)" : "NULL::uuid";
  const founderSource = features.founders ? "(SELECT source FROM kip_founders.parks WHERE park_id = $1)" : "NULL::text";
  const pending = features.reviews
    ? "(SELECT count(*) FROM kip_founders.review_requests WHERE status = 'pending' AND (park_id = $1 OR (osm_type = $10 AND osm_id = $11)))::integer"
    : "0";
  const params: unknown[] = [parkId, input.uuid(), input.uuid(), REMOVAL_ROUTE, input.environment, input.at, parkId.length <= 128 ? parkId : null,
    input.source, `${outline.type}/${outline.id}`];
  if (features.reviews) params.push(outline.type, outline.id);
  return {
    text: `INSERT INTO kip_analytics.events (event_id, event_type, account_id, request_id, route, environment, occurred_at, park_id, properties, schema_version)
      SELECT $2::uuid, 'park_removed', ${founder}, $3::uuid, $4, $5, $6::timestamptz, $7,
        jsonb_build_object('source', $8::text, 'had_founder', ${founder} IS NOT NULL, 'founder_source', ${founderSource},
          'reviews_closed', ${pending}, 'outline', $9::text), 1`,
    params,
  };
}

/**
 * Closes the pending reviews as rejected with the reason the player reads, and writes the same
 * founding_review_decided row a rejection from the Review page writes, with reason_code
 * park_removed. "Superseded" would tell the player someone else founded the park.
 */
function closeReviews(input: StatementInput): Statement {
  const logged = input.features.events ? `, logged AS (
      INSERT INTO kip_analytics.events (event_id, event_type, account_id, request_id, route, environment, occurred_at, park_id, properties, schema_version)
      SELECT gen_random_uuid(), 'founding_review_decided', account_id, gen_random_uuid(), $6, $7, $2::timestamptz,
        CASE WHEN length(park_id) <= 128 THEN park_id END,
        jsonb_build_object('decision', 'rejected', 'reason_code', 'park_removed', 'outcome', outcome,
          'waited_minutes', greatest(0, round(extract(epoch FROM ($2::timestamptz - created_at)) / 60))::integer), 1
      FROM closed RETURNING 1
    )` : "";
  const params: unknown[] = [input.parkId, input.at, REMOVED_REASON, input.outline.type, input.outline.id];
  if (input.features.events) params.push(REMOVAL_ROUTE, input.environment);
  return {
    text: `WITH closed AS (
        UPDATE kip_founders.review_requests SET status = 'rejected', decided_at = $2::timestamptz, reason_code = 'other', decision_reason = $3
        WHERE status = 'pending' AND (park_id = $1 OR (osm_type = $4 AND osm_id = $5))
        RETURNING id, account_id, park_id, outcome, created_at
      )${logged}
      SELECT count(*)::integer AS reviews_closed FROM closed`,
    params,
  };
}

/** The whole removal, in order. Every statement after the locks can roll the rest back. */
export function removalStatements(input: StatementInput): Statement[] {
  const { parkId, outline, features } = input;
  const statements: Statement[] = [
    // The founding transaction's lock comes first, then the park row, as founding takes them.
    lockStatement(parkId),
    ...deleteGuards(parkId),
    {
      text: "SELECT kip_park_drafts.require(EXISTS (SELECT 1 FROM kip_osm.parks WHERE osm_type = $1 AND osm_id = $2), 'outline_missing')",
      params: [outline.type, outline.id],
    },
  ];
  // Written first, while the founder and the pending reviews it counts are still there.
  if (features.audited) statements.push(removedEvent(input));
  if (features.reviews) statements.push(closeReviews(input));
  if (features.founders) {
    statements.push({
      // The park delete would cascade to it too; deleting it here reads back whose bonus went.
      text: `WITH removed AS (DELETE FROM kip_founders.parks WHERE park_id = $1 RETURNING account_id)
        SELECT true AS founder_removed, pl.handle AS founder_handle FROM removed r LEFT JOIN kip_game.players pl ON pl.account_id = r.account_id`,
      params: [parkId],
    });
  }
  statements.push(...deleteRows(parkId));
  return statements;
}

function removalError(error: unknown): HttpError {
  const message = error instanceof Error ? error.message : String((error as { message?: unknown })?.message ?? "");
  if (/park_in_enrichment/.test(message)) return new HttpError(409, "park_in_enrichment", BLOCK_MESSAGES.park_in_enrichment);
  if (/outline_missing/.test(message)) {
    return new HttpError(409, "no_outline", "The OpenStreetMap outline left the park table, so the park couldn't be founded again. Nothing was changed.");
  }
  return transactionError(error);
}

function blockedError(plan: RemovalPlan): HttpError {
  return new HttpError(409, plan.blocked!.code, plan.blocked!.message);
}

function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}

function jsonValue<T>(value: unknown): T {
  return (typeof value === "string" ? JSON.parse(value) : value) as T;
}

export function createSqlParkRemovalStore(db: SqlRunner, uuid: () => string = () => crypto.randomUUID()): ParkRemovalStore {
  const osm = createSqlOsmStore(db);

  async function features(): Promise<RemovalFeatures> {
    const rows = await db.query(
      `SELECT to_regclass('kip_founders.parks') IS NOT NULL AS founders,
         to_regclass('kip_founders.review_requests') IS NOT NULL AS reviews,
         to_regclass('kip_osm.parks') IS NOT NULL AS osm,
         to_regclass('kip_analytics.events') IS NOT NULL AS events,
         EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = to_regclass('kip_analytics.events')
           AND conname = 'events_event_type_v2_check' AND pg_get_constraintdef(oid) LIKE '%park_removed%') AS audited`,
    );
    const row = rows[0] ?? {};
    return { founders: row.founders === true, reviews: row.reviews === true, osm: row.osm === true, events: row.events === true, audited: row.audited === true };
  }

  async function plan(id: string): Promise<{ plan: RemovalPlan; features: RemovalFeatures } | null> {
    const [available, parks] = await Promise.all([
      features(),
      db.query(
        `SELECT p.id, p.name, p.lat, p.lng, b.feature->'geometry' AS geometry, (h.park_id IS NOT NULL) AS hidden,
           EXISTS (SELECT 1 FROM public.content_park_reader_floor f WHERE f.park_id = p.id AND f.minimum_reader >= 3) AS legacy,
           EXISTS (SELECT 1 FROM kip_park_drafts.drafts d WHERE d.id = p.id AND d.status = 'published' AND d.source ? 'proposal') AS proposal,
           EXISTS (SELECT 1 FROM public.park_enrichment_jobs j WHERE j.park_id = p.id) AS enrichment
         FROM public.parks p
         LEFT JOIN public.boundaries b ON b.park_id = p.id
         LEFT JOIN public.content_park_hidden h ON h.park_id = p.id
         WHERE p.id = $1`,
        [id],
      ),
    ]);
    const row = parks[0];
    if (!row) return null;
    const geometry = row.geometry ? jsonValue<MultiPolygon>(row.geometry) : null;
    const park: RemovalPark = {
      id, name: String(row.name), lat: Number(row.lat), lng: Number(row.lng),
      geometry: geometry?.type === "MultiPolygon" && geometry.coordinates?.length ? geometry : null,
    };
    const found = available.osm ? await outlineFor(park, osm) : { outline: null, blocked: { code: "no_outline" as const, message: BLOCK_MESSAGES.no_outline } };
    const [founders, pending] = await Promise.all([
      available.founders ? db.query(
        `SELECT f.founded_at, f.source, pl.handle FROM kip_founders.parks f LEFT JOIN kip_game.players pl ON pl.account_id = f.account_id
         WHERE f.park_id = $1`,
        [id],
      ) : Promise.resolve([]),
      available.reviews ? db.query(
        `SELECT count(*)::integer AS count FROM kip_founders.review_requests
         WHERE status = 'pending' AND (park_id = $1 OR (osm_type = $2 AND osm_id = $3))`,
        [id, found.outline?.type ?? null, found.outline?.id ?? null],
      ) : Promise.resolve([{ count: 0 }]),
    ]);
    const founder = founders[0];
    const blocked = row.enrichment === true ? { code: "park_in_enrichment" as const, message: BLOCK_MESSAGES.park_in_enrichment } : found.blocked;
    return {
      features: available,
      plan: {
        parkId: id, name: park.name, source: sourceOf(id, row.legacy === true, row.proposal === true), hidden: row.hidden === true,
        founder: founder ? { handle: founder.handle === null || founder.handle === undefined ? null : String(founder.handle), foundedAt: iso(founder.founded_at), source: String(founder.source) } : null,
        pendingReviews: Number(pending[0]?.count ?? 0),
        outline: found.outline,
        blocked,
        audited: available.audited,
      },
    };
  }

  return {
    async plan(id) {
      return (await plan(id))?.plan ?? null;
    },

    async remove(id, input) {
      const planned = await plan(id);
      if (!planned) throw new HttpError(404, "not_found", "That park is not in Parkdex.");
      const { plan: current, features: available } = planned;
      if (current.blocked || !current.outline) throw blockedError(current);
      let results: Record<string, unknown>[][];
      try {
        results = await db.transaction(removalStatements({
          parkId: id, outline: current.outline, source: current.source, at: input.at, environment: input.environment, features: available, uuid,
        }));
      } catch (error) {
        throw removalError(error);
      }
      const row = (key: string) => results.find((result) => result[0] && key in result[0])?.[0];
      const founder = row("founder_removed");
      const revision = results[results.length - 1]?.[0]?.revision;
      return {
        parkId: id,
        name: current.name,
        revision: revision === undefined || revision === null ? null : Number(revision),
        founder: founder ? { handle: founder.founder_handle === null || founder.founder_handle === undefined ? null : String(founder.founder_handle) } : null,
        reviewsClosed: Number(row("reviews_closed")?.reviews_closed ?? 0),
        outline: current.outline,
        audited: available.audited,
      };
    },
  };
}
