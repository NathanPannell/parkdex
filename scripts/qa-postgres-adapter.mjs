import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { neonConfig } from '@neondatabase/serverless';

const config = {
  host: process.env.PGHOST,
  port: Number(process.env.PGPORT),
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  database: process.env.PGDATABASE,
};
assert.ok(['127.0.0.1', 'localhost', '::1'].includes(config.host), 'SQL QA only accepts a loopback PostgreSQL host');
assert.ok(Number.isInteger(config.port) && config.port > 0 && config.port < 65536, 'SQL QA requires a valid PGPORT');
assert.ok(config.database === 'kip_accounts_qa' || config.database?.startsWith('kip_qa_'), 'SQL QA requires a dedicated kip_qa_ database');
assert.ok(config.user && config.password, 'SQL QA requires PGUSER and PGPASSWORD');
export const pool = new pg.Pool({ ...config, max: 16 });
// An idle connection that the server closes makes the pool emit 'error'. Unhandled, that kills the
// process with a dump of the whole client and no readable message. pool.end() resolves before its
// connections have closed, so a script that then drops its database WITH (FORCE) can have the
// server terminate a connection that is still closing (57P01): expected, so ignore it once ending.
// Any other idle error fails the run with a one-line reason.
pool.on('error', (error) => {
  if (pool.ending) return;
  process.exitCode = 1;
  console.error(`SQL QA: an idle PostgreSQL connection failed: ${error.code ?? ''} ${error.message}`);
});
export const dbUrl = `postgresql://${encodeURIComponent(config.user)}:${encodeURIComponent(config.password)}@${config.host}:${config.port}/${config.database}`;
const identityTypes = { getTypeParser: () => (value) => value };

function neonResult(result) {
  return { fields: result.fields.map(({ name, dataTypeID }) => ({ name, dataTypeID })), rows: result.rows, rowCount: result.rowCount };
}

neonConfig.fetchFunction = async (_url, init) => {
  const body = JSON.parse(init.body);
  const client = await pool.connect();
  try {
    if (Array.isArray(body.queries)) {
      await client.query('BEGIN');
      const results = [];
      for (const query of body.queries) {
        results.push(neonResult(await client.query({ text: query.query, values: query.params, rowMode: 'array', types: identityTypes })));
      }
      await client.query('COMMIT');
      return new Response(JSON.stringify({ results }), { status: 200 });
    }
    const result = await client.query({ text: body.query, values: body.params, rowMode: 'array', types: identityTypes });
    return new Response(JSON.stringify(neonResult(result)), { status: 200 });
  } catch (error) {
    if (Array.isArray(body.queries)) await client.query('ROLLBACK').catch(() => undefined);
    return new Response(JSON.stringify({ message: error.message, code: error.code, detail: error.detail, constraint: error.constraint }), { status: 400 });
  } finally {
    client.release();
  }
};

export async function applyMigration(path) {
  await pool.query(await readFile(path, 'utf8'));
}
