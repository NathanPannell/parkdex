import { database } from "../db.js";
import type { ClaimDisplay, ClaimDisplayRecord, ClaimPayload, ClaimRecord, PhotoContentType, PhotoMetadata, ProgressEnv } from "./progress-types.js";

export type PutClaimResult =
  | { status: "created"; claim: ClaimRecord }
  | { status: "identical"; claim: ClaimRecord }
  | { status: "conflict" }
  | { status: "unavailable" };

export type ReservePhotoResult =
  | { status: "reserved" | "existing"; photo: PhotoMetadata }
  | { status: "conflict" | "claim_missing" | "unavailable" };

export interface ClaimPage {
  rows: ClaimRecord[];
  hasMore: boolean;
}

export interface ProgressStore {
  putClaim(accountId: string, claim: ClaimPayload, payloadHash: string): Promise<PutClaimResult>;
  listClaims(accountId: string, cursorRevision: string | null, limit: number): Promise<ClaimPage>;
  getClaim(accountId: string, claimId: string): Promise<ClaimRecord | null>;
  reservePhoto(accountId: string, claimId: string, photo: Omit<PhotoMetadata, "status" | "createdAt">): Promise<ReservePhotoResult>;
  markPhotoReady(accountId: string, claimId: string, sha256: string): Promise<boolean>;
  getPhoto(accountId: string, claimId: string): Promise<PhotoMetadata | null>;
  snapshotDeletionPhotoObjects(receiptId: string, accountId: string): Promise<number>;
  listDeletionPhotoObjects(receiptId: string): Promise<string[]>;
  deleteAccountProgress(accountId: string): Promise<void>;
  recordPhotoDeletionFailure(receiptId: string): Promise<void>;
  clearDeletionPhotoObjects(receiptId: string): Promise<void>;
  /** Display choices for the account's claims (#174). Absent where game_005_dex.sql has not run. */
  listClaimDisplays?(accountId: string, limit: number): Promise<ClaimDisplayRecord[]>;
  putClaimDisplay?(accountId: string, claimId: string, display: ClaimDisplay): Promise<PutClaimDisplayResult>;
}

export type PutClaimDisplayResult =
  | { status: "saved"; display: ClaimDisplayRecord }
  | { status: "claim_missing" | "unavailable" };

function stringValue(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : stringValue(value);
}

function jsonValue<T>(value: unknown): T {
  if (typeof value === "string") return JSON.parse(value) as T;
  return value as T;
}

function photoFromRow(row: Record<string, unknown>, prefix = ""): PhotoMetadata | null {
  const status = row[`${prefix}photo_status`];
  if (status !== "pending" && status !== "ready") return null;
  return {
    status,
    contentType: row[`${prefix}photo_content_type`] as PhotoContentType,
    sizeBytes: Number(row[`${prefix}photo_size_bytes`]),
    sha256: stringValue(row[`${prefix}photo_sha256`]).trim(),
    objectKey: stringValue(row[`${prefix}photo_object_key`]),
    createdAt: stringValue(row[`${prefix}photo_created_at`]),
  };
}

function claimFromRow(row: Record<string, unknown>): ClaimRecord {
  const photo = photoFromRow(row);
  const photoView = photo?.status === "ready"
    ? { status: "ready" as const, sha256: photo.sha256, sizeBytes: photo.sizeBytes, contentType: photo.contentType }
    : photo?.status === "pending" ? { status: "pending" as const } : { status: "missing" as const };
  return {
    claimId: stringValue(row.claim_id).toLowerCase(),
    parkId: stringValue(row.park_id),
    claimedAt: stringValue(row.claimed_at),
    parkSnapshot: jsonValue(row.park_snapshot),
    contentReleaseId: nullableString(row.content_release_id),
    createdAt: stringValue(row.created_at_exact ?? row.created_at),
    syncRevision: stringValue(row.effective_revision ?? row.sync_revision),
    payloadHash: stringValue(row.payload_hash).trim(),
    photo: photoView,
  };
}

function progressSelect(where = ""): string {
  return `
    SELECT c.claim_id, c.park_id, c.claimed_at, c.park_snapshot, c.content_release_id, c.created_at, c.payload_hash,
      to_char(c.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at_exact,
      GREATEST(c.sync_revision, COALESCE(p.sync_revision, 0))::text AS effective_revision,
      p.status AS photo_status, p.content_type AS photo_content_type, p.size_bytes AS photo_size_bytes,
      p.sha256 AS photo_sha256, p.object_key AS photo_object_key, p.created_at AS photo_created_at
    FROM kip_account.claims c
    LEFT JOIN kip_account.claim_photos p ON p.account_id = c.account_id AND p.claim_id = c.claim_id
    ${where}`;
}

