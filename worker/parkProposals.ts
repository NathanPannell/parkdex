import { database } from "./db.js";
import { HttpError } from "./validation.js";
import type { OsmRef } from "./osmParks.js";
import type { Decision, ModerationRecord } from "./proposalReview.js";

/**
 * A park a player proposes from the app: a pin, a name and either an OpenStreetMap outline
 * they picked or an optional rough outline they drew.
 */

export type LngLat = [number, number];
export const PROPOSAL_STATUSES = ["new", "reviewing", "accepted", "declined"] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_OUTLINE_POINTS = 200;
const CONTEXT_KEYS = ["platform", "version", "build"] as const;

export interface ValidatedProposal {
  submissionId: string;
  name: string;
  note: string;
  point: LngLat;
  outline: LngLat[] | null;
  osm: OsmRef | null;
  context: Partial<Record<(typeof CONTEXT_KEYS)[number], string>>;
}

export interface ParkProposalRecord {
  id: string;
  name: string;
  note: string;
  point: LngLat;
  outline: LngLat[] | null;
  context: Record<string, string>;
  status: ProposalStatus;
  createdAt: string;
  updatedAt: string;
  /** Present once park_proposals_002_moderation.sql has run. */
  osm?: OsmRef | null;
  decision?: Decision | null;
  moderation?: ModerationRecord | null;
  decidedAt?: string | null;
  publishedParkId?: string | null;
}

export type SaveProposalResult = { status: "created" | "duplicate"; proposal: ParkProposalRecord } | { status: "conflict" } | { status: "rate_limited" };

export interface ParkProposalStore {
  save(input: { id: string; payloadHash: string; ipHash: string; proposal: ValidatedProposal }): Promise<SaveProposalResult>;
  list(status: ProposalStatus | null): Promise<ParkProposalRecord[]>;
  updateStatus(id: string, status: ProposalStatus): Promise<ParkProposalRecord | null>;
}

function coordinate(value: unknown, label: string): LngLat {
  if (!Array.isArray(value) || value.length !== 2) throw new HttpError(400, "invalid_location", `${label} must be a [longitude, latitude] pair.`);
  const [lng, lat] = value;
  if (
    typeof lng !== "number" ||
    typeof lat !== "number" ||
    !Number.isFinite(lng) ||
    !Number.isFinite(lat) ||
    lng < -180 ||
    lng > 180 ||
    lat < -90 ||
    lat > 90
  ) {
    throw new HttpError(400, "invalid_location", `${label} is not a valid location.`);
  }
  // Six decimals is about 10 cm, plenty for a proposal and keeps rows small.
  return [Math.round(lng * 1e6) / 1e6, Math.round(lat * 1e6) / 1e6];
}

export function validateProposalBody(body: unknown): ValidatedProposal {
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new HttpError(400, "invalid_request", "Invalid park proposal.");
  const input = body as Record<string, unknown>;
  const allowed = new Set(["submissionId", "name", "note", "point", "outline", "osm", "context"]);
  if (Object.keys(input).some((key) => !allowed.has(key))) throw new HttpError(400, "invalid_request", "Invalid park proposal.");
  if (typeof input.submissionId !== "string" || !UUID.test(input.submissionId)) throw new HttpError(400, "invalid_request", "Invalid park proposal.");
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name || name.length > 120) throw new HttpError(400, "invalid_name", "Give the park a name of 120 characters or fewer.");
  const note = input.note === undefined ? "" : typeof input.note === "string" ? input.note.trim() : null;
  if (note === null || note.length > 1000) throw new HttpError(400, "invalid_note", "Notes must be 1000 characters or fewer.");
  const point = coordinate(input.point, "The pin");
  let outline: LngLat[] | null = null;
  if (input.outline !== undefined && input.outline !== null) {
    if (!Array.isArray(input.outline) || input.outline.length < 3 || input.outline.length > MAX_OUTLINE_POINTS) {
      throw new HttpError(400, "invalid_outline", `An outline needs 3 to ${MAX_OUTLINE_POINTS} points.`);
    }
    outline = input.outline.map((value) => coordinate(value, "An outline point"));
  }
  const osm = input.osm === undefined || input.osm === null ? null : osmRef(input.osm);
  const context: ValidatedProposal["context"] = {};
  if (input.context !== undefined) {
    if (typeof input.context !== "object" || input.context === null || Array.isArray(input.context)) {
      throw new HttpError(400, "invalid_request", "Invalid park proposal.");
    }
    for (const key of CONTEXT_KEYS) {
      const value = (input.context as Record<string, unknown>)[key];
      if (typeof value === "string" && value.length <= 40) context[key] = value;
    }
  }
  return { submissionId: input.submissionId.toLowerCase(), name, note, point, outline, osm, context };
}

