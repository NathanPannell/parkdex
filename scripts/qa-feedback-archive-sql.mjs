// End-to-end check of the operator feedback archive against a real PostgreSQL database: the board
// leaves archived reports out, "Clear done" archives only done reports still on the board, the
// archive search and restore, and the daily retention purge that deletes archived reports (with
// their screenshots and email rows) 90 days after archiving. It runs in its own throwaway
// database because "Clear done" archives every done report it can see.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const baseDatabase = process.env.PGDATABASE;
assert.ok(['127.0.0.1', 'localhost', '::1'].includes(process.env.PGHOST), 'SQL QA only accepts a loopback PostgreSQL host');
assert.ok(baseDatabase === 'kip_accounts_qa' || baseDatabase?.startsWith('kip_qa_'), 'SQL QA requires a dedicated kip_qa_ database');
const database = `kip_qa_feedback_${randomBytes(4).toString('hex')}`;
const admin = new pg.Client({ host: process.env.PGHOST, port: Number(process.env.PGPORT), user: process.env.PGUSER, password: process.env.PGPASSWORD, database: baseDatabase });
const log = (name) => process.stdout.write(`${name}: PASS\n`);
const migration = (name) => fileURLToPath(new URL(`../database/migrations/${name}`, import.meta.url));
const DAY = 24 * 60 * 60 * 1000;

await admin.connect();
await admin.query(`CREATE DATABASE ${database}`);
process.env.PGDATABASE = database;
const adapter = await import('./qa-postgres-adapter.mjs');
const archive = await import('../worker/feedbackArchive.ts');
const pool = adapter.pool;

async function report({ status = 'new', createdDaysAgo = 1, archivedDaysAgo = null, message = 'A QA report.', parkName = null, screenshot = false }) {
  const id = randomUUID();
  const createdAt = new Date(Date.now() - createdDaysAgo * DAY).toISOString();
  const archivedAt = archivedDaysAgo === null ? null : new Date(Date.now() - archivedDaysAgo * DAY).toISOString();
  await pool.query(
    `INSERT INTO kip_feedback.reports (id, submission_id, payload_hash, kind, message, email, contact, context, status, created_at, archived_at)
     VALUES ($1, $2, $3, 'bug', $4, NULL, false, $5::jsonb, $6, $7, $8)`,
    [id, randomUUID(), 'a'.repeat(64), message, JSON.stringify({ version: '1.4.0', build: '14', platform: 'android', screen: 'map', parkId: null, parkName }), status, createdAt, archivedAt],
  );
  await pool.query(
    `INSERT INTO kip_feedback.email_deliveries (report_id, audience, recipient, payload, status, idempotency_key)
     VALUES ($1, 'operator', 'operator@example.test', '{}'::jsonb, 'sent', $2)`, [id, `feedback-${id}-operator-v1`],
  );
  if (screenshot) {
    await pool.query("INSERT INTO kip_feedback.attachments (report_id, content_type, content, size_bytes) VALUES ($1, 'image/png', '\\x89504e47'::bytea, 4)", [id]);
  }
  return id;
}

const count = async (table, ids) => Number((await pool.query(`SELECT count(*)::int AS n FROM kip_feedback.${table} WHERE ${table === 'reports' ? 'id' : 'report_id'} = ANY($1::uuid[])`, [ids])).rows[0].n);

