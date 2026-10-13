import { publishStatements, type SqlRunner } from "../operator/server/drafts.js";
import { visitFromJson, type VisitRecord } from "./game-store.js";
import type { PublishablePark } from "./parkPublish.js";

/**
 * The founding transaction (#126), shared by an instant founding (`POST /api/parks/found`) and an
 * operator's approval of a manual review (#153, worker/founding-reviews.ts). One transaction under
 * an advisory lock on the park: the founder guard, for an OpenStreetMap park the proposal audit
 * row, the draft and the publish statements, then the founder row with its cover photo, the bonus,
 * and the end of every pending review request for the park. An instant founding also records
 * today's visit; a reviewed one does not, because flags need a real visit that day.
 *
 * No Node APIs here: the operator dashboard's Edge Function bundles this module.
 */

export interface Statement {
  text: string;
  params: unknown[];
}

export interface FoundedRecord {
  parkId: string;
  parkName: string;
  photoSha256: string;
  visit: VisitRecord | null;
  founderPoints: number;
}

export interface PhotoInput {
  sha256: string;
  base64: string;
  width: number;
  height: number;
}

export interface FoundCommon {
  accountId: string;
  attemptId: string;
  /** The visit an instant founding records. Unused by a reviewed founding. */
  visitId: string;
  /** Server time of the founding and of the visit it records. */
  at: string;
  photo: PhotoInput;
  /** The model's answers, stored with the founder; never the image. */
  moderation: Record<string, unknown>;
}

export interface FoundOsmInput extends FoundCommon {
  park: PublishablePark;
  osm: { type: string; id: number };
  /** The proposal row that records this founding for the operator. */
  proposal: { id: string; moderation: Record<string, unknown> };
}

export interface FoundExistingInput extends FoundCommon {
  parkId: string;
  /** The OpenStreetMap outline the player chose, when it turned out to be this catalogue park. */
  osm?: { type: string; id: number } | null;
}

export type FoundResult =
  | { status: "founded"; record: FoundedRecord }
  /** park_exists: the OpenStreetMap park was published another way meanwhile; found it as an existing park. */
  | { status: "already_founded" | "park_exists" | "park_missing" | "park_hidden" | "blocked" | "attempt_reused" | "visit_failed" | "review_not_pending" | "account_unavailable" };

/** How a founding differs by path. */
export interface FoundingMode {
  /** Record today's visit (instant founding). */
  visit: boolean;
  /** The review request this founding approves; it becomes `approved` instead of `superseded`. */
  reviewRequestId: string | null;
  /** Statements that run last in the same transaction, such as the operator's analytics rows. */
  after?: Statement[];
}

export type FoundingPlan =
  | ({ kind: "osm" } & FoundOsmInput)
  | ({ kind: "existing" } & FoundExistingInput);

const guard = (condition: string, reason: string, params: unknown[]): Statement => ({
  text: `SELECT kip_park_drafts.require(${condition}, '${reason}')`,
  params,
});

export function lockStatement(parkId: string): Statement {
  // Serialises founders of one park; record_visit takes its own park lock after this one, and
  // review rows are locked after it too, so every path takes the locks in the same order.
  return { text: "SELECT pg_advisory_xact_lock(hashtextextended('kip_founders.park:' || $1, 0))", params: [parkId] };
}

function founderStatement(input: FoundCommon, parkId: string, source: "osm_new" | "existing"): Statement {
  return {
    text: `INSERT INTO kip_founders.parks
        (park_id, account_id, attempt_id, founded_at, source, photo_sha256, photo_bytes, photo_width, photo_height, moderation)
      VALUES ($1, $2::uuid, $3::uuid, $4::timestamptz, $5, $6, decode($7, 'base64'), $8, $9, $10::jsonb)
      RETURNING kip_founders.bonus_points() AS founder_points`,
    params: [parkId, input.accountId, input.attemptId, input.at, source, input.photo.sha256, input.photo.base64,
      input.photo.width, input.photo.height, JSON.stringify(input.moderation)],
  };
}