function osmRef(value: unknown): OsmRef {
  const input = value as Record<string, unknown>;
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(input).some((key) => key !== "type" && key !== "id") ||
    (input.type !== "way" && input.type !== "relation") ||
    typeof input.id !== "number" ||
    !Number.isSafeInteger(input.id) ||
    input.id <= 0
  ) {
    throw new HttpError(400, "invalid_osm", "Unknown OpenStreetMap park.");
  }
  return { type: input.type, id: input.id };
}

export async function proposalHash(proposal: ValidatedProposal): Promise<string> {
  // Proposals without an OpenStreetMap pick hash exactly as before, so older retries still match.
  const fields: unknown[] = [proposal.submissionId, proposal.name, proposal.note, proposal.point, proposal.outline, proposal.context];
  if (proposal.osm) fields.push(proposal.osm);
  const canonical = JSON.stringify(fields);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
}

type Row = {
  id: string;
  name: string;
  note: string;
  longitude: number;
  latitude: number;
  outline: unknown;
  context: unknown;
  status: string;
  created_at: string | Date;
  updated_at: string | Date;
  payload_hash?: string;
  osm_type?: string | null;
  osm_id?: string | number | null;
  decision?: string | null;
  moderation?: unknown;
  decided_at?: string | Date | null;
  published_park_id?: string | null;
};

function toRecord(row: Row): ParkProposalRecord {
  return {
    id: row.id,
    name: row.name,
    note: row.note,
    point: [Number(row.longitude), Number(row.latitude)],
    outline: Array.isArray(row.outline) ? (row.outline as LngLat[]) : null,
    context: typeof row.context === "object" && row.context !== null ? (row.context as Record<string, string>) : {},
    status: row.status as ProposalStatus,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    ...("decision" in row
      ? {
          osm: row.osm_type && row.osm_id ? { type: row.osm_type as OsmRef["type"], id: Number(row.osm_id) } : null,
          decision: (row.decision as Decision | null) ?? null,
          moderation: typeof row.moderation === "object" && row.moderation !== null ? (row.moderation as ModerationRecord) : null,
          decidedAt: row.decided_at ? new Date(row.decided_at).toISOString() : null,
          publishedParkId: row.published_park_id ?? null,
        }
      : {}),
  };
}

