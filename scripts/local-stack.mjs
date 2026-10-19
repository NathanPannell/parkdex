// Local full stack for signed-in QA: runs the real API worker on http://127.0.0.1:<port> against a
// throwaway loopback PostgreSQL `kip_qa_*` database, with seeded test-only accounts.
//
//   npm run local:api                                   # uses PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE
//   npm run local:api -- --pgdata <dir> --pg-port 55510 # creates or reuses a throwaway cluster in <dir>
//   npm run local:api -- --content ...                  # also the content tables, so parks can be founded
//
// See docs/local-stack.md. Never point this at a hosted database.
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { argon2id, hash as argonHash } from "argon2";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SEED = JSON.parse(readFileSync(join(ROOT, "scripts", "local-stack.seed.json"), "utf8"));

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const apiPort = Number(option("port", process.env.LOCAL_API_PORT ?? "8787"));
const appOrigin = option("app-origin", process.env.LOCAL_APP_ORIGIN ?? "http://localhost:5190");
const pgData = option("pgdata", process.env.LOCAL_PGDATA);
const pgBin = process.env.PG_BIN ?? "C:/Program Files/PostgreSQL/18/bin";
// Founding a park publishes it through the content tables, which check that every park has a
// boundary and drive rows. --content installs them and seeds parks with their boundaries.
const withContent = process.argv.includes("--content");
const exe = (name) => (process.platform === "win32" ? join(pgBin, `${name}.exe`) : join(pgBin, name));

/** Creates (first run) or starts the throwaway cluster, and points the PG* variables at it. */
function prepareCluster(dir) {
  const pgPort = option("pg-port", process.env.PGPORT ?? "55510");
  const passwordFile = join(dir, "pw.txt");
  mkdirSync(dir, { recursive: true });
  if (!existsSync(join(dir, "data", "PG_VERSION"))) {
    writeFileSync(passwordFile, randomBytes(18).toString("hex"));
    execFileSync(exe("initdb"), ["-D", join(dir, "data"), "-U", "kip_qa", "--auth=scram-sha-256", `--pwfile=${passwordFile}`, "-E", "UTF8"], {
      stdio: "ignore",
    });
  }
  const status = spawnSync(exe("pg_ctl"), ["-D", join(dir, "data"), "status"], { stdio: "ignore" });
  if (status.status !== 0) {
    execFileSync(exe("pg_ctl"), ["-D", join(dir, "data"), "-l", join(dir, "server.log"), "-o", `-p ${pgPort} -c listen_addresses=127.0.0.1`, "-w", "start"], {
      stdio: "ignore",
    });
  }
  Object.assign(process.env, {
    PGHOST: "127.0.0.1",
    PGPORT: pgPort,
    PGUSER: "kip_qa",
    PGDATABASE: process.env.PGDATABASE ?? "kip_qa_local",
    PGPASSWORD: readFileSync(passwordFile, "utf8").trim(),
  });
  const exists = spawnSync(exe("psql"), ["-d", "postgres", "-qAtc", `SELECT 1 FROM pg_database WHERE datname = '${process.env.PGDATABASE}'`], {
    encoding: "utf8",
    env: process.env,
  });
  if (exists.stdout.trim() !== "1") execFileSync(exe("createdb"), [process.env.PGDATABASE], { stdio: "ignore", env: process.env });
  return { stop: `"${exe("pg_ctl")}" -D "${join(dir, "data")}" stop` };
}

const cluster = pgData ? prepareCluster(resolve(pgData)) : null;
// The adapter enforces a loopback host and a kip_qa_ database, and routes the Neon driver to it.
const { applyMigration, dbUrl, pool } = await import("./qa-postgres-adapter.mjs");
const { createFeedbackWorker } = await import("../worker/index.ts");

async function migrate() {
  const config = JSON.parse(readFileSync(join(ROOT, "deployment.json"), "utf8"));
  // Same order as the release harness. Without --content it skips content sync: visits only need
  // public.parks for the catalogue check, not the content publishing tables.
  const content = withContent ? config.contentSync.migrationPaths : [];
  const paths = [config.migrationPath, "database/001_cloud_content.sql", ...config.optionalMigrationPaths, ...content, ...config.independentMigrationPaths];
  for (const path of paths) await applyMigration(join(ROOT, path));
}

