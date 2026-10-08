import assert from "node:assert/strict";
import { test } from "node:test";
import { classifySql, database, queryText, resultCode, type SqlClient } from "./db.ts";
import { createRequestContext, runWithRequestContext, type RequestContext } from "./requestContext.ts";

function context(): RequestContext {
  return createRequestContext({ method: "POST", path: "/api/claims", header: () => null, env: {} });
}

test("plain selects are reads and record every schema-qualified table", () => {
  assert.deepEqual(classifySql(`
    SELECT r.id, a.content_type FROM kip_feedback.reports r
    LEFT JOIN kip_feedback.attachments a ON a.report_id = r.id
    WHERE EXISTS (SELECT 1 FROM kip_feedback.email_deliveries d WHERE d.report_id = r.id)`), {
    operation: "read",
    tables: ["kip_feedback.attachments", "kip_feedback.email_deliveries", "kip_feedback.reports"],
  });
  assert.deepEqual(classifySql("SELECT revision FROM public.content_clock, public.parks p WHERE singleton = true"), {
    operation: "read",
    tables: ["public.content_clock", "public.parks"],
  });
});

test("CTE names, aliases and columns are not tables", () => {
  const result = classifySql(`
    WITH attempted AS (SELECT 1), state AS MATERIALIZED (SELECT revision FROM public.content_clock)
    SELECT EXTRACT(EPOCH FROM r.created_at), state.revision FROM attempted JOIN state ON true`);
  assert.deepEqual(result, { operation: "read", tables: ["public.content_clock"] });
});

test("insert, update, delete and upserts are writes", () => {
  assert.equal(classifySql("INSERT INTO kip_account.rate_limits (action, scope_hash) VALUES ($1, $2)").operation, "write");
  assert.deepEqual(classifySql("INSERT INTO kip_account.rate_limits (action) VALUES ($1)").tables, ["kip_account.rate_limits"]);
  assert.equal(classifySql("UPDATE kip_feedback.reports SET status = $1 WHERE id = $2").operation, "write");
  assert.equal(classifySql("DELETE FROM kip_analytics.events e USING candidates c WHERE e.event_id = c.event_id").operation, "write");
  assert.equal(classifySql("WITH x AS (DELETE FROM kip_analytics.rate_limits RETURNING 1) SELECT count(*) FROM x").operation, "write");
  assert.equal(classifySql("SELECT nextval('kip_account.progress_change_seq')").operation, "write");
});

test("row locks and ON CONFLICT DO UPDATE do not make a read a write by themselves", () => {
  assert.equal(classifySql("SELECT id FROM kip_account.accounts WHERE id = $1 FOR UPDATE").operation, "read");
  assert.equal(classifySql("SELECT id FROM kip_account.accounts FOR NO KEY UPDATE SKIP LOCKED").operation, "read");
  assert.equal(classifySql("SELECT 1 FROM kip_account.accounts FOR UPDATE OF accounts").operation, "read");
  const upsert = classifySql(`INSERT INTO kip_app_config.update_rules (environment) VALUES ($1)
    ON CONFLICT (environment) DO UPDATE SET minimum_build = EXCLUDED.minimum_build
    RETURNING kip_app_config.update_rules.environment`);
  assert.deepEqual(upsert, { operation: "write", tables: ["kip_app_config.update_rules"] });
});

test("keywords inside literals and comments are ignored", () => {
  const result = classifySql(`
    -- DELETE FROM kip_account.accounts
    /* UPDATE kip_account.sessions SET x = 1 */
    SELECT 'insert into kip_account.accounts' AS label, $tag$ drop table kip_x.y $tag$ FROM kip_account.sessions`);
  assert.deepEqual(result, { operation: "read", tables: ["kip_account.sessions"] });
});

test("calls to listed write functions count as writes, other functions as reads", () => {
  const result = classifySql("SELECT kip_game.record_visit($1::uuid, $2::uuid, $3, $4::timestamptz) AS result");
  assert.deepEqual(result, { operation: "write", tables: ["kip_game.record_visit"] });
  assert.deepEqual(classifySql("SELECT rank, handle FROM kip_game.leaderboard($1::timestamptz)"), { operation: "read", tables: ["kip_game.leaderboard"] });
  assert.deepEqual(classifySql(`SELECT t.park_id, kip_game.holding_points(t.started_at, t.last_visit_at, t.ended_at, $2::timestamptz) AS days
    FROM kip_game.tenures t WHERE kip_game.flag_up(t.last_visit_at, t.ended_at, $2::timestamptz)`).operation, "read");
  assert.equal(classifySql("INSERT INTO kip_game.players (account_id, flag_seed) SELECT a.id, kip_game.flag_seed(a.id) FROM kip_account.accounts a").operation, "write");
  assert.equal(classifySql("SELECT hashtextextended($1, 0), jsonb_to_recordset($2::jsonb)").operation, "read");
});

test("query text keeps template skeletons, nested templates and never values", () => {
  const nested = { strings: ["kip_account.claims WHERE id = ", ""], values: ["secret-claim"] };
  const text = queryText({ strings: ["SELECT * FROM ", " JOIN kip_account.photos p ON true WHERE email = ", ""], values: [nested, "a@b.test"] });
  assert.doesNotMatch(text, /secret-claim|a@b\.test/);
  assert.match(text, /kip_account\.claims/);
  assert.equal(queryText({ query: "SELECT 1", params: ["x"] }), "SELECT 1");
  assert.equal(queryText(null), "");
});

