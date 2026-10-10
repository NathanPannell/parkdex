import type { SqlRunner } from "../operator/server/drafts.js";
import { catalogueMatch } from "./catalogueMatch.js";
import { runFounding, type FoundingPlan, type FoundResult, type Statement } from "./founding.js";
import type { MultiPolygon, OsmFeature } from "./osmParks.js";
import { markerPoint, positionInside } from "./parkLocation.js";
import { osmParkId, parkFromProposal } from "./parkPublish.js";
import { createSqlProposalReviewStore, regionFor } from "./proposalReview.js";
import { HttpError } from "./validation.js";

/**
 * Manual review of founding photos (#153), the operator's side and the retention run.
 *
 * The operator dashboard lists requests, shows one with its photo, and approves or rejects it.
 * Approval founds the park through the shared founding transaction (worker/founding.ts) without
 * a visit, so it pays the founder bonus but plants no flag. Both decisions write their analytics
 * event in the same transaction. The daily retention run deletes kept check photos after 24
 * hours and a decided request's photo 90 days after the decision.
 *
 * No Node APIs here: the operator dashboard's Edge Function bundles this module.
 */

export type ReviewStatus = "pending" | "approved" | "rejected" | "superseded";
export const REVIEW_STATUSES: readonly ReviewStatus[] = ["pending", "approved", "rejected", "superseded"];

/** Preset rejection reasons and the sentence the player reads. "other" needs the operator's own words. */
export const REVIEW_REASONS = {
  people: "There are people in the photo.",
  lighting: "The photo is too dark or blurry.",
  not_park: "The photo doesn't show the park.",
  inappropriate: "This photo can't be used as a park cover.",
  other: null,
} as const satisfies Record<string, string | null>;
export type ReviewReasonCode = keyof typeof REVIEW_REASONS;
export const MAX_REASON_LENGTH = 300;

export const CHECK_PHOTO_RETENTION_MS = 24 * 3_600_000;
export const DECIDED_PHOTO_RETENTION_MS = 90 * 86_400_000;
export const FOUNDING_PURGE_BATCH_LIMIT = 1000;
/** Catalogue parks this close to the player are checked against the outline, as founding does. */
const CATALOGUE_KM = 5;

/** Where the dashboard's events say they come from; the route column needs one. */
const DECIDE_ROUTE = (decision: "approve" | "reject") => `POST /operator/parks/review/:id/${decision}`;

export interface ReviewListItem {
  id: string;
  status: ReviewStatus;
  parkId: string;
  parkName: string;
  osm: { type: string; id: number } | null;
  handle: string | null;
  outcome: "reject" | "unsure";
  flags: string[];
  createdAt: string;
  /** When the photo was taken and checked. */
  checkedAt: string;
  decidedAt: string | null;
  reasonCode: ReviewReasonCode | null;
  reason: string | null;
  foundedParkId: string | null;
  photoSha256: string;
  hasPhoto: boolean;
}

export interface ReviewDetail extends ReviewListItem {
  position: { lat: number; lng: number; accuracyM: number };
  photo: { sha256: string; width: number; height: number; bytes: number | null; purgedAt: string | null };
  /** The model's answers to each question, with their probabilities. */
  moderation: { model: string | null; threshold: number | null; answers: Record<string, { choice: string; probabilities: Record<string, number> }> } | null;
  /** The outline the player stood in: the OpenStreetMap outline checked, or the park's boundary. */
  geometry: MultiPolygon | null;
  park: { inParkdex: boolean; hidden: boolean; founder: { handle: string | null; foundedAt: string } | null };
  /** Other pending requests for the same park. */
  otherPending: number;
  seenAt: string | null;
}

export interface ReviewList {
  requests: ReviewListItem[];
  counts: Record<ReviewStatus, number>;
}

export interface ApproveResult {
  parkId: string;
  parkName: string;
  source: "osm_new" | "existing";
}

export interface FoundingReviewStore {
  /** Oldest first. Null when the database has no founders_002_reviews.sql yet. */
  list(status: ReviewStatus | null, limit: number): Promise<ReviewList | null>;
  get(id: string): Promise<ReviewDetail | null>;
  photo(id: string): Promise<{ bytes: Uint8Array; sha256: string } | null>;
  approve(id: string, input: { at: string; environment: AnalyticsEnvironment }): Promise<ApproveResult>;
  reject(id: string, input: { at: string; environment: AnalyticsEnvironment; reasonCode: ReviewReasonCode; reason: string }): Promise<void>;
}

