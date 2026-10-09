import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import pg from 'pg';

// Regression for a CI crash: pool.end() resolves before its connections close, and dropping the
// database WITH (FORCE) then terminates a connection that is still closing. The pool emitted an
// unhandled 'error' and the process died with a dump of the client. The Terminate messages are
// held back here (corked sockets) so the server's termination always wins, as it can on Linux CI.
const shared = process.env.PGDATABASE;
assert.ok(shared?.startsWith('kip_qa_') || shared === 'kip_accounts_qa', 'SQL QA requires a dedicated kip_qa_ database');
const owned = `kip_qa_adapter_${randomBytes(8).toString('hex')}`;
const admin = new pg.Client({ host: process.env.PGHOST, port: Number(process.env.PGPORT), user: process.env.PGUSER, password: process.env.PGPASSWORD, database: shared });
await admin.connect();
await admin.query(`CREATE DATABASE "${owned}"`);
process.env.PGDATABASE = owned;
const { pool } = await import('./qa-postgres-adapter.mjs');

try {
  await Promise.all(Array.from({ length: 8 }, () => pool.query('SELECT pg_sleep(0.01)')));
  const clients = [...pool._clients];
  assert.ok(clients.length > 1);
  for (const client of clients) client.connection.stream.cork();
  await pool.end();
  await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1', [owned]);
  for (const client of clients) client.connection.stream.uncork();
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(process.exitCode ?? 0, 0, 'a connection closed while the pool is ending is not a failure');
  process.stdout.write('a connection terminated while the pool is closing does not crash SQL QA: PASS\n');
} finally {
  await admin.query(`DROP DATABASE IF EXISTS "${owned}" WITH (FORCE)`);
  await admin.end();
}