function visitStatement(input: FoundCommon, parkId: string): Statement {
  return {
    // Founding counts as today's visit. Anything but a recorded (or same-day) visit rolls it all back.
    // During someone else's protected hour (#170) the visit is logged, and the founding still stands.
    text: `SELECT kip_park_drafts.require((v.r->>'status') IN ('recorded', 'protected', 'already_today', 'replayed'), 'visit_' || coalesce(v.r->>'status', 'failed')) AS visit_ok,
        v.r AS visit_result
      FROM (SELECT kip_game.record_visit($1::uuid, $2::uuid, $3, $4::timestamptz) AS r) v`,
    params: [input.visitId, input.accountId, parkId, input.at],
  };
}

/**
 * Closes the pending review requests this founding beats: those for the park, and those for the
 * OpenStreetMap outline it was founded from. The approved request itself is left for the caller.
 */
function supersedeStatement(parkId: string, osm: { type: string; id: number } | null | undefined, at: string, except: string | null): Statement {
  return {
    text: `UPDATE kip_founders.review_requests SET status = 'superseded', decided_at = $2::timestamptz
      WHERE status = 'pending' AND (park_id = $1 OR (osm_type = $3 AND osm_id = $4)) AND ($5::uuid IS NULL OR id <> $5::uuid)`,
    params: [parkId, at, osm?.type ?? null, osm?.id ?? null, except],
  };
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
}

/** The whole founding transaction, in order. */
export async function foundingStatements(plan: FoundingPlan, mode: FoundingMode): Promise<Statement[]> {
  const parkId = plan.kind === "osm" ? plan.park.id : plan.parkId;
  const statements: Statement[] = [lockStatement(parkId)];
  if (mode.reviewRequestId) {
    statements.push(
      { text: "SELECT id FROM kip_founders.review_requests WHERE id = $1::uuid FOR UPDATE", params: [mode.reviewRequestId] },
      guard("EXISTS (SELECT 1 FROM kip_founders.review_requests WHERE id = $1::uuid AND status = 'pending')", "review_not_pending", [mode.reviewRequestId]),
      // The player may have deleted their account since asking.
      guard("EXISTS (SELECT 1 FROM kip_account.accounts WHERE id = $1::uuid AND deletion_state = 'active')", "account_unavailable", [plan.accountId]),
    );
  }
  statements.push(guard("NOT EXISTS (SELECT 1 FROM kip_founders.parks WHERE park_id = $1)", "already_founded", [parkId]));

  if (plan.kind === "osm") {
    const { park } = plan;
    const sourceSha256 = await sha256Hex(JSON.stringify(park.source));
    statements.push(
      {
        text: `INSERT INTO kip_proposals.parks (id, submission_id, payload_hash, name, note, longitude, latitude, context, status,
            osm_type, osm_id, decision, moderation, decided_at, published_park_id, founder_account_id)
          VALUES ($1::uuid, $2::uuid, $3, $4, '', $5, $6, $7::jsonb, 'accepted', $8, $9, 'approved', $10::jsonb, $11::timestamptz, $12, $13::uuid)`,
        params: [plan.proposal.id, plan.attemptId, plan.photo.sha256, park.name.slice(0, 120), park.lng, park.lat,
          JSON.stringify({ source: mode.reviewRequestId ? "founder_review" : "founder" }), plan.osm.type, plan.osm.id,
          JSON.stringify(plan.proposal.moderation), plan.at, park.id, plan.accountId],
      },
      {
        // The draft is written inside the founding transaction, so a failed founding leaves no
        // draft behind to block the next player. A draft left by an earlier proposal is reused.
        text: `INSERT INTO kip_park_drafts.drafts (id, source, source_sha256, geometry, name, short, category, region, lat, lng, biome, shape, rarity, seed, blurb, updated_at)
          VALUES ($1, $2::jsonb, $3, $4::jsonb, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16::timestamptz)
          ON CONFLICT (id) DO UPDATE SET source = EXCLUDED.source, source_sha256 = EXCLUDED.source_sha256, geometry = EXCLUDED.geometry,
            name = EXCLUDED.name, short = EXCLUDED.short, category = EXCLUDED.category, region = EXCLUDED.region, lat = EXCLUDED.lat,
            lng = EXCLUDED.lng, biome = EXCLUDED.biome, shape = EXCLUDED.shape, rarity = EXCLUDED.rarity, seed = EXCLUDED.seed,
            blurb = EXCLUDED.blurb, updated_at = EXCLUDED.updated_at
          WHERE kip_park_drafts.drafts.status = 'draft' AND kip_park_drafts.drafts.source ? 'proposal'`,
        params: [park.id, JSON.stringify(park.source), sourceSha256, JSON.stringify(park.geometry), park.name, park.short, park.category,
          park.region, park.lat, park.lng, park.biome, park.shape, park.rarity, park.seed, park.blurb, plan.at],
      },
      ...publishStatements(park.id, plan.at, null),
      founderStatement(plan, park.id, "osm_new"),
    );
  } else {
    statements.push(
      guard("EXISTS (SELECT 1 FROM public.parks WHERE id = $1)", "park_missing", [parkId]),
      guard("NOT EXISTS (SELECT 1 FROM public.content_park_hidden WHERE park_id = $1)", "park_hidden", [parkId]),
      founderStatement(plan, parkId, "existing"),
    );
  }

  statements.push(supersedeStatement(parkId, plan.osm, plan.at, mode.reviewRequestId));
  if (mode.reviewRequestId) {
    statements.push({
      text: `UPDATE kip_founders.review_requests SET status = 'approved', decided_at = $2::timestamptz, founded_park_id = $3
        WHERE id = $1::uuid AND status = 'pending' RETURNING id AS approved_request`,
      params: [mode.reviewRequestId, plan.at, parkId],
    });
  }
  if (mode.visit) statements.push(visitStatement(plan, parkId));
  statements.push(...(mode.after ?? []));
  return statements;
}