function rowToPhoto(row: Record<string, unknown>): PhotoMetadata {
  const photo = photoFromRow(row);
  if (!photo) throw new Error("photo metadata is missing");
  return photo;
}

export function createNeonProgressStore(databaseUrl: string): ProgressStore {
  const sql = database(databaseUrl);

  async function getClaim(accountId: string, claimId: string): Promise<ClaimRecord | null> {
    const rows = await sql.query(progressSelect("WHERE c.account_id = $1::uuid AND c.claim_id = $2::uuid LIMIT 1"), [accountId, claimId]);
    return rows[0] ? claimFromRow(rows[0] as Record<string, unknown>) : null;
  }

  async function putClaim(accountId: string, claim: ClaimPayload, payloadHash: string): Promise<PutClaimResult> {
    const insert = await sql.query(`
      WITH active_account AS (
        SELECT a.id FROM kip_account.accounts a
        WHERE a.id = $1::uuid AND a.deletion_state = 'active'
          AND NOT EXISTS (
            SELECT 1 FROM kip_account.claims c WHERE c.account_id = a.id AND c.claim_id = $2::uuid
          )
        FOR UPDATE
      ), claim_revision AS (
        SELECT id, nextval('kip_account.progress_change_seq') AS revision FROM active_account
      )
      INSERT INTO kip_account.claims
        (account_id, claim_id, park_id, claimed_at, park_snapshot, content_release_id, sync_revision, payload_hash)
      SELECT r.id, $2::uuid, $3, $4::timestamptz, $5::jsonb, $6, r.revision, $7
      FROM claim_revision r
      ON CONFLICT (account_id, claim_id) DO NOTHING
      RETURNING claim_id`,
    [accountId, claim.claimId, claim.parkId, claim.claimedAt, JSON.stringify(claim.parkSnapshot), claim.contentReleaseId, payloadHash]);

    if (insert.length > 0) {
      const current = await getClaim(accountId, claim.claimId);
      return current ? { status: "created", claim: current } : { status: "unavailable" };
    }
    const active = await sql.query("SELECT id FROM kip_account.accounts WHERE id = $1::uuid AND deletion_state = 'active' LIMIT 1", [accountId]);
    if (active.length === 0) return { status: "unavailable" };
    const current = await getClaim(accountId, claim.claimId);
    if (!current) return { status: "conflict" };
    return current.payloadHash === payloadHash ? { status: "identical", claim: current } : { status: "conflict" };
  }

  async function listClaims(accountId: string, cursorRevision: string | null, limit: number): Promise<ClaimPage> {
    const query = cursorRevision !== null
      ? progressSelect("WHERE c.account_id = $1::uuid AND GREATEST(c.sync_revision, COALESCE(p.sync_revision, 0)) > $2::bigint ORDER BY GREATEST(c.sync_revision, COALESCE(p.sync_revision, 0)) ASC, c.claim_id ASC LIMIT $3")
      : progressSelect("WHERE c.account_id = $1::uuid ORDER BY GREATEST(c.sync_revision, COALESCE(p.sync_revision, 0)) ASC, c.claim_id ASC LIMIT $2");
    const rows = cursorRevision !== null
      ? await sql.query(query, [accountId, cursorRevision, limit + 1])
      : await sql.query(query, [accountId, limit + 1]);
    const hasMore = rows.length > limit;
    return { rows: (hasMore ? rows.slice(0, limit) : rows).map((row) => claimFromRow(row as Record<string, unknown>)), hasMore };
  }

  async function reservePhoto(
    accountId: string,
    claimId: string,
    photo: Omit<PhotoMetadata, "status" | "createdAt">,
  ): Promise<ReservePhotoResult> {
    const insert = await sql.query(`
      WITH active_claim AS (
        SELECT c.account_id, c.claim_id FROM kip_account.claims c
        JOIN kip_account.accounts a ON a.id = c.account_id
        WHERE c.account_id = $1::uuid AND c.claim_id = $2::uuid AND a.deletion_state = 'active'
        FOR UPDATE OF a
      ), photo_revision AS (
        SELECT c.account_id, c.claim_id, nextval('kip_account.progress_change_seq') AS revision FROM active_claim c
        WHERE NOT EXISTS (
          SELECT 1 FROM kip_account.claim_photos p WHERE p.account_id = c.account_id AND p.claim_id = c.claim_id
        )
      )
      INSERT INTO kip_account.claim_photos
        (account_id, claim_id, object_key, content_type, sha256, size_bytes, status, sync_revision)
      SELECT c.account_id, c.claim_id, $3, $4, $5, $6, 'pending', c.revision FROM photo_revision c
      ON CONFLICT (account_id, claim_id) DO NOTHING
      RETURNING status AS photo_status, content_type AS photo_content_type, sha256 AS photo_sha256,
        size_bytes AS photo_size_bytes, object_key AS photo_object_key, created_at AS photo_created_at`,
    [accountId, claimId, photo.objectKey, photo.contentType, photo.sha256, photo.sizeBytes]);

    const activeRows = await sql.query(`
      SELECT id FROM kip_account.accounts WHERE id = $1::uuid AND deletion_state = 'active' LIMIT 1`, [accountId]);
    if (activeRows.length === 0) return { status: "unavailable" };

    const existingRows = await sql.query(`
      SELECT p.status AS photo_status, p.content_type AS photo_content_type, p.sha256 AS photo_sha256,
        p.size_bytes AS photo_size_bytes, p.object_key AS photo_object_key, p.created_at AS photo_created_at
      FROM kip_account.claim_photos p
      WHERE p.account_id = $1::uuid AND p.claim_id = $2::uuid LIMIT 1`, [accountId, claimId]);
    const row = (insert[0] ?? existingRows[0]) as Record<string, unknown> | undefined;
    if (row) {
      const current = rowToPhoto(row);
      if (current.sha256 !== photo.sha256) return { status: "conflict" };
      return { status: insert.length > 0 ? "reserved" : "existing", photo: current };
    }

    const claimRows = await sql.query(`
      SELECT c.claim_id FROM kip_account.claims c
      JOIN kip_account.accounts a ON a.id = c.account_id
      WHERE c.account_id = $1::uuid AND c.claim_id = $2::uuid AND a.deletion_state = 'active' LIMIT 1`, [accountId, claimId]);
    return claimRows.length > 0 ? { status: "unavailable" } : { status: "claim_missing" };
  }

  async function markPhotoReady(accountId: string, claimId: string, sha256: string): Promise<boolean> {
    const rows = await sql.query(`
      WITH active_account AS (
        SELECT a.id FROM kip_account.accounts a
        JOIN kip_account.claim_photos p ON p.account_id = a.id AND p.claim_id = $2::uuid AND p.sha256 = $3 AND p.status = 'pending'
        WHERE a.id = $1::uuid AND a.deletion_state = 'active'
        FOR UPDATE OF a
      ), photo_revision AS (
        SELECT id, nextval('kip_account.progress_change_seq') AS revision FROM active_account
      )
      UPDATE kip_account.claim_photos p SET status = 'ready', sync_revision = r.revision, updated_at = clock_timestamp()
      FROM photo_revision r
      WHERE p.account_id = r.id AND p.account_id = $1::uuid AND p.claim_id = $2::uuid AND p.sha256 = $3 AND p.status = 'pending'
      RETURNING p.claim_id`, [accountId, claimId, sha256]);
    if (rows.length > 0) return true;
    const existing = await sql.query(`
      SELECT p.claim_id FROM kip_account.claim_photos p
      JOIN kip_account.accounts a ON a.id = p.account_id
      WHERE p.account_id = $1::uuid AND p.claim_id = $2::uuid AND p.sha256 = $3
        AND p.status = 'ready' AND a.deletion_state = 'active' LIMIT 1`, [accountId, claimId, sha256]);
    return existing.length > 0;
  }

  async function getPhoto(accountId: string, claimId: string): Promise<PhotoMetadata | null> {
    const rows = await sql.query(`
      SELECT p.status AS photo_status, p.content_type AS photo_content_type, p.sha256 AS photo_sha256,
        p.size_bytes AS photo_size_bytes, p.object_key AS photo_object_key, p.created_at AS photo_created_at
      FROM kip_account.claim_photos p
      JOIN kip_account.accounts a ON a.id = p.account_id
      WHERE p.account_id = $1::uuid AND p.claim_id = $2::uuid AND a.deletion_state = 'active' LIMIT 1`, [accountId, claimId]);
    return rows[0] ? rowToPhoto(rows[0] as Record<string, unknown>) : null;
  }

  async function snapshotDeletionPhotoObjects(receiptId: string, accountId: string): Promise<number> {
    await sql.query(`
      INSERT INTO kip_account.account_deletion_photo_objects (receipt_id, account_id, claim_id, object_key)
      SELECT $1::uuid, p.account_id, p.claim_id, p.object_key
      FROM kip_account.claim_photos p
      WHERE p.account_id = $2::uuid
      ON CONFLICT (receipt_id, object_key) DO NOTHING`, [receiptId, accountId]);
    const rows = await sql.query(`SELECT count(*)::integer AS object_count FROM kip_account.account_deletion_photo_objects WHERE receipt_id = $1::uuid`, [receiptId]);
    return Number((rows[0] as Record<string, unknown> | undefined)?.object_count ?? 0);
  }

  async function listDeletionPhotoObjects(receiptId: string): Promise<string[]> {
    const rows = await sql.query(`SELECT object_key FROM kip_account.account_deletion_photo_objects WHERE receipt_id = $1::uuid ORDER BY object_key`, [receiptId]);
    return rows.map((row) => stringValue((row as Record<string, unknown>).object_key));
  }

  async function deleteAccountProgress(accountId: string): Promise<void> {
    await sql.query("DELETE FROM kip_account.claims WHERE account_id = $1::uuid", [accountId]);
  }

  async function recordPhotoDeletionFailure(receiptId: string): Promise<void> {
    await sql.query(`
      UPDATE kip_account.account_deletion_photo_objects
      SET attempts = attempts + 1, last_error = 'Private photo cleanup is incomplete.', updated_at = now()
      WHERE receipt_id = $1::uuid`, [receiptId]);
  }

  async function clearDeletionPhotoObjects(receiptId: string): Promise<void> {
    await sql.query("DELETE FROM kip_account.account_deletion_photo_objects WHERE receipt_id = $1::uuid", [receiptId]);
  }

  function displayFromRow(row: Record<string, unknown>): ClaimDisplayRecord {
    const crop = row.crop === null || row.crop === undefined ? null : jsonValue<ClaimDisplay["crop"]>(row.crop);
    return {
      claimId: stringValue(row.claim_id).toLowerCase(),
      crop: crop ? { x: Number(crop.x), y: Number(crop.y), width: Number(crop.width), height: Number(crop.height) } : null,
      coverAt: row.cover_at === null || row.cover_at === undefined ? null : new Date(stringValue(row.cover_at)).toISOString(),
      removed: row.removed === true || row.removed === "t",
      updatedAt: new Date(stringValue(row.updated_at)).toISOString(),
    };
  }

  async function listClaimDisplays(accountId: string, limit: number): Promise<ClaimDisplayRecord[]> {
    const rows = await sql.query(`
      SELECT d.claim_id, d.crop, d.cover_at, d.removed, d.updated_at
      FROM kip_account.claim_display d
      JOIN kip_account.accounts a ON a.id = d.account_id AND a.deletion_state = 'active'
      WHERE d.account_id = $1::uuid
      ORDER BY d.updated_at DESC, d.claim_id
      LIMIT $2`, [accountId, limit]);
    return rows.map((row) => displayFromRow(row as Record<string, unknown>));
  }

  async function putClaimDisplay(accountId: string, claimId: string, display: ClaimDisplay): Promise<PutClaimDisplayResult> {
    // Written whole; the last write wins. Only for an active account's own claim.
    const rows = await sql.query(`
      INSERT INTO kip_account.claim_display (account_id, claim_id, crop, cover_at, removed, updated_at)
      SELECT c.account_id, c.claim_id, $3::jsonb, $4::timestamptz, $5, clock_timestamp()
      FROM kip_account.claims c
      JOIN kip_account.accounts a ON a.id = c.account_id AND a.deletion_state = 'active'
      WHERE c.account_id = $1::uuid AND c.claim_id = $2::uuid
      ON CONFLICT (account_id, claim_id) DO UPDATE
        SET crop = EXCLUDED.crop, cover_at = EXCLUDED.cover_at, removed = EXCLUDED.removed, updated_at = EXCLUDED.updated_at
      RETURNING claim_id, crop, cover_at, removed, updated_at`,
    [accountId, claimId, display.crop ? JSON.stringify(display.crop) : null, display.coverAt, display.removed]);
    if (rows[0]) return { status: "saved", display: displayFromRow(rows[0] as Record<string, unknown>) };
    const active = await sql.query("SELECT id FROM kip_account.accounts WHERE id = $1::uuid AND deletion_state = 'active' LIMIT 1", [accountId]);
    return active.length === 0 ? { status: "unavailable" } : { status: "claim_missing" };
  }

  return {
    putClaim,
    listClaims,
    getClaim,
    reservePhoto,
    markPhotoReady,
    getPhoto,
    snapshotDeletionPhotoObjects,
    listDeletionPhotoObjects,
    deleteAccountProgress,
    recordPhotoDeletionFailure,
    clearDeletionPhotoObjects,
    listClaimDisplays,
    putClaimDisplay,
  };
}

export function createProgressStore(env: ProgressEnv): ProgressStore {
  if (!env.DATABASE_URL) throw new Error("Progress service is unavailable.");
  return createNeonProgressStore(env.DATABASE_URL);
}
