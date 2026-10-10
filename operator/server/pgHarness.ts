import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { SqlRunner } from "./drafts.ts";

/**
 * Shared setup for the *.pg.test.ts integration tests: a pool on a disposable loopback database
 * named kip_qa_*, the content and drafts migrations, and a SqlRunner that uses real transactions.
 */

const root = fileURLToPath(new URL("../../", import.meta.url));

export const CONTENT_MIGRATIONS = ["database/001_cloud_content.sql", "database/migrations/content_001_sync.sql", "database/migrations/park_drafts_001_init.sql"];

export async function openTestDatabase(dsn: string, migrations: string[] = CONTENT_MIGRATIONS) {
  const url = new URL(dsn);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || !url.pathname.slice(1).startsWith("kip_qa_")) {
    throw new Error("The integration tests need a loopback database named kip_qa_*.");
  }
  const pg = (await import("pg")).default;
  const pool = new pg.Pool({ connectionString: dsn, max: 4 });
  for (const file of migrations) await pool.query(await readFile(`${root}${file}`, "utf8"));
  await pool.query("INSERT INTO public.drive_hubs (position, name, lng, lat) VALUES (0, 'Victoria', -123.36, 48.43), (1, 'Nanaimo', -123.94, 49.17)");
  const runner: SqlRunner = {
    query: async (text, params = []) => (await pool.query(text, params)).rows,
    async transaction(statements) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const results = [];
        for (const { text, params } of statements) results.push((await client.query(text, params)).rows);
        await client.query("COMMIT");
        return results;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
  };
  return { pool, runner };
}

const square = (x: number): [number, number][][] => [[[x, 48.4], [x + 0.01, 48.4], [x + 0.01, 48.41], [x, 48.41], [x, 48.4]]];

/** Writes a draft row the way park founding does and returns its updated_at for publishStatements. */
export async function insertDraft(runner: SqlRunner, id: string, overrides: Record<string, unknown> = {}): Promise<string> {
  const draft = {
    geometry: { type: "MultiPolygon", coordinates: [square(-123.47), square(-123.45)] },
    name: "Thetis Lake Regional Park", short: "Thetis Lake", category: "regional", region: "Capital Region",
    lat: 48.48, lng: -123.47, biome: "lake", shape: "hex", rarity: "common", seed: 812, blurb: "",
    ...overrides,
  };
  const rows = await runner.query(
    `INSERT INTO kip_park_drafts.drafts (id, source, source_sha256, geometry, name, short, category, region, lat, lng, biome, shape, rarity, seed, blurb)
     VALUES ($1, $2::jsonb, $3, $4::jsonb, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING updated_at`,
    [id, JSON.stringify({ record: { id } }), "a".repeat(64), JSON.stringify(draft.geometry), draft.name, draft.short, draft.category, draft.region,
      draft.lat, draft.lng, draft.biome, draft.shape, draft.rarity, draft.seed, draft.blurb],
  );
  return new Date(rows[0].updated_at as string).toISOString();
}
