import { database } from "../../../worker/db.js";
import type { AppBundleChannel } from "../../../worker/appUpdates.js";

/**
 * Publish history for over-the-air bundles (kip_app_config.ota_publishes, app_config_003). Rows
 * come from the dashboard's pointer moves and from scripts/publish-app-bundle.mjs --record. The
 * history is also how the dashboard knows which native builds an older bundle needs, because a
 * zip in R2 does not say.
 */

export type OtaAction = "publish" | "rollback" | "promote" | "repoint";
export type OtaOutcome = "confirmed" | "cdn_pending" | "conflict";

export interface OtaPublishInput {
  channel: AppBundleChannel;
  generation: number;
  previousGeneration: number | null;
  action: OtaAction;
  source: "dashboard" | "script";
  sha256: string;
  previousSha256: string | null;
  version: string;
  byteSize: number;
  minimumNativeBuild: number;
  maximumNativeBuild: number;
  sourceCommit: string;
  outcome: OtaOutcome;
  note: string;
  publishedAt: string;
}

export interface OtaPublish extends OtaPublishInput {
  id: number;
  recordedAt: string;
}

/** What the history knows about one bundle: the newest row that named it. */
export interface KnownBundle {
  sha256: string;
  version: string;
  sourceCommit: string;
  byteSize: number;
  /** The highest minimum any publication of this bundle used: the oldest build it is known to need. */
  minimumNativeBuild: number;
  maximumNativeBuild: number;
  channels: AppBundleChannel[];
  lastPublishedAt: string;
}

export interface OtaHistoryStore {
  /** False until app_config_003 is applied, so the page can say so instead of failing. */
  available(): Promise<boolean>;
  list(limit: number): Promise<OtaPublish[]>;
  bundles(): Promise<KnownBundle[]>;
  /** Idempotent per (channel, generation, sha256); returns null when the row already existed. */
  record(input: OtaPublishInput): Promise<OtaPublish | null>;
}

type Run = (text: string, params: unknown[]) => Promise<Record<string, unknown>[]>;

const COLUMNS = `id, channel, generation, previous_generation, action, source, sha256, previous_sha256, version, byte_size,
  minimum_native_build, maximum_native_build, source_commit, outcome, note, published_at, recorded_at`;

const iso = (value: unknown) => (value instanceof Date ? value : new Date(String(value))).toISOString();
const nullableNumber = (value: unknown) => (value === null || value === undefined ? null : Number(value));

function toPublish(row: Record<string, unknown>): OtaPublish {
  return {
    id: Number(row.id),
    channel: row.channel as AppBundleChannel,
    generation: Number(row.generation),
    previousGeneration: nullableNumber(row.previous_generation),
    action: row.action as OtaAction,
    source: row.source as OtaPublish["source"],
    sha256: String(row.sha256),
    previousSha256: row.previous_sha256 === null || row.previous_sha256 === undefined ? null : String(row.previous_sha256),
    version: String(row.version),
    byteSize: Number(row.byte_size),
    minimumNativeBuild: Number(row.minimum_native_build),
    maximumNativeBuild: Number(row.maximum_native_build),
    sourceCommit: String(row.source_commit),
    outcome: row.outcome as OtaOutcome,
    note: String(row.note ?? ""),
    publishedAt: iso(row.published_at),
    recordedAt: iso(row.recorded_at),
  };
}

export function createSqlOtaHistoryStore(run: Run): OtaHistoryStore {
  return {
    async available() {
      const rows = await run("SELECT to_regclass('kip_app_config.ota_publishes') IS NOT NULL AS ready", []);
      return rows[0]?.ready === true;
    },
    async list(limit) {
      const rows = await run(`SELECT ${COLUMNS} FROM kip_app_config.ota_publishes ORDER BY recorded_at DESC, id DESC LIMIT $1`, [Math.min(Math.max(limit, 1), 200)]);
      return rows.map(toPublish);
    },
    async bundles() {
      // Conflict rows describe a pointer someone else replaced, so they do not vouch for a bundle.
      const rows = await run(`
        SELECT g.sha256, g.needs, g.channels, l.version, l.source_commit, l.byte_size, l.maximum_native_build, l.published_at
        FROM (
          SELECT sha256, max(minimum_native_build) AS needs, string_agg(DISTINCT channel, ',' ORDER BY channel) AS channels
          FROM kip_app_config.ota_publishes WHERE outcome <> 'conflict' GROUP BY sha256
        ) g
        CROSS JOIN LATERAL (
          SELECT version, source_commit, byte_size, maximum_native_build, published_at
          FROM kip_app_config.ota_publishes p
          WHERE p.sha256 = g.sha256 AND p.outcome <> 'conflict'
          ORDER BY p.recorded_at DESC, p.id DESC LIMIT 1
        ) l`, []);
      return rows.map((row) => ({
        sha256: String(row.sha256),
        version: String(row.version),
        sourceCommit: String(row.source_commit),
        byteSize: Number(row.byte_size),
        minimumNativeBuild: Number(row.needs),
        maximumNativeBuild: Number(row.maximum_native_build),
        channels: String(row.channels ?? "").split(",").filter(Boolean) as AppBundleChannel[],
        lastPublishedAt: iso(row.published_at),
      }));
    },
    async record(input) {
      const rows = await run(`
        INSERT INTO kip_app_config.ota_publishes
          (channel, generation, previous_generation, action, source, sha256, previous_sha256, version, byte_size,
           minimum_native_build, maximum_native_build, source_commit, outcome, note, published_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::timestamptz)
        ON CONFLICT (channel, generation, sha256) DO NOTHING
        RETURNING ${COLUMNS}`,
      [input.channel, input.generation, input.previousGeneration, input.action, input.source, input.sha256, input.previousSha256, input.version,
        input.byteSize, input.minimumNativeBuild, input.maximumNativeBuild, input.sourceCommit, input.outcome, input.note, input.publishedAt]);
      return rows[0] ? toPublish(rows[0]) : null;
    },
  };
}

export function createNeonOtaHistoryStore(databaseUrl: string): OtaHistoryStore {
  const sql = database(databaseUrl);
  return createSqlOtaHistoryStore((text, params) => sql.query(text, params) as Promise<Record<string, unknown>[]>);
}