export type AnalyticsEnvironment = "main" | "staging" | "preview";

export function emptyCounts(): Record<ReviewStatus, number> {
  return { pending: 0, approved: 0, rejected: 0, superseded: 0 };
}

/** The reason a rejection stores: the preset sentence, or the operator's own words (required for "other"). */
export function rejectionReason(code: unknown, text: unknown): { reasonCode: ReviewReasonCode; reason: string } {
  if (typeof code !== "string" || !Object.hasOwn(REVIEW_REASONS, code)) {
    throw new HttpError(400, "invalid_reason", "Choose a reason: people, lighting, not_park, inappropriate or other.");
  }
  const typed = typeof text === "string" ? text.replace(/\s+/g, " ").trim() : "";
  if (text !== undefined && text !== null && typeof text !== "string") throw new HttpError(400, "invalid_reason", "The reason must be text.");
  if (typed.length > MAX_REASON_LENGTH || /[\u0000-\u001f\u007f]/.test(typed)) {
    throw new HttpError(400, "invalid_reason", `The reason must be ${MAX_REASON_LENGTH} characters or fewer of plain text.`);
  }
  const reasonCode = code as ReviewReasonCode;
  const reason = typed || REVIEW_REASONS[reasonCode];
  if (!reason) throw new HttpError(400, "invalid_reason", "Write the reason the player will read.");
  return { reasonCode, reason };
}

function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}

function nullableIso(value: unknown): string | null {
  return value === null || value === undefined ? null : iso(value);
}

function jsonValue<T>(value: unknown): T {
  return (typeof value === "string" ? JSON.parse(value) : value) as T;
}

function textArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string" && value.startsWith("{") && value.endsWith("}")) return value.slice(1, -1).split(",").filter(Boolean);
  return [];
}

function missingRelation(error: unknown): boolean {
  return typeof error === "object" && error !== null && ["42P01", "3F000"].includes(String((error as { code?: unknown }).code));
}

function base64Bytes(value: string): Uint8Array {
  // PostgreSQL wraps base64 at 76 characters; atob ignores the line breaks.
  return Uint8Array.from(atob(value.replace(/\s+/g, "")), (char) => char.charCodeAt(0));
}

const LIST_COLUMNS = `r.id, r.status, r.park_id, r.osm_type, r.osm_id, coalesce(p.name, r.park_name) AS park_name, pl.handle, r.outcome, r.flags,
  r.created_at, r.checked_at, r.decided_at, r.reason_code, r.decision_reason, r.founded_park_id, r.photo_sha256, (r.photo_bytes IS NOT NULL) AS has_photo`;

function listItem(row: Record<string, unknown>): ReviewListItem {
  return {
    id: String(row.id),
    status: String(row.status) as ReviewStatus,
    parkId: String(row.park_id),
    parkName: String(row.park_name),
    osm: row.osm_type ? { type: String(row.osm_type), id: Number(row.osm_id) } : null,
    handle: row.handle === null || row.handle === undefined ? null : String(row.handle),
    outcome: row.outcome === "unsure" ? "unsure" : "reject",
    flags: textArray(row.flags),
    createdAt: iso(row.created_at),
    checkedAt: iso(row.checked_at),
    decidedAt: nullableIso(row.decided_at),
    reasonCode: (row.reason_code ?? null) as ReviewReasonCode | null,
    reason: row.decision_reason === null || row.decision_reason === undefined ? null : String(row.decision_reason),
    foundedParkId: row.founded_park_id === null || row.founded_park_id === undefined ? null : String(row.founded_park_id),
    photoSha256: String(row.photo_sha256),
    hasPhoto: row.has_photo === true,
  };
}