test("result codes keep only SQLSTATE values", () => {
  assert.equal(resultCode({ code: "23505", message: "duplicate key value violates email a@b.test" }), "23505");
  assert.equal(resultCode(new Error("connection to postgres://user:pass@host failed")), "error");
  assert.equal(resultCode({ name: "AbortError" }), "aborted");
});

type Executed = { queryData: unknown };

/** A stand-in for neon() that runs nothing and returns canned rows. */
function fakeNeon(behaviour: { fail?: unknown; delayMs?: number } = {}) {
  const executed: Executed[] = [];
  const transactions: unknown[][] = [];
  const run = async (queryData: unknown) => {
    executed.push({ queryData });
    if (behaviour.delayMs) await new Promise((resolve) => setTimeout(resolve, behaviour.delayMs));
    if (behaviour.fail) throw behaviour.fail;
    return [{ ok: true }];
  };
  const lazy = (queryData: unknown) => {
    const promise = {
      execute: (data: unknown) => run(data),
      queryData,
      then(resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) { return promise.execute(queryData).then(resolve, reject); },
      catch(reject: (reason: unknown) => unknown) { return promise.execute(queryData).catch(reject); },
      finally(done: () => void) { return promise.execute(queryData).finally(done); },
    };
    return promise;
  };
  const raw = ((strings: TemplateStringsArray, ...values: unknown[]) => lazy({ strings: [...strings], values })) as unknown as SqlClient;
  raw.query = ((query: string, params: unknown[]) => lazy({ query, params })) as unknown as SqlClient["query"];
  raw.unsafe = ((text: string) => ({ sql: text })) as unknown as SqlClient["unsafe"];
  raw.transaction = (async (input: Array<{ queryData: unknown }> | ((txn: SqlClient) => Array<{ queryData: unknown }>)) => {
    const queries = typeof input === "function" ? input(raw) : input;
    transactions.push(queries.map((query) => query.queryData));
    if (behaviour.delayMs) await new Promise((resolve) => setTimeout(resolve, behaviour.delayMs));
    if (behaviour.fail) throw behaviour.fail;
    return queries.map(() => [{ ok: true }]);
  }) as unknown as SqlClient["transaction"];
  return { raw, executed, transactions };
}

test("the wrapper records one timed read per standalone query without parameters", async () => {
  const fake = fakeNeon({ delayMs: 15 });
  const sql = database("postgresql://ignored", () => fake.raw);
  const request = context();
  const email = "player@example.test";
  const rows = await runWithRequestContext(request, async () => sql`SELECT id FROM kip_account.accounts WHERE email = ${email}`);
  assert.deepEqual(rows, [{ ok: true }]);
  assert.equal(fake.executed.length, 1);
  assert.equal(request.events.length, 1);
  const [event] = request.events;
  assert.equal(event.type, "db_read");
  assert.deepEqual(event.tables, ["kip_account.accounts"]);
  assert.equal(event.result, "ok");
  assert.ok((event.durationMs ?? 0) >= 10, `duration ${event.durationMs}`);
  assert.doesNotMatch(JSON.stringify(request), /player@example\.test|SELECT|postgresql/);
});

test("sql.query writes are recorded as writes", async () => {
  const fake = fakeNeon();
  const sql = database("postgresql://ignored", () => fake.raw);
  const request = context();
  await runWithRequestContext(request, () => sql.query("UPDATE kip_feedback.reports SET status = $1", ["closed"]));
  assert.equal(request.events[0].type, "db_write");
  assert.equal(request.events[0].operation, "write");
});

test("a failed query records its error code and still rejects", async () => {
  const fake = fakeNeon({ fail: Object.assign(new Error("duplicate key for a@b.test"), { code: "23505" }) });
  const sql = database("postgresql://ignored", () => fake.raw);
  const request = context();
  await assert.rejects(runWithRequestContext(request, () => sql`INSERT INTO kip_account.accounts (email) VALUES (${"a@b.test"})`), /duplicate/);
  assert.equal(request.events.length, 1);
  assert.equal(request.events[0].result, "23505");
  assert.doesNotMatch(JSON.stringify(request.events), /a@b\.test/);
});

test("a transaction is one event covering every statement, and its queries are not double counted", async () => {
  const fake = fakeNeon();
  const sql = database("postgresql://ignored", () => fake.raw);
  const request = context();
  await runWithRequestContext(request, () => sql.transaction([
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${"x"}, 0))`,
    sql`INSERT INTO kip_feedback.reports (id) SELECT ${"id"} FROM kip_feedback.rate_limits`,
  ]));
  assert.equal(fake.executed.length, 0, "transaction members are not executed on their own");
  assert.equal(fake.transactions.length, 1);
  assert.equal(request.events.length, 1);
  assert.equal(request.events[0].type, "db_write");
  assert.deepEqual(request.events[0].tables, ["kip_feedback.rate_limits", "kip_feedback.reports"]);
});

test("function-form transactions are classified from the statements they return", async () => {
  const fake = fakeNeon();
  const sql = database("postgresql://ignored", () => fake.raw);
  const request = context();
  await runWithRequestContext(request, () => sql.transaction((txn) => [txn`SELECT 1 FROM public.parks`]));
  assert.equal(request.events.length, 1);
  assert.equal(request.events[0].type, "db_read");
});

test("queries outside a request run normally and record nothing", async () => {
  const fake = fakeNeon();
  const sql = database("postgresql://ignored", () => fake.raw);
  assert.deepEqual(await sql`SELECT 1 FROM public.parks`, [{ ok: true }]);
  assert.equal(fake.executed.length, 1);
});
