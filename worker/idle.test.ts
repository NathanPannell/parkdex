import assert from "node:assert/strict";
import { test } from "node:test";
import { neonConfig } from "@neondatabase/serverless";
import { createFeedbackWorker } from "./index.ts";

// Neon bills per compute-hour, so an idle API must send no SQL and health checks must never touch
// the database (root AGENTS.md, "Databases must scale to zero when idle"). Every query the API
// sends goes through the Neon driver, which this counts.
test("an idle API and its health check send no database queries", async () => {
  const queries: string[] = [];
  const original = neonConfig.fetchFunction;
  neonConfig.fetchFunction = async (url: string) => {
    queries.push(url);
    return new Response(JSON.stringify({ message: "no database in this test" }), { status: 500 });
  };
  try {
    const worker = createFeedbackWorker();
    const env = {
      DATABASE_URL: "postgresql://idle:idle@db.example.test/idle",
      PUBLIC_APP_URL: "https://app.example.test",
      RELEASE_SHA: "idle-test",
    };
    const background: Promise<unknown>[] = [];
    const context = { waitUntil: (promise: Promise<unknown>) => background.push(promise) };

    // Idle: nothing may run on a timer after the worker is created.
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.deepEqual(queries, [], "the API queried the database while idle");

    for (let check = 0; check < 3; check += 1) {
      const response = await worker.fetch(new Request("https://app.example.test/api/health"), env as never, context as never);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { ok: true, releaseSha: "idle-test" });
    }
    await Promise.allSettled(background);
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.deepEqual(queries, [], "a health check queried the database");
  } finally {
    neonConfig.fetchFunction = original;
  }
});