function eventStatement(input: {
  type: "founding_review_decided" | "park_founded";
  accountId: string;
  parkId: string;
  at: string;
  route: string;
  environment: AnalyticsEnvironment;
  properties: Record<string, string | number | boolean | null>;
}): Statement {
  return {
    text: `INSERT INTO kip_analytics.events (event_id, event_type, account_id, request_id, route, environment, occurred_at, park_id, properties, schema_version)
      VALUES ($1::uuid, $2, $3::uuid, $4::uuid, $5, $6, $7::timestamptz, $8, $9::jsonb, 1)`,
    params: [crypto.randomUUID(), input.type, input.accountId, crypto.randomUUID(), input.route, input.environment, input.at,
      input.parkId.length <= 128 ? input.parkId : null, JSON.stringify(input.properties)],
  };
}

function waitedMinutes(createdAt: unknown, at: string): number {
  return Math.max(0, Math.round((Date.parse(at) - Date.parse(iso(createdAt))) / 60_000));
}

function decidedError(status: string): HttpError {
  return new HttpError(409, "review_decided", `This request is already ${status}. Reload to see it.`);
}

export function createSqlFoundingReviewStore(db: SqlRunner): FoundingReviewStore {
  const catalogue = createSqlProposalReviewStore(db);

  async function currentStatus(id: string): Promise<string> {
    const rows = await db.query("SELECT status FROM kip_founders.review_requests WHERE id = $1::uuid", [id]);
    return rows[0] ? String(rows[0].status) : "gone";
  }

  async function founderHandle(parkId: string): Promise<string | null> {
    const rows = await db.query(
      "SELECT pl.handle FROM kip_founders.parks f LEFT JOIN kip_game.players pl ON pl.account_id = f.account_id WHERE f.park_id = $1",
      [parkId],
    );
    return rows[0]?.handle === null || rows[0]?.handle === undefined ? null : String(rows[0].handle);
  }

  return {
    async list(status, limit) {
      try {
        const [rows, counts] = await Promise.all([
          db.query(
            `SELECT ${LIST_COLUMNS}
             FROM kip_founders.review_requests r
             LEFT JOIN public.parks p ON p.id = r.park_id
             LEFT JOIN kip_game.players pl ON pl.account_id = r.account_id
             WHERE ($1::text IS NULL OR r.status = $1::text)
             ORDER BY r.created_at, r.id LIMIT $2`,
            [status, Math.min(Math.max(Math.floor(limit), 1), 500)],
          ),
          db.query("SELECT status, count(*)::integer AS count FROM kip_founders.review_requests GROUP BY status"),
        ]);
        const totals = emptyCounts();
        for (const row of counts) if ((REVIEW_STATUSES as readonly string[]).includes(String(row.status))) totals[String(row.status) as ReviewStatus] = Number(row.count);
        return { requests: rows.map(listItem), counts: totals };
      } catch (error) {
        if (missingRelation(error)) return null;
        throw error;
      }
    },

    async get(id) {
      let rows: Record<string, unknown>[];
      try {
        rows = await db.query(
          `SELECT ${LIST_COLUMNS}, r.latitude, r.longitude, r.accuracy_m, r.photo_width, r.photo_height, octet_length(r.photo_bytes) AS photo_size,
             r.photo_purged_at, r.moderation, r.seen_at,
             coalesce(r.osm_feature->'geometry', b.feature->'geometry') AS geometry,
             (p.id IS NOT NULL) AS in_parkdex, (h.park_id IS NOT NULL) AS hidden,
             f.founded_at, fp.handle AS founder_handle, (f.park_id IS NOT NULL) AS founded,
             (SELECT count(*)::integer FROM kip_founders.review_requests o WHERE o.park_id = r.park_id AND o.status = 'pending' AND o.id <> r.id) AS other_pending
           FROM kip_founders.review_requests r
           LEFT JOIN public.parks p ON p.id = r.park_id
           LEFT JOIN public.boundaries b ON b.park_id = r.park_id
           LEFT JOIN public.content_park_hidden h ON h.park_id = r.park_id
           LEFT JOIN kip_game.players pl ON pl.account_id = r.account_id
           LEFT JOIN kip_founders.parks f ON f.park_id = coalesce(r.founded_park_id, r.park_id)
           LEFT JOIN kip_game.players fp ON fp.account_id = f.account_id
           WHERE r.id = $1::uuid`,
          [id],
        );
      } catch (error) {
        if (missingRelation(error)) return null;
        throw error;
      }
      const row = rows[0];
      if (!row) return null;
      const moderation = row.moderation ? jsonValue<Record<string, unknown>>(row.moderation) : null;
      const geometry = row.geometry ? jsonValue<MultiPolygon>(row.geometry) : null;
      return {
        ...listItem(row),
        position: { lat: Number(row.latitude), lng: Number(row.longitude), accuracyM: Number(row.accuracy_m) },
        photo: {
          sha256: String(row.photo_sha256), width: Number(row.photo_width), height: Number(row.photo_height),
          bytes: row.photo_size === null || row.photo_size === undefined ? null : Number(row.photo_size), purgedAt: nullableIso(row.photo_purged_at),
        },
        moderation: moderation ? {
          model: typeof moderation.model === "string" ? moderation.model : null,
          threshold: typeof moderation.threshold === "number" ? moderation.threshold : null,
          answers: (moderation.answers ?? {}) as NonNullable<ReviewDetail["moderation"]>["answers"],
        } : null,
        geometry: geometry?.type === "MultiPolygon" ? geometry : null,
        park: {
          inParkdex: row.in_parkdex === true,
          hidden: row.hidden === true,
          founder: row.founded === true ? { handle: row.founder_handle === null || row.founder_handle === undefined ? null : String(row.founder_handle), foundedAt: iso(row.founded_at) } : null,
        },
        otherPending: Number(row.other_pending ?? 0),
        seenAt: nullableIso(row.seen_at),
      };
    },

    async photo(id) {
      try {
        const rows = await db.query("SELECT encode(photo_bytes, 'base64') AS photo, photo_sha256 FROM kip_founders.review_requests WHERE id = $1::uuid AND photo_bytes IS NOT NULL", [id]);
        return rows[0] ? { bytes: base64Bytes(String(rows[0].photo)), sha256: String(rows[0].photo_sha256) } : null;
      } catch (error) {
        if (missingRelation(error)) return null;
        throw error;
      }
    },

    async approve(id, input) {
      const rows = await db.query(
        `SELECT r.*, encode(r.photo_bytes, 'base64') AS photo_base64 FROM kip_founders.review_requests r WHERE r.id = $1::uuid`,
        [id],
      );
      const request = rows[0];
      if (!request) throw new HttpError(404, "not_found", "That review request does not exist.");
      if (request.status !== "pending") throw decidedError(String(request.status));
      if (!request.photo_base64) throw new HttpError(409, "photo_missing", "This request has no photo any more, so it cannot be approved.");

      const accountId = String(request.account_id);
      const attemptId = String(request.attempt_id);
      const position = { lat: Number(request.latitude), lng: Number(request.longitude), accuracyM: Number(request.accuracy_m) };
      const stored = request.moderation ? jsonValue<Record<string, unknown>>(request.moderation) : {};
      const common = {
        accountId, attemptId, visitId: attemptId, at: input.at,
        photo: { sha256: String(request.photo_sha256), base64: String(request.photo_base64).replace(/\s+/g, ""), width: Number(request.photo_width), height: Number(request.photo_height) },
        moderation: { ...stored, review: { requestId: id, approvedAt: input.at, outcome: String(request.outcome) } },
      };
      const osmRef = request.osm_type ? { type: String(request.osm_type), id: Number(request.osm_id) } : null;
      const after = (parkId: string, source: "osm_new" | "existing"): Statement[] => [
        eventStatement({
          type: "founding_review_decided", accountId, parkId, at: input.at, route: DECIDE_ROUTE("approve"), environment: input.environment,
          properties: { decision: "approved", outcome: String(request.outcome), source, waited_minutes: waitedMinutes(request.created_at, input.at) },
        }),
        eventStatement({
          type: "park_founded", accountId, parkId, at: input.at, route: DECIDE_ROUTE("approve"), environment: input.environment,
          properties: { source, via: "review" },
        }),
      ];
      const mode = (parkId: string, source: "osm_new" | "existing") => ({ visit: false, reviewRequestId: id, after: after(parkId, source) });

      async function existing(parkId: string): Promise<{ result: FoundResult; parkId: string; parkName: string; source: "existing" }> {
        const parks = await db.query("SELECT name FROM public.parks WHERE id = $1", [parkId]);
        if (!parks[0]) return { result: { status: "park_missing" }, parkId, parkName: "", source: "existing" };
        const plan: FoundingPlan = { kind: "existing", ...common, parkId, osm: osmRef };
        return { result: await runFounding(db, plan, String(parks[0].name), mode(parkId, "existing")), parkId, parkName: String(parks[0].name), source: "existing" };
      }

      let outcome: { result: FoundResult; parkId: string; parkName: string; source: "osm_new" | "existing" };
      const feature = request.osm_feature ? jsonValue<OsmFeature>(request.osm_feature) : null;
      if (!feature) {
        outcome = await existing(String(request.park_id));
      } else {
        const publishedId = osmParkId(feature);
        const nearby = await catalogue.nearbyParks(position.lat, position.lng, CATALOGUE_KM);
        // Published another way, or already a Parkdex park under its own id: found that park.
        const listed = (await db.query("SELECT 1 FROM public.parks WHERE id = $1", [publishedId])).length ? { parkId: publishedId } : catalogueMatch(feature, nearby);
        if (listed) {
          outcome = await existing(listed.parkId);
        } else {
          const marker = markerPoint(feature.geometry, position);
          const region = await regionFor(catalogue, nearby, marker);
          const proposalId = crypto.randomUUID();
          const park = parkFromProposal(feature, { id: proposalId, name: feature.name ?? "", note: "", point: marker, createdAt: input.at }, region, marker);
          const distanceM = Math.round(positionInside(position, feature.geometry).distanceM);
          const plan: FoundingPlan = {
            kind: "osm", ...common, park, osm: { type: feature.type, id: feature.id },
            proposal: {
              id: proposalId,
              // The shape the operator dashboard shows for proposals.
              moderation: {
                version: 1, checkedAt: input.at, model: stored.model ?? null, threshold: stored.threshold ?? null, answers: stored.answers ?? null,
                reasons: ["Founded after the operator approved a manual review of the player's photo."],
                osm: { type: feature.type, id: feature.id, name: feature.name, kind: feature.kind, areaM2: feature.areaM2, distanceM, containsPin: distanceM === 0 },
                nearby: [], review: { requestId: id },
              },
            },
          };
          outcome = { result: await runFounding(db, plan, park.name, mode(park.id, "osm_new")), parkId: park.id, parkName: park.name, source: "osm_new" };
          if (outcome.result.status === "park_exists") outcome = await existing(park.id);
        }
      }

      const { result } = outcome;
      if (result.status === "founded") return { parkId: outcome.parkId, parkName: outcome.parkName, source: outcome.source };
      if (result.status === "already_founded" || result.status === "park_exists") {
        // Founded by someone else under another id (a catalogue match): this request lost the race.
        await db.query(
          "UPDATE kip_founders.review_requests SET status = 'superseded', decided_at = $2::timestamptz WHERE id = $1::uuid AND status = 'pending'",
          [id, input.at],
        );
        const handle = await founderHandle(outcome.parkId);
        throw new HttpError(409, "already_founded", `${outcome.parkName || "This park"} was founded first${handle ? ` by @${handle}` : ""}. The request is closed as superseded.`);
      }
      if (result.status === "review_not_pending") throw decidedError(await currentStatus(id));
      if (result.status === "park_missing" || result.status === "park_hidden") {
        throw new HttpError(409, "park_unavailable", "The park is hidden or no longer in Parkdex, so it cannot be founded. Unhide it first or reject the request.");
      }
      if (result.status === "account_unavailable") throw new HttpError(409, "account_unavailable", "The player's account is being deleted, so the park cannot be founded for them.");
      if (result.status === "blocked") throw new HttpError(409, "founding_blocked", "An operator draft holds this park's id, so it cannot be founded right now.");
      throw new HttpError(409, "founding_failed", "The founding did not go through. Nothing was changed.");
    },

    async reject(id, input) {
      const rows = await db.query("SELECT status, account_id, park_id, outcome, created_at FROM kip_founders.review_requests WHERE id = $1::uuid", [id]);
      const request = rows[0];
      if (!request) throw new HttpError(404, "not_found", "That review request does not exist.");
      if (request.status !== "pending") throw decidedError(String(request.status));
      try {
        await db.transaction([
          { text: "SELECT id FROM kip_founders.review_requests WHERE id = $1::uuid FOR UPDATE", params: [id] },
          {
            text: "SELECT kip_park_drafts.require(EXISTS (SELECT 1 FROM kip_founders.review_requests WHERE id = $1::uuid AND status = 'pending'), 'review_not_pending')",
            params: [id],
          },
          {
            text: `UPDATE kip_founders.review_requests SET status = 'rejected', decided_at = $2::timestamptz, reason_code = $3, decision_reason = $4
              WHERE id = $1::uuid AND status = 'pending'`,
            params: [id, input.at, input.reasonCode, input.reason],
          },
          eventStatement({
            type: "founding_review_decided", accountId: String(request.account_id), parkId: String(request.park_id), at: input.at,
            route: DECIDE_ROUTE("reject"), environment: input.environment,
            properties: { decision: "rejected", reason_code: input.reasonCode, outcome: String(request.outcome), waited_minutes: waitedMinutes(request.created_at, input.at) },
          }),
        ]);
      } catch (error) {
        const message = error instanceof Error ? error.message : String((error as { message?: unknown })?.message ?? "");
        if (/review_not_pending/.test(message)) throw decidedError(await currentStatus(id));
        throw error;
      }
    },
  };
}

