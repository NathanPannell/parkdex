import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createNeonInteractionStore } from '../worker/interactions.ts';
import { createAnalyticsSink } from '../worker/analyticsSink.ts';
import { database } from '../worker/db.ts';
import { createRequestContext, emitEvent, runWithRequestContext, setRequestAccount } from '../worker/requestContext.ts';
import { createFeedbackWorker } from '../worker/index.ts';
import { applyMigration, dbUrl, pool } from './qa-postgres-adapter.mjs';

const migration = (name) => fileURLToPath(new URL(`../database/migrations/${name}`, import.meta.url));
const log = (name) => process.stdout.write(`${name}: PASS\n`);
const digest = (value) => createHash('sha256').update(value).digest('hex');
const requestIds = new Set();
const eventIds = new Set();
const installation = randomUUID();
const account = randomUUID();

function context(path, headers = {}) {
  const map = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  const value = createRequestContext({ method: 'POST', path, header: (name) => map.get(name.toLowerCase()) ?? null, env: { CONTENT_CHANNEL: 'staging' } });
  requestIds.add(value.requestId);
  return value;
}

function interaction() {
  return {
    eventId: randomUUID(), installationId: installation, sessionId: randomUUID(), occurredAt: new Date().toISOString(),
    schemaVersion: 1, appVersion: 'qa-1', appBuild: 'analytics-qa', contentReleaseId: 'e'.repeat(64),
    environment: 'preview', parkId: 'provincial-goldstream-park', type: 'park_claimed',
    claimId: randomUUID(), claimStatus: 'first',
  };
}

async function rejectsWithCheck(sql, params) {
  await assert.rejects(pool.query(sql, params), (error) => error.code === '23514' || error.code === '23502');
}