// The dev app reads the staging catalogue, so seed the same park IDs or most visits return
// park_not_found. The bundled list is the offline fallback.
const CATALOGUE_URL = option("catalogue", process.env.LOCAL_CATALOGUE_URL ?? "https://staging.web.parkdex.app/api/content/snapshot");

async function catalogueSnapshot() {
  try {
    const response = await fetch(CATALOGUE_URL, { signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const snapshot = await response.json();
    if (!Array.isArray(snapshot.parks) || snapshot.parks.length === 0) throw new Error("no parks");
    return snapshot;
  } catch (error) {
    console.warn(`Catalogue fetch failed (${error.message}); using the bundled parks.`);
    return { parks: JSON.parse(readFileSync(join(ROOT, "src", "data", "parks.json"), "utf8")) };
  }
}

/** Parks with their boundary, drive settings and one drive row per hub, each in its own transaction. */
async function seedContentParks(snapshot) {
  const hubs = snapshot.drive?.hubs ?? [{ name: "Downtown Victoria", lng: -123.3656, lat: 48.4284 }];
  const boundaries = new Map((snapshot.boundaries?.features ?? []).map((feature) => [feature.properties?.id, feature.geometry]));
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const [position, hub] of hubs.entries()) {
      await client.query("INSERT INTO public.drive_hubs (position, name, lng, lat) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING", [
        position,
        hub.name,
        hub.lng,
        hub.lat,
      ]);
    }
    await client.query("COMMIT");
    let seeded = 0;
    for (const park of snapshot.parks) {
      const geometry = boundaries.get(park.id);
      if (!geometry) continue;
      await client.query("BEGIN");
      // Badge scenes need registered assets, which the local stack does not have.
      const inserted = await client.query(
        `
        INSERT INTO public.parks (id, name, short, category, region, lat, lng, biome, shape, rarity, scene, seed, blurb)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NULL,$11,$12) ON CONFLICT (id) DO NOTHING RETURNING id`,
        [park.id, park.name, park.short, park.category, park.region, park.lat, park.lng, park.biome, park.shape, park.rarity, park.seed, park.blurb],
      );
      if (inserted.rows.length) {
        await client.query("INSERT INTO public.boundaries (park_id, feature) VALUES ($1, $2::jsonb)", [
          park.id,
          JSON.stringify({ type: "Feature", properties: { id: park.id, biome: park.biome }, geometry }),
        ]);
        const drive = snapshot.drive?.parks?.[park.id];
        await client.query("INSERT INTO public.park_drive_settings (park_id, walk_m) VALUES ($1, $2)", [park.id, drive?.walkM ?? 0]);
        for (const position of hubs.keys()) {
          const [km, min] = drive?.drive?.[position] ?? [null, null];
          await client.query("INSERT INTO public.park_drive (park_id, hub_position, distance_km, duration_min) VALUES ($1, $2, $3, $4)", [
            park.id,
            position,
            km,
            min,
          ]);
        }
        seeded += 1;
      }
      await client.query("COMMIT");
    }
    return seeded;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function seedParks() {
  const snapshot = await catalogueSnapshot();
  if (withContent) return seedContentParks(snapshot);
  const parks = snapshot.parks;
  for (const park of parks) {
    await pool.query(
      `
      INSERT INTO public.parks (id, name, short, category, region, lat, lng, biome, shape, rarity, scene, seed, blurb)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT (id) DO NOTHING`,
      [
        park.id,
        park.name,
        park.short,
        park.category,
        park.region,
        park.lat,
        park.lng,
        park.biome,
        park.shape,
        park.rarity,
        park.scene ?? null,
        park.seed,
        park.blurb,
      ],
    );
  }
  return parks.length;
}

async function seedAccounts() {
  const passwordHash = await argonHash(SEED.password, { type: argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1, hashLength: 32 });
  for (const account of SEED.accounts) {
    const email = account.email.toLowerCase();
    if (!email.endsWith("@example.test")) throw new Error("Local stack seed accounts must use @example.test addresses.");
    await pool.query(
      `
      INSERT INTO kip_account.accounts (id, normalized_email, password_hash, display_name, email_verified_at)
      -- Stable per email, with the version 4 and variant bits set: the app rejects other UUID shapes.
      VALUES (overlay(overlay(md5('kip-local-stack:' || $1) placing '4' from 13) placing '8' from 17)::uuid, $1, $2, $3, now())
      ON CONFLICT (normalized_email) DO UPDATE SET password_hash = EXCLUDED.password_hash, deletion_state = 'active'`,
      [email, passwordHash, account.displayName],
    );
    if (account.handle) {
      await pool.query(
        `
        INSERT INTO kip_game.players (account_id, handle, flag_seed)
        SELECT id, $2, kip_game.flag_seed(id) FROM kip_account.accounts WHERE normalized_email = $1
        ON CONFLICT DO NOTHING`,
        [email, account.handle],
      );
    }
  }
  return SEED.accounts.map((account) => account.email);
}

const env = {
  DATABASE_URL: dbUrl,
  AUTH_SESSION_SECRET: SEED.authSessionSecret,
  SESSION_SECRET: SEED.sessionSecret,
  EMAIL_MODE: "disabled",
  PUBLIC_APP_URL: appOrigin,
  ALLOWED_ORIGINS: [appOrigin, "http://127.0.0.1:5190", `http://127.0.0.1:${apiPort}`, `http://localhost:${apiPort}`].join(","),
  RELEASE_SHA: "local",
  OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
  OPENROUTER_MODERATION_MODEL: process.env.OPENROUTER_MODERATION_MODEL,
};

const worker = createFeedbackWorker();
const MAX_BODY = 3 * 1024 * 1024;

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new Error("body too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function handle(req, res) {
  const started = Date.now();
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(", ") : value);
  }
  headers.set("cf-connecting-ip", req.socket.remoteAddress ?? "127.0.0.1");
  const body = req.method === "GET" || req.method === "HEAD" ? undefined : await readBody(req);
  // Keep the Host the browser used (the Vite proxy forwards it), so same-origin checks match the page.
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? `127.0.0.1:${apiPort}`}`);
  const request = new Request(url, { method: req.method, headers, body: body?.length ? body : undefined });
  const response = await worker.fetch(request, env, {
    waitUntil: (promise) => {
      promise.catch(() => undefined);
    },
  });
  res.statusCode = response.status;
  response.headers.forEach((value, key) => {
    if (key !== "set-cookie") res.setHeader(key, value);
  });
  const cookies = response.headers.getSetCookie();
  if (cookies.length) res.setHeader("set-cookie", cookies);
  res.end(Buffer.from(await response.arrayBuffer()));
  process.stdout.write(`${req.method} ${url.pathname} ${response.status} ${Date.now() - started}ms\n`);
}

await migrate();
const parkCount = await seedParks();
const emails = await seedAccounts();

const server = createServer((req, res) => {
  handle(req, res).catch(() => {
    res.statusCode = 503;
    res.end(JSON.stringify({ error: { code: "service_unavailable", message: "Local stack error." } }));
  });
});
server.listen(apiPort, "127.0.0.1", () => {
  process.stdout.write(
    [
      `Parkdex local API on http://127.0.0.1:${apiPort} (database ${process.env.PGDATABASE}, ${parkCount} parks)`,
      `Test accounts (password in scripts/local-stack.seed.json): ${emails.join(", ")}`,
      `App: KIP_LOCAL_API=http://127.0.0.1:${apiPort} npm run dev, then open ${appOrigin}`,
      cluster ? `Stop the cluster later with: ${cluster.stop}` : "",
    ]
      .filter(Boolean)
      .join("\n") + "\n",
  );
});

function shutdown() {
  server.close();
  pool.end().finally(() => process.exit(0));
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