export function createNeonParkProposalStore(databaseUrl: string): ParkProposalStore {
  const sql = database(databaseUrl);
  return {
    async save({ id, payloadHash, ipHash, proposal }) {
      const existing = (await sql`SELECT * FROM kip_proposals.parks WHERE submission_id = ${proposal.submissionId}::uuid`) as Row[];
      if (existing[0]) {
        return existing[0].payload_hash === payloadHash ? { status: "duplicate", proposal: toRecord(existing[0]) } : { status: "conflict" };
      }
      const limit = (await sql`
        INSERT INTO kip_proposals.rate_limits (subject_hash, window_started_at, hit_count)
        VALUES (${ipHash}, now(), 1)
        ON CONFLICT (subject_hash) DO UPDATE SET
          window_started_at = CASE WHEN kip_proposals.rate_limits.window_started_at <= now() - interval '1 hour' THEN now() ELSE kip_proposals.rate_limits.window_started_at END,
          hit_count = CASE WHEN kip_proposals.rate_limits.window_started_at <= now() - interval '1 hour' THEN 1 ELSE kip_proposals.rate_limits.hit_count + 1 END,
          updated_at = now()
        RETURNING hit_count <= 10 AS allowed
      `) as Array<{ allowed: boolean }>;
      if (limit[0]?.allowed !== true) return { status: "rate_limited" };
      const rows = (await sql`
        INSERT INTO kip_proposals.parks (id, submission_id, payload_hash, name, note, longitude, latitude, outline, context, osm_type, osm_id)
        VALUES (${id}::uuid, ${proposal.submissionId}::uuid, ${payloadHash}, ${proposal.name}, ${proposal.note},
          ${proposal.point[0]}, ${proposal.point[1]}, ${proposal.outline ? JSON.stringify(proposal.outline) : null}::jsonb,
          ${JSON.stringify(proposal.context)}::jsonb, ${proposal.osm?.type ?? null}, ${proposal.osm?.id ?? null})
        ON CONFLICT (submission_id) DO NOTHING
        RETURNING *
      `) as Row[];
      if (rows[0]) return { status: "created", proposal: toRecord(rows[0]) };
      // A concurrent retry won the insert; report it like any other retry.
      return this.save({ id, payloadHash, ipHash, proposal });
    },
    async list(status) {
      // Every column, so the dashboard keeps working whether or not the moderation migration has run.
      const rows = (
        status
          ? await sql`SELECT * FROM kip_proposals.parks WHERE status = ${status} ORDER BY created_at DESC LIMIT 200`
          : await sql`SELECT * FROM kip_proposals.parks ORDER BY created_at DESC LIMIT 200`
      ) as Row[];
      return rows.map(toRecord);
    },
    async updateStatus(id, status) {
      const rows = (await sql`
        UPDATE kip_proposals.parks SET status = ${status}, updated_at = now() WHERE id = ${id}::uuid
        RETURNING *
      `) as Row[];
      return rows[0] ? toRecord(rows[0]) : null;
    },
  };
}

/**
 * Map searches share the proposal rate limit table under their own keyed hashes. Searches in BC
 * read our own outline table, so the limit is loose while testing: 10 per client per minute.
 * Pins outside BC still fall back to Nominatim and Overpass, whose own policies are stricter.
 */
export function createNeonOsmSearchLimiter(databaseUrl: string): (subjectHash: string) => Promise<boolean> {
  const sql = database(databaseUrl);
  return async (subjectHash) => {
    const rows = (await sql`
      INSERT INTO kip_proposals.rate_limits (subject_hash, window_started_at, hit_count)
      VALUES (${subjectHash}, now(), 1)
      ON CONFLICT (subject_hash) DO UPDATE SET
        window_started_at = CASE WHEN kip_proposals.rate_limits.window_started_at <= now() - interval '1 minute' THEN now() ELSE kip_proposals.rate_limits.window_started_at END,
        hit_count = CASE WHEN kip_proposals.rate_limits.window_started_at <= now() - interval '1 minute' THEN 1 ELSE kip_proposals.rate_limits.hit_count + 1 END,
        updated_at = now()
      RETURNING hit_count <= 10 AS allowed
    `) as Array<{ allowed: boolean }>;
    return rows[0]?.allowed === true;
  };
}

export function parseProposalStatus(value: unknown): ProposalStatus {
  if (typeof value === "string" && (PROPOSAL_STATUSES as readonly string[]).includes(value)) return value as ProposalStatus;
  throw new HttpError(400, "invalid_status", "Unknown proposal status.");
}

export const PROPOSALS_RETIRED_MESSAGE = "Update Parkdex to add parks. Now you can become a park's founder while you're standing in it.";

/**
 * The anonymous `/api/park-proposals` submit is retired: parks are founded by signed-in players
 * standing in them (`POST /api/parks/found`). Installed builds that still propose get 410 with a
 * message; their client shows any message under 200 characters as the error, and nothing retries
 * it. Reviewing stored proposals stays in the operator dashboard. Null for other paths.
 */
export async function handleParkProposalRequest(request: Request): Promise<Response | null> {
  if (new URL(request.url).pathname !== "/api/park-proposals") return null;
  if (request.method !== "POST") throw new HttpError(405, "method_not_allowed", "Use POST.");
  throw new HttpError(410, "proposals_retired", PROPOSALS_RETIRED_MESSAGE);
}
