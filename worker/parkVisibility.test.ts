import assert from "node:assert/strict";
import { test } from "node:test";
import type { SqlClient } from "./db.js";
import { HIDDEN_PARKS_SQL, hiddenParks, isParkHidden } from "./parkVisibility.js";

function client(query: (text: string, params: unknown[]) => Promise<unknown>): SqlClient {
  return { query } as unknown as SqlClient;
}

test("hidden park lookups ask once with unique ids and read the reason and source", async () => {
  const calls: unknown[][] = [];
  const sql = client(async (text, params) => {
    calls.push([text, params]);
    return [{ park_id: "municipal-a", reason: "Less dense map.", source: "category" }];
  });
  const found = await hiddenParks(sql, ["municipal-a", "provincial-b", "municipal-a"]);
  assert.deepEqual(calls, [[HIDDEN_PARKS_SQL, [["municipal-a", "provincial-b"]]]]);
  assert.deepEqual([...found.values()], [{ parkId: "municipal-a", reason: "Less dense map.", source: "category" }]);
  assert.equal(await isParkHidden(sql, "municipal-a"), true);
  assert.equal((await hiddenParks(sql, [])).size, 0);
});

test("a database without the visibility migration hides nothing, and other errors still fail", async () => {
  const missing = client(async () => {
    throw Object.assign(new Error("relation does not exist"), { code: "42P01" });
  });
  assert.equal(await isParkHidden(missing, "municipal-a"), false);
  const broken = client(async () => {
    throw Object.assign(new Error("connection"), { code: "08006" });
  });
  await assert.rejects(isParkHidden(broken, "municipal-a"));
});