try {
  // A database that already has the original table, then the new migration twice, as on deploy.
  await applyMigration(migration('interactions_001_init.sql'));
  const legacy = interaction();
  eventIds.add(legacy.eventId);
  const store = createNeonInteractionStore(dbUrl);
  assert.deepEqual(await store.saveBatch([{ event: legacy, payloadHash: digest(JSON.stringify(legacy)) }]), { inserted: 1, conflictingEventIds: [] });
  for (let run = 0; run < 2; run += 1) {
    await applyMigration(migration('interactions_001_init.sql'));
    await applyMigration(migration('interactions_002_db_events.sql'));
  }
  const constraints = await pool.query(`SELECT conname FROM pg_constraint
    WHERE conrelid = 'kip_analytics.events'::regclass AND contype = 'c' ORDER BY conname`);
  const names = constraints.rows.map((row) => row.conname);
  for (const name of ['events_event_type_v2_check', 'events_server_fields_v1_check', 'events_shape_v2_check']) assert.ok(names.includes(name), name);
  for (const name of ['events_event_type_check', 'events_check']) assert.ok(!names.includes(name), name);
  assert.equal(names.length, new Set(names).size);
  log('interactions migrations apply twice over existing rows');

  const replay = interaction();
  eventIds.add(replay.eventId);
  assert.deepEqual(await store.saveBatch([{ event: replay, payloadHash: digest(JSON.stringify(replay)) }]), { inserted: 1, conflictingEventIds: [] });
  await rejectsWithCheck(`INSERT INTO kip_analytics.events (event_id, event_type, installation_id, client_occurred_at, schema_version,
      app_version, app_build, content_release_id, environment, park_id, entry_point, payload_hash)
    VALUES ($1, 'park_viewed', $2, now(), 1, 'qa', 'qa', $3, 'preview', 'p', 'map', $3)`, [randomUUID(), installation, 'a'.repeat(64)]);
  log('older builds keep inserting interaction events and still need their session fields');

  // Real queries through the wrapper inside a request, flushed by the real writer.
  const sql = database(dbUrl);
  const request = context('/api/game/visits', { 'X-Kip-Installation-Id': installation, 'X-Kip-App-Version': '0.1.0', 'X-Kip-Bundle-Id': 'qa-bundle' });
  await runWithRequestContext(request, async () => {
    setRequestAccount(account);
    await sql`SELECT count(*) FROM kip_analytics.rate_limits WHERE subject_hash = ${'private-value'}`;
    await sql.transaction([
      sql`SELECT pg_advisory_xact_lock(1)`,
      sql`DELETE FROM kip_analytics.rate_limits WHERE subject_hash = ${'private-value'}`,
    ]);
    await assert.rejects(sql`SELECT * FROM kip_analytics.missing_table`);
    emitEvent('flag_planted', { parkId: 'provincial-goldstream-park', pointsEarned: 0 });
  });
  assert.equal(request.events.length, 4);
  await createAnalyticsSink({ DATABASE_URL: dbUrl }).write(request);
  const rows = await pool.query(`SELECT event_type, operation, tables, result, route, account_id, installation_id,
      app_version, bundle_id, environment, park_id, properties, duration_ms
    FROM kip_analytics.events WHERE request_id = $1 ORDER BY occurred_at, event_type`, [request.requestId]);
  assert.deepEqual(rows.rows.map((row) => [row.event_type, row.result]), [
    ['db_read', 'ok'], ['db_write', 'ok'], ['db_read', '42P01'], ['flag_planted', null],
  ]);
  assert.deepEqual(rows.rows[1].tables, ['kip_analytics.rate_limits']);
  for (const row of rows.rows) {
    assert.equal(row.route, 'POST /api/game/visits');
    assert.equal(row.account_id, account);
    assert.equal(row.installation_id, installation);
    assert.equal(row.environment, 'staging');
    assert.equal(row.bundle_id, 'qa-bundle');
  }
  assert.equal(rows.rows[3].park_id, 'provincial-goldstream-park');
  assert.deepEqual(rows.rows[3].properties, { points_earned: 0 });
  assert.doesNotMatch(JSON.stringify(rows.rows), /private-value/);
  const recordedInsert = await pool.query(`SELECT count(*)::int AS n FROM kip_analytics.events
    WHERE request_id = $1 AND 'kip_analytics.events' = ANY(tables)`, [request.requestId]);
  assert.equal(recordedInsert.rows[0].n, 0, 'the analytics insert itself is not recorded');
  log('wrapped queries, a transaction, a failure and a game event land as one batch');

  await rejectsWithCheck(`INSERT INTO kip_analytics.events (event_id, event_type, environment, schema_version, operation, tables, duration_ms, result, route, request_id, occurred_at)
    VALUES ($1, 'db_read', 'staging', 1, 'write', '{}', 1, 'ok', 'GET /api', $2, now())`, [randomUUID(), randomUUID()]);
  await rejectsWithCheck(`INSERT INTO kip_analytics.events (event_id, event_type, environment, schema_version, operation, tables, duration_ms, result, route, request_id, occurred_at)
    VALUES ($1, 'db_read', 'staging', 1, 'read', '{}', 1, 'ok', 'GET /api/a@b.test', $2, now())`, [randomUUID(), randomUUID()]);
  await rejectsWithCheck(`INSERT INTO kip_analytics.events (event_id, event_type, environment, schema_version, route, request_id, occurred_at, duration_ms)
    VALUES ($1, 'flag_taken', 'staging', 1, 'POST /api/game/visits', $2, now(), 3)`, [randomUUID(), randomUUID()]);
  await rejectsWithCheck(`INSERT INTO kip_analytics.events (event_id, event_type, environment, schema_version, route, request_id, occurred_at)
    VALUES ($1, 'something_else', 'staging', 1, 'POST /api', $2, now())`, [randomUUID(), randomUUID()]);
  log('type, shape and label checks reject malformed server events');

  // The real router and app config store, end to end: request labels in, rows out after waitUntil.
  await applyMigration(migration('app_config_001_init.sql'));
  await applyMigration(migration('app_config_002_global_rules.sql'));
  const pending = [];
  const response = await createFeedbackWorker().fetch(new Request('https://kip.example.test/api/app-config?platform=android&build=7&env=staging', {
    headers: { 'X-Kip-Installation-Id': installation, 'X-Kip-App-Version': '0.1.0+7', 'X-Kip-Bundle-Id': 'qa-router' },
  }), { DATABASE_URL: dbUrl, CONTENT_CHANNEL: 'staging' }, { waitUntil: (promise) => pending.push(promise) });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).analytics, null);
  assert.equal(pending.length, 1);
  await Promise.all(pending);
  const routed = await pool.query(`SELECT request_id, event_type, tables, app_version FROM kip_analytics.events
    WHERE installation_id = $1 AND route = 'GET /api/app-config' ORDER BY occurred_at`, [installation]);
  assert.deepEqual(routed.rows.map((row) => [row.event_type, row.tables]), [
    ['db_read', ['kip_app_config.builds']], ['db_read', ['kip_app_config.update_rules']],
  ]);
  assert.ok(routed.rows.every((row) => row.app_version === '0.1.0+7'));
  for (const row of routed.rows) requestIds.add(row.request_id);
  log('the API router records its app config reads after the response');

  // Age every QA row past the 90-day window and confirm the existing purge removes old and new types.
  await pool.query(`UPDATE kip_analytics.events SET received_at = now() - interval '91 days'
    WHERE event_id = ANY($1::uuid[]) OR request_id = ANY($2::uuid[])`, [[...eventIds], [...requestIds]]);
  const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
  const purged = await store.purgeExpired(cutoff, 5000);
  assert.ok(purged.deleted >= 6, `purged ${purged.deleted}`);
  assert.equal(purged.remainingExpired, 0);
  const left = await pool.query(`SELECT count(*)::int AS n FROM kip_analytics.events
    WHERE event_id = ANY($1::uuid[]) OR request_id = ANY($2::uuid[])`, [[...eventIds], [...requestIds]]);
  assert.equal(left.rows[0].n, 0);
  log('retention purge removes expired interaction and server events');
} finally {
  await pool.query('DELETE FROM kip_analytics.events WHERE event_id = ANY($1::uuid[]) OR request_id = ANY($2::uuid[])', [[...eventIds], [...requestIds]]).catch(() => undefined);
  await pool.end();
}
