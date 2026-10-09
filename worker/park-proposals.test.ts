import assert from "node:assert/strict";
import { test } from "node:test";
import { createFeedbackWorker } from "./index.ts";
import { PROPOSALS_RETIRED_MESSAGE } from "./parkProposals.ts";

const API_ORIGIN = "https://api.example.test";
const SECRET = "test-session-secret-which-is-long-enough";
const env = { SESSION_SECRET: SECRET, PUBLIC_APP_URL: API_ORIGIN } as never;

function request(path: string, options: { method?: string; body?: unknown; origin?: string } = {}) {
  const headers = new Headers({ "cf-connecting-ip": "203.0.113.5" });
  if (options.origin) headers.set("origin", options.origin);
  if (options.body !== undefined) headers.set("content-type", "application/json");
  return new Request(`${API_ORIGIN}${path}`, { method: options.method ?? "GET", headers, body: options.body === undefined ? undefined : JSON.stringify(options.body) });
}

const proposal = {
  submissionId: "6f1c2f0e-3a4b-4c5d-8e9f-0a1b2c3d4e5f",
  name: "Cedar Hill Woods",
  note: "Small forest trail behind the rec centre",
  point: [-123.3401234567, 48.4612345678],
  outline: null,
  context: { platform: "android", version: "1.4.0", build: "14" },
};

test("anonymous proposals are retired: installed builds get 410 with a message they show", async () => {
  const worker = createFeedbackWorker();
  const response = await worker.fetch(request("/api/park-proposals", { method: "POST", body: proposal, origin: "https://localhost" }), env);
  assert.equal(response.status, 410);
  assert.equal(response.headers.get("access-control-allow-origin"), "https://localhost");
  const body = await response.json() as { code: string; message: string };
  assert.equal(body.code, "proposals_retired");
  assert.equal(body.message, PROPOSALS_RETIRED_MESSAGE);
  // src/lib/parkProposal.ts shows messages of up to 200 characters as the error.
  assert.ok(body.message.length <= 200);
  assert.equal((await worker.fetch(request("/api/park-proposals"), env)).status, 405);
});

test("the app no longer lists or reviews proposals; the operator dashboard does", async () => {
  const worker = createFeedbackWorker();
  assert.equal((await worker.fetch(request("/api/operator/park-proposals?status=new"), env)).status, 404);
  const patch = await worker.fetch(request("/api/operator/park-proposals/00000000-0000-4000-8000-000000000001", { method: "PATCH", body: { status: "accepted" }, origin: API_ORIGIN }), env);
  assert.equal(patch.status, 404);
});