try {
  await adapter.applyMigration(migration('feedback_001_init.sql'));
  await adapter.applyMigration(migration('feedback_002_archive.sql'));
  // Migrations replay on every deploy.
  await adapter.applyMigration(migration('feedback_002_archive.sql'));
  const indexes = (await pool.query("SELECT indexname FROM pg_indexes WHERE schemaname = 'kip_feedback' AND tablename = 'reports' ORDER BY indexname")).rows.map((row) => row.indexname);
  assert.ok(indexes.includes('reports_board_idx') && indexes.includes('reports_archived_idx'));
  log('feedback_002 applies and replays');

  const store = archive.createNeonFeedbackArchiveStore(adapter.dbUrl);
  const fresh = await report({ status: 'new', message: 'Map froze near the harbour.' });
  const doneA = await report({ status: 'closed', createdDaysAgo: 3, message: 'Fixed: blurry flag photo.', parkName: 'Cattle Point', screenshot: true });
  const doneB = await report({ status: 'closed', createdDaysAgo: 2, message: 'Answered: 50% of the map is grey.' });
  const alreadyArchived = await report({ status: 'closed', createdDaysAgo: 40, archivedDaysAgo: 10, message: 'Old archived note.' });

  const board = await store.listBoard(31, null, null);
  assert.deepEqual(board.map((item) => item.id).sort(), [fresh, doneA, doneB].sort());
  assert.ok(board.every((item) => item.archivedAt === null));
  assert.deepEqual(await store.liveCounts(), { new: 1, closed: 2 });
  log('the board and its counts leave archived reports out');

  const cleared = await store.archiveDone(500);
  assert.deepEqual(cleared.sort(), [doneA, doneB].sort());
  assert.deepEqual(await store.archiveDone(500), [], 'a second clear finds nothing');
  assert.deepEqual((await store.listBoard(31, null, null)).map((item) => item.id), [fresh]);
  const archived = await store.getReport(doneA);
  assert.equal(archived.status, 'closed');
  assert.ok(archived.archivedAt && Date.now() - Date.parse(archived.archivedAt) < 60_000);
  assert.equal(archived.screenshot?.size, 4);
  log('clear done archives only done reports that are still on the board');

  assert.equal(await store.countArchive(null), 3);
  const firstPage = await store.listArchive(2, null, null);
  assert.equal(firstPage.length, 2);
  const last = firstPage[firstPage.length - 1];
  const secondPage = await store.listArchive(2, null, { createdAt: last.archivedAt, id: last.id });
  assert.deepEqual([...firstPage, ...secondPage].map((item) => item.id).sort(), [doneA, doneB, alreadyArchived].sort());
  assert.equal(secondPage[0].id, alreadyArchived, 'most recently archived first');
  assert.deepEqual((await store.listArchive(10, 'cattle', null)).map((item) => item.id), [doneA]);
  assert.deepEqual((await store.listArchive(10, '50%', null)).map((item) => item.id), [doneB]);
  assert.deepEqual((await store.listArchive(10, '%', null)).map((item) => item.id), [doneB], 'wildcards match literally');
  assert.deepEqual((await store.listArchive(10, doneA.toUpperCase(), null)).map((item) => item.id), [doneA]);
  assert.equal(await store.countArchive('harbour'), 0, 'live reports are not in the archive');
  log('archive search pages newest archived first and matches text literally');

  assert.deepEqual(await store.restore([doneB, fresh]), [doneB], 'only archived reports are restored');
  assert.deepEqual((await store.listBoard(31, 'closed', null)).map((item) => item.id), [doneB]);
  assert.equal(await store.countArchive(null), 2);
  log('restore puts archived reports back in Done');

  const expired = await report({ status: 'closed', createdDaysAgo: 200, archivedDaysAgo: 91, screenshot: true });
  const boundary = await report({ status: 'closed', createdDaysAgo: 200, archivedDaysAgo: 89 });
  const oldLive = await report({ status: 'closed', createdDaysAgo: 400 });
  const run = (text, params) => pool.query(text, params).then((result) => result.rows);
  const cutoff = archive.feedbackRetentionCutoff(Date.now());
  assert.deepEqual(await archive.purgeArchivedFeedback(run, cutoff), { deleted: 1, remainingExpired: 0 });
  assert.equal(await count('reports', [expired]), 0);
  assert.equal(await count('attachments', [expired]), 0, 'the screenshot goes with the report');
  assert.equal(await count('email_deliveries', [expired]), 0, 'email rows go with the report');
  assert.equal(await count('reports', [boundary, oldLive, alreadyArchived, doneA]), 4, 'younger archives and live reports stay');
  log('retention deletes reports archived more than 90 days ago, with their screenshots and emails');

  const backlog = [];
  for (let index = 0; index < 3; index += 1) backlog.push(await report({ status: 'closed', archivedDaysAgo: 120 + index }));
  assert.deepEqual(await archive.purgeArchivedFeedback(run, cutoff, 2), { deleted: 2, remainingExpired: 1 });
  assert.equal(await count('reports', backlog.slice(0, 2)), 1, 'the oldest archives go first');
  assert.deepEqual(await archive.purgeArchivedFeedback(run, cutoff, 2), { deleted: 1, remainingExpired: 0 });
  assert.deepEqual(await archive.purgeArchivedFeedbackFromDatabase(adapter.dbUrl, cutoff), { deleted: 0, remainingExpired: 0 });
  log('a capped purge reports its backlog and finishes on the next run');
} finally {
  await pool.end();
  await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
  await admin.end();
}
