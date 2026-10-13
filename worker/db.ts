import { neon, type NeonQueryFunction, type NeonQueryPromise } from "@neondatabase/serverless";
import { currentRequestContext, recordDbQuery, type RequestContext } from "./requestContext.js";

/**
 * The one database client for API stores. It behaves exactly like `neon(databaseUrl)` and
 * records each query (or transaction) as a db_read or db_write event on the current request:
 * which tables it touched, how long it took and whether it failed. Only table names derived
 * from the SQL text are kept; SQL text, parameters and connection details are never recorded.
 */

export type SqlOperation = "read" | "write";
export type SqlClassification = { operation: SqlOperation; tables: string[] };
export type SqlClient = NeonQueryFunction<false, false>;

// Every table in this codebase is schema-qualified, which also keeps aliases and columns out.
const QUALIFIED_NAME = /\b((?:public|kip_[a-z0-9_]+)\.[a-z_][a-z0-9_]*)\b(\s*\()?/g;
const WRITE_STATEMENTS = [
  /\binsert into\b/,
  /\bdelete from\b/,
  /\bmerge into\b/,
  /\btruncate\b/,
  /\b(?:create|alter|drop)\s+(?:or replace\s+)?(?:unique\s+)?(?:table|index|schema|view|function|trigger|sequence|type|extension|materialized view)\b/,
  // UPDATE as a statement, not FOR UPDATE row locks or ON CONFLICT DO UPDATE.
  /(?<!\bfor )(?<!\bdo )(?<!\bkey )\bupdate (?:only )?(?!set\b)[a-z_]/,
  /\b(?:nextval|setval)\s*\(/,
];
/**
 * Database functions that change data. Other function calls (scores, flags, leaderboards) are
 * reads. Add a function here when it writes, or its calls will be counted as reads.
 */
export const WRITE_FUNCTIONS = new Set(["kip_game.record_visit", "kip_game.join_crew"]);
const MAX_TABLES = 16;
const CACHE_LIMIT = 500;
const classificationCache = new Map<string, SqlClassification>();

/** Remove comments, string literals and quoted identifiers so keywords inside them do not count. */
function stripSql(text: string): string {
  return text
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\$([A-Za-z_][A-Za-z0-9_]*)?\$[\s\S]*?\$\1\$/g, " '' ")
    .replace(/'(?:[^']|'')*'/g, " '' ")
    .replace(/"(?:[^"]|"")*"/g, " ident ")
    .toLowerCase()
    .replace(/\s+/g, " ");
}

/**
 * Read or write, plus the schema-qualified tables and functions a statement names. A call to a
 * function in WRITE_FUNCTIONS counts as a write, because game rules run as database functions.
 */
export function classifySql(text: string): SqlClassification {
  const cached = classificationCache.get(text);
  if (cached) return cached;
  const sql = stripSql(text);
  const tables = new Set<string>();
  let write = WRITE_STATEMENTS.some((pattern) => pattern.test(sql));
  for (const match of sql.matchAll(QUALIFIED_NAME)) {
    const name = match[1];
    // "INSERT INTO kip_x.t (" is a column list, not a function call.
    const before = sql.slice(Math.max(0, (match.index ?? 0) - 6), match.index);
    const isCall = Boolean(match[2]) && !/\b(?:into|table) $/.test(before);
    if (isCall && WRITE_FUNCTIONS.has(name)) write = true;
    if (tables.size < MAX_TABLES) tables.add(name);
  }
  const result: SqlClassification = { operation: write ? "write" : "read", tables: [...tables].sort() };
  if (classificationCache.size >= CACHE_LIMIT) classificationCache.clear();
  classificationCache.set(text, result);
  return result;
}

export function mergeClassifications(items: SqlClassification[]): SqlClassification {
  const tables = new Set(items.flatMap((item) => item.tables));
  return {
    operation: items.some((item) => item.operation === "write") ? "write" : "read",
    tables: [...tables].sort().slice(0, MAX_TABLES),
  };
}

type QueryData = { query?: unknown; strings?: unknown; values?: unknown };

/** The SQL skeleton of a neon query: placeholders only, never values (nested templates included). */
export function queryText(queryData: unknown): string {
  if (!queryData || typeof queryData !== "object") return "";
  const data = queryData as QueryData;
  if (typeof data.query === "string") return data.query;
  if (Array.isArray(data.strings)) {
    const nested = Array.isArray(data.values)
      ? data.values.map((value) => (value && typeof value === "object" && "strings" in value ? queryText(value) : "")).join(" ")
      : "";
    return `${data.strings.join(" $0 ")} ${nested}`;
  }
  return "";
}

/** A SQLSTATE code when the database rejected the query, otherwise a generic label. */
export function resultCode(error: unknown): string {
  const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
  if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
  if (error && typeof error === "object" && (error as { name?: unknown }).name === "AbortError") return "aborted";
  return "error";
}

async function timed<T>(context: RequestContext | undefined, classify: () => SqlClassification, run: () => Promise<T>): Promise<T> {
  const startedAt = Date.now();
  const started = performance.now();
  let result = "ok";
  try {
    return await run();
  } catch (error) {
    result = resultCode(error);
    throw error;
  } finally {
    try {
      const { operation, tables } = classify();
      recordDbQuery({ operation, tables, durationMs: performance.now() - started, result, startedAt }, context);
    } catch {
      // Recording is best effort and must never change a query's outcome.
    }
  }
}

type AnyQueryPromise = NeonQueryPromise<false, false>;

// Queries are lazy: they run on then/catch/finally through `execute`, while a transaction reads
// only their `queryData`. Timing `execute` therefore records standalone queries exactly once
// and leaves queries passed to a transaction to the transaction's own record.
// The request is captured when the query is built, so a query awaited later still counts for it.
function instrument<T extends AnyQueryPromise>(promise: T): T {
  const execute = promise.execute;
  const context = currentRequestContext();
  promise.execute = ((queryData, opts) => timed(context, () => classifySql(queryText(queryData)), () => execute(queryData, opts))) as typeof execute;
  return promise;
}

export function database(databaseUrl: string, create: (url: string) => SqlClient = (url) => neon(url)): SqlClient {
  const raw = create(databaseUrl);
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => instrument(raw(strings, ...values))) as SqlClient;
  sql.query = ((text: string, params?: unknown[], opts?: unknown) =>
    instrument((raw.query as (...args: unknown[]) => AnyQueryPromise)(text, params, opts))) as SqlClient["query"];
  sql.unsafe = (rawSql: string) => raw.unsafe(rawSql);
  sql.transaction = ((queries: unknown, opts?: unknown) => {
    let texts: string[] = [];
    const collect = (list: Array<{ queryData?: unknown }>) => {
      texts = list.map((item) => queryText(item?.queryData));
      return list;
    };
    const input = typeof queries === "function"
      ? (txn: unknown) => collect((queries as (txn: unknown) => Array<{ queryData?: unknown }>)(txn))
      : collect(queries as Array<{ queryData?: unknown }>);
    return timed(
      currentRequestContext(),
      () => mergeClassifications(texts.map(classifySql)),
      () => (raw.transaction as (...args: unknown[]) => Promise<unknown>)(input, opts),
    );
  }) as SqlClient["transaction"];
  return sql;
}