export interface FoundingPurgeResult {
  deleted: number;
  remainingExpired: number;
}

export type QueryRunner = (text: string, params: unknown[]) => Promise<Record<string, unknown>[]>;

/**
 * The daily retention run: deletes kept check photos older than 24 hours, and removes the photo of
 * a request decided more than 90 days ago (an approved photo lives on as the park's cover). Both
 * oldest first and bounded. A database without founders_002 has nothing to purge.
 */
export async function purgeFoundingPhotos(run: QueryRunner, now: number, batchLimit = FOUNDING_PURGE_BATCH_LIMIT): Promise<FoundingPurgeResult> {
  const checkCutoff = new Date(now - CHECK_PHOTO_RETENTION_MS).toISOString();
  const decidedCutoff = new Date(now - DECIDED_PHOTO_RETENTION_MS).toISOString();
  try {
    const kept = await run(`
      WITH expired AS MATERIALIZED (
        SELECT check_id FROM kip_founders.check_photos WHERE created_at <= $1::timestamptz ORDER BY created_at, check_id LIMIT $2
      ),
      removed AS (
        DELETE FROM kip_founders.check_photos k USING expired WHERE k.check_id = expired.check_id RETURNING k.check_id
      )
      SELECT (SELECT count(*) FROM removed)::int AS deleted,
        ((SELECT count(*) FROM kip_founders.check_photos WHERE created_at <= $1::timestamptz) - (SELECT count(*) FROM removed))::int AS remaining`,
    [checkCutoff, batchLimit]);
    const decided = await run(`
      WITH expired AS MATERIALIZED (
        SELECT id FROM kip_founders.review_requests
        WHERE status <> 'pending' AND decided_at <= $1::timestamptz AND photo_bytes IS NOT NULL
        ORDER BY decided_at, id LIMIT $2
      ),
      purged AS (
        UPDATE kip_founders.review_requests r SET photo_bytes = NULL, photo_purged_at = $3::timestamptz
        FROM expired WHERE r.id = expired.id RETURNING r.id
      )
      SELECT (SELECT count(*) FROM purged)::int AS deleted,
        ((SELECT count(*) FROM kip_founders.review_requests WHERE status <> 'pending' AND decided_at <= $1::timestamptz AND photo_bytes IS NOT NULL)
          - (SELECT count(*) FROM purged))::int AS remaining`,
    [decidedCutoff, batchLimit, new Date(now).toISOString()]);
    return {
      deleted: Number(kept[0]?.deleted ?? 0) + Number(decided[0]?.deleted ?? 0),
      remainingExpired: Math.max(0, Number(kept[0]?.remaining ?? 0)) + Math.max(0, Number(decided[0]?.remaining ?? 0)),
    };
  } catch (error) {
    if (missingRelation(error)) return { deleted: 0, remainingExpired: 0 };
    throw error;
  }
}