/** The founding a guard or constraint refused, or null for an unexpected error. */
export function foundingFailure(error: unknown): Exclude<FoundResult, { status: "founded" }>["status"] | null {
  const message = error instanceof Error ? error.message : String((error as { message?: unknown })?.message ?? "");
  const reason = `${message} ${String((error as { constraint?: unknown })?.constraint ?? "")}`;
  if (/review_not_pending/.test(reason)) return "review_not_pending";
  if (/account_unavailable/.test(reason)) return "account_unavailable";
  if (/already_founded/.test(reason)) return "already_founded";
  if (/attempt_id/.test(reason)) return "attempt_reused";
  // The primary key on kip_founders.parks backs up the guard.
  if (/23505|duplicate key|parks_pkey/.test(reason)) return "already_founded";
  if (/park_exists/.test(reason)) return "park_exists";
  if (/park_missing/.test(reason)) return "park_missing";
  if (/park_hidden/.test(reason)) return "park_hidden";
  if (/draft_changed|draft_missing|draft_incomplete|badge_changed/.test(reason)) return "blocked";
  if (/visit_/.test(reason)) return "visit_failed";
  return null;
}

function jsonValue(value: unknown): unknown {
  return typeof value === "string" ? JSON.parse(value) as unknown : value;
}

/** Runs the founding transaction and reads the founder bonus and the visit back from it. */
export async function runFounding(db: SqlRunner, plan: FoundingPlan, parkName: string, mode: FoundingMode): Promise<FoundResult> {
  let results: Record<string, unknown>[][];
  try {
    results = await db.transaction(await foundingStatements(plan, mode));
  } catch (error) {
    const status = foundingFailure(error);
    if (status) return { status };
    throw error;
  }
  const founderPoints = Number(results.find((result) => result[0] && "founder_points" in result[0])?.[0]?.founder_points ?? 0);
  const visitRow = results.find((result) => result[0] && "visit_result" in result[0])?.[0];
  const body = jsonValue(visitRow?.visit_result) as { visit?: unknown } | null;
  return {
    status: "founded",
    record: {
      parkId: plan.kind === "osm" ? plan.park.id : plan.parkId, parkName, photoSha256: plan.photo.sha256, founderPoints,
      visit: body?.visit ? visitFromJson(body.visit) : null,
    },
  };
}
