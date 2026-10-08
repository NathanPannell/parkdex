import { database } from "./db.js";
import { HttpError, readJsonBody } from "./validation.js";

/** A park a player proposes from the app: a pin, a name and an optional rough outline. */

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
}

export type SaveProposalResult =
  | { status: "created" | "duplicate"; proposal: ParkProposalRecord }
  | { status: "conflict" }
  | { status: "rate_limited" };

export interface ParkProposalStore {
  save(input: { id: string; payloadHash: string; ipHash: string; proposal: ValidatedProposal }): Promise<SaveProposalResult>;
  list(status: ProposalStatus | null): Promise<ParkProposalRecord[]>;
  updateStatus(id: string, status: ProposalStatus): Promise<ParkProposalRecord | null>;
}

function coordinate(value: unknown, label: string): LngLat {
  if (!Array.isArray(value) || value.length !== 2) throw new HttpError(400, "invalid_location", `${label} must be a [longitude, latitude] pair.`);
  const [lng, lat] = value;
  if (typeof lng !== "number" || typeof lat !== "number" || !Number.isFinite(lng) || !Number.isFinite(lat) ||
      lng < -180 || lng > 180 || lat < -90 || lat > 90) {
    throw new HttpError(400, "invalid_location", `${label} is not a valid location.`);
  }
  // Six decimals is about 10 cm, plenty for a proposal and keeps rows small.
  return [Math.round(lng * 1e6) / 1e6, Math.round(lat * 1e6) / 1e6];
}

export function validateProposalBody(body: unknown): ValidatedProposal {
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new HttpError(400, "invalid_request", "Invalid park proposal.");
  const input = body as Record<string, unknown>;
  const allowed = new Set(["submissionId", "name", "note", "point", "outline", "context"]);
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
  return { submissionId: input.submissionId.toLowerCase(), name, note, point, outline, context };
}

export async function proposalHash(proposal: ValidatedProposal): Promise<string> {
  const canonical = JSON.stringify([proposal.submissionId, proposal.name, proposal.note, proposal.point, proposal.outline, proposal.context]);
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
};

function toRecord(row: Row): ParkProposalRecord {
  return {
    id: row.id,
    name: row.name,
    note: row.note,
    point: [Number(row.longitude), Number(row.latitude)],
    outline: Array.isArray(row.outline) ? row.outline as LngLat[] : null,
    context: typeof row.context === "object" && row.context !== null ? row.context as Record<string, string> : {},
    status: row.status as ProposalStatus,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

export function createNeonParkProposalStore(databaseUrl: string): ParkProposalStore {
  const sql = database(databaseUrl);
  return {
    async save({ id, payloadHash, ipHash, proposal }) {
      const existing = await sql`
        SELECT id, name, note, longitude, latitude, outline, context, status, created_at, updated_at, payload_hash
        FROM kip_proposals.parks WHERE submission_id = ${proposal.submissionId}::uuid
      ` as Row[];
      if (existing[0]) {
        return existing[0].payload_hash === payloadHash ? { status: "duplicate", proposal: toRecord(existing[0]) } : { status: "conflict" };
      }
      const limit = await sql`
        INSERT INTO kip_proposals.rate_limits (subject_hash, window_started_at, hit_count)
        VALUES (${ipHash}, now(), 1)
        ON CONFLICT (subject_hash) DO UPDATE SET
          window_started_at = CASE WHEN kip_proposals.rate_limits.window_started_at <= now() - interval '1 hour' THEN now() ELSE kip_proposals.rate_limits.window_started_at END,
          hit_count = CASE WHEN kip_proposals.rate_limits.window_started_at <= now() - interval '1 hour' THEN 1 ELSE kip_proposals.rate_limits.hit_count + 1 END,
          updated_at = now()
        RETURNING hit_count <= 10 AS allowed
      ` as Array<{ allowed: boolean }>;
      if (limit[0]?.allowed !== true) return { status: "rate_limited" };
      const rows = await sql`
        INSERT INTO kip_proposals.parks (id, submission_id, payload_hash, name, note, longitude, latitude, outline, context)
        VALUES (${id}::uuid, ${proposal.submissionId}::uuid, ${payloadHash}, ${proposal.name}, ${proposal.note},
          ${proposal.point[0]}, ${proposal.point[1]}, ${proposal.outline ? JSON.stringify(proposal.outline) : null}::jsonb,
          ${JSON.stringify(proposal.context)}::jsonb)
        ON CONFLICT (submission_id) DO NOTHING
        RETURNING id, name, note, longitude, latitude, outline, context, status, created_at, updated_at
      ` as Row[];
      if (rows[0]) return { status: "created", proposal: toRecord(rows[0]) };
      // A concurrent retry won the insert; report it like any other retry.
      return this.save({ id, payloadHash, ipHash, proposal });
    },
    async list(status) {
      const rows = (status
        ? await sql`SELECT id, name, note, longitude, latitude, outline, context, status, created_at, updated_at FROM kip_proposals.parks WHERE status = ${status} ORDER BY created_at DESC LIMIT 200`
        : await sql`SELECT id, name, note, longitude, latitude, outline, context, status, created_at, updated_at FROM kip_proposals.parks ORDER BY created_at DESC LIMIT 200`) as Row[];
      return rows.map(toRecord);
    },
    async updateStatus(id, status) {
      const rows = await sql`
        UPDATE kip_proposals.parks SET status = ${status}, updated_at = now() WHERE id = ${id}::uuid
        RETURNING id, name, note, longitude, latitude, outline, context, status, created_at, updated_at
      ` as Row[];
      return rows[0] ? toRecord(rows[0]) : null;
    },
  };
}

export interface ParkProposalHandlers {
  json(data: unknown, status?: number): Response;
  ipHash(): Promise<string>;
  newId(): string;
  store(): ParkProposalStore;
}

export function parseProposalStatus(value: unknown): ProposalStatus {
  if (typeof value === "string" && (PROPOSAL_STATUSES as readonly string[]).includes(value)) return value as ProposalStatus;
  throw new HttpError(400, "invalid_status", "Unknown proposal status.");
}

/**
 * Routes the public `/api/park-proposals` submit. Null for other paths.
 * Reviewing proposals belongs to the separately deployed operator dashboard.
 */
export async function handleParkProposalRequest(request: Request, handlers: ParkProposalHandlers): Promise<Response | null> {
  if (new URL(request.url).pathname !== "/api/park-proposals") return null;
  if (request.method !== "POST") throw new HttpError(405, "method_not_allowed", "Use POST.");
  const proposal = validateProposalBody(await readJsonBody(request, 32 * 1024));
  const result = await handlers.store().save({
    id: handlers.newId(),
    payloadHash: await proposalHash(proposal),
    ipHash: await handlers.ipHash(),
    proposal,
  });
  if (result.status === "conflict") throw new HttpError(409, "submission_id_reused", "This submission ID was already used for a different proposal.");
  if (result.status === "rate_limited") throw new HttpError(429, "rate_limited", "Please wait before proposing more parks.");
  return handlers.json({ id: result.proposal.id }, result.status === "created" ? 201 : 200);
}
