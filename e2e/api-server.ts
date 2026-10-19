// The real Parkdex API for the end-to-end tests, on http://127.0.0.1:8788.
//
// It creates a fresh database on a loopback PostgreSQL server (PGHOST, PGPORT, PGUSER and
// PGPASSWORD; the CI job uses a Postgres 18 service container), applies every migration in the
// release harness order, seeds the pinned public content release with scripts/bootstrap-content.py,
// and serves the API worker and the content sync handlers against it. It never talks to Neon.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join, resolve } from "node:path";
import pg from "pg";

const ROOT = resolve(import.meta.dirname, "..");
const PORT = Number(process.env.E2E_API_PORT ?? 8788);
export const E2E_APP_ORIGIN = "https://parkdex.e2e.test";

const admin = {
  host: process.env.PGHOST,
  port: Number(process.env.PGPORT ?? 5432),
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
};
if (!["127.0.0.1", "localhost", "::1"].includes(admin.host ?? "")) throw new Error("The e2e API only uses a loopback PostgreSQL server.");
if (!admin.user || !admin.password) throw new Error("Set PGUSER and PGPASSWORD for the e2e PostgreSQL server.");

// A fresh database per run, so migrations always apply from scratch.
const database = `kip_qa_e2e_${randomBytes(6).toString("hex")}`;
const control = new pg.Client({ ...admin, database: "postgres" });
await control.connect();
await control.query(`CREATE DATABASE "${database}"`);
await control.end();
process.env.PGDATABASE = database;

// The adapter checks the loopback kip_qa_ database again and routes the Neon driver to it.
const { applyMigration, dbUrl, pool } = await import("../scripts/qa-postgres-adapter.mjs");
const { createFeedbackWorker } = await import("../worker/index.ts");
const { createSnapshotHandler, createChangesHandler, createSceneHandler } = await import("../worker/content_sync.ts");

/** Same order as migration_paths() in scripts/kip-delivery.py, which deploys use. */
function migrationPaths(): string[] {
  const config = JSON.parse(readFileSync(join(ROOT, "deployment.json"), "utf8"));
  return [
    config.migrationPath,
    ...config.contentSync.supportingMigrationPaths,
    ...config.optionalMigrationPaths,
    ...config.contentSync.migrationPaths,
    ...config.independentMigrationPaths,
  ];
}

for (const path of migrationPaths()) await applyMigration(join(ROOT, path));
// "preview" is bootstrap-content.py's mode for a throwaway database: it seeds the pinned release.
execFileSync(process.env.PYTHON ?? "python", [join(ROOT, "scripts", "bootstrap-content.py"), "--apply", "--environment", "preview"], {
  cwd: ROOT,
  env: { ...process.env, MIGRATION_DATABASE_URL: dbUrl },
  stdio: "inherit",
});

const env = {
  DATABASE_URL: dbUrl,
  AUTH_SESSION_SECRET: randomBytes(32).toString("hex"),
  SESSION_SECRET: randomBytes(32).toString("hex"),
  EMAIL_MODE: "disabled",
  PUBLIC_APP_URL: E2E_APP_ORIGIN,
  ALLOWED_ORIGINS: E2E_APP_ORIGIN,
  RELEASE_SHA: "e2e",
  CONTENT_CHANNEL: "staging",
};
const waitUntil = (promise: Promise<unknown>) => {
  promise.catch(() => undefined);
};
const worker = createFeedbackWorker();
const content: Record<string, ReturnType<typeof createSnapshotHandler>> = {
  "/api/content/snapshot": createSnapshotHandler({ env, waitUntil }),
  "/api/content/changes": createChangesHandler({ env, waitUntil }),
  "/api/content/scene": createSceneHandler({ env, waitUntil }),
};

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

async function handle(request: IncomingMessage, response: ServerResponse) {
  const url = new URL(request.url ?? "/", E2E_APP_ORIGIN);
  const handler = content[url.pathname];
  if (handler) {
    const query: Record<string, string | string[]> = {};
    for (const key of new Set(url.searchParams.keys())) {
      const values = url.searchParams.getAll(key);
      query[key] = values.length === 1 ? values[0] : values;
    }
    await handler(Object.assign(request, { query }), response);
    return;
  }
  const headers = new Headers();
  for (const [key, value] of Object.entries(request.headers)) {
    if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(", ") : value);
  }
  headers.set("cf-connecting-ip", "127.0.0.1");
  const body = request.method === "GET" || request.method === "HEAD" ? undefined : await readBody(request);
  const result = await worker.fetch(
    new Request(url, { method: request.method, headers, body: body?.length ? new Uint8Array(body) : undefined }),
    env as never,
    { waitUntil } as never,
  );
  response.statusCode = result.status;
  result.headers.forEach((value, key) => {
    if (key !== "set-cookie") response.setHeader(key, value);
  });
  const cookies = result.headers.getSetCookie();
  if (cookies.length) response.setHeader("set-cookie", cookies);
  response.end(Buffer.from(await result.arrayBuffer()));
}

const server = createServer((request, response) => {
  handle(request, response).catch((error) => {
    console.error(error);
    response.statusCode = 500;
    response.end();
  });
});
// Longer than the test client keeps idle connections, so a reused socket is not closed under it.
server.keepAliveTimeout = 65_000;
server.listen(PORT, "127.0.0.1", () => console.log(`e2e API on http://127.0.0.1:${PORT} (database ${database})`));

async function shutdown() {
  server.close();
  await pool.end().catch(() => undefined);
  const cleanup = new pg.Client({ ...admin, database: "postgres" });
  await cleanup.connect();
  await cleanup.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
  await cleanup.end();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
