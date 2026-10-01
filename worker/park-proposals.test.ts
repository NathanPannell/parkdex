import assert from "node:assert/strict";
import { test } from "node:test";
import { createFeedbackWorker } from "./index.ts";
import type { ParkProposalRecord, ParkProposalStore, ProposalStatus, SaveProposalResult } from "./parkProposals.ts";

const API_ORIGIN = "https://api.example.test";
const SECRET = "test-session-secret-which-is-long-enough";
const SUBMISSION = "6f1c2f0e-3a4b-4c5d-8e9f-0a1b2c3d4e5f";
let nextId = 0;

class MemoryProposalStore implements ParkProposalStore {
  readonly rows = new Map<string, ParkProposalRecord & { submissionId: string; payloadHash: string }>();
  readonly hits = new Map<string, number>();

  async save({ id, payloadHash, ipHash, proposal }: Parameters<ParkProposalStore["save"]>[0]): Promise<SaveProposalResult> {
    const existing = [...this.rows.values()].find((row) => row.submissionId === proposal.submissionId);
    if (existing) return existing.payloadHash === payloadHash ? { status: "duplicate", proposal: existing } : { status: "conflict" };
    const hits = (this.hits.get(ipHash) ?? 0) + 1;
    this.hits.set(ipHash, hits);
    if (hits > 10) return { status: "rate_limited" };
    const record = {
      id, name: proposal.name, note: proposal.note, point: proposal.point, outline: proposal.outline, context: proposal.context,
      status: "new" as ProposalStatus, createdAt: "", updatedAt: "", submissionId: proposal.submissionId, payloadHash,
    };
    this.rows.set(id, record);
    return { status: "created", proposal: record };
  }

  async list(status: ProposalStatus | null) {
    return [...this.rows.values()].filter((row) => !status || row.status === status);
  }

  async updateStatus(id: string, status: ProposalStatus) {
    const row = this.rows.get(id);
    if (!row) return null;
    row.status = status;
    return row;
  }
}

function setup() {
  const store = new MemoryProposalStore();
  const worker = createFeedbackWorker({
    createParkProposalStore: () => store,
    uuid: () => `00000000-0000-4000-8000-${String(++nextId).padStart(12, "0")}`,
  });
  return { store, worker, env: { SESSION_SECRET: SECRET, PUBLIC_APP_URL: API_ORIGIN } };
}

function request(path: string, options: { method?: string; body?: unknown; cookie?: string; origin?: string; ip?: string } = {}) {
  const headers = new Headers();
  if (options.cookie) headers.set("cookie", options.cookie);
  if (options.origin) headers.set("origin", options.origin);
  headers.set("cf-connecting-ip", options.ip ?? "203.0.113.5");
  if (options.body !== undefined) headers.set("content-type", "application/json");
  return new Request(`${API_ORIGIN}${path}`, { method: options.method ?? "GET", headers, body: options.body === undefined ? undefined : JSON.stringify(options.body) });
}

const proposal = (overrides: Record<string, unknown> = {}) => ({
  submissionId: SUBMISSION,
  name: "  Cedar Hill Woods ",
  note: "Small forest trail behind the rec centre",
  point: [-123.3401234567, 48.4612345678],
  outline: [[-123.341, 48.461], [-123.339, 48.461], [-123.339, 48.462]],
  context: { platform: "android", version: "1.4.0", build: "14", extra: "dropped" },
  ...overrides,
});

test("a proposal from the Android web view is saved once and retries are idempotent", async () => {
  const { store, worker, env } = setup();
  const first = await worker.fetch(request("/api/park-proposals", { method: "POST", body: proposal(), origin: "https://localhost" }), env as never);
  assert.equal(first.status, 201);
  assert.equal(first.headers.get("access-control-allow-origin"), "https://localhost");
  const saved = [...store.rows.values()][0];
  assert.equal(saved.name, "Cedar Hill Woods");
  assert.deepEqual(saved.point, [-123.340123, 48.461235]);
  assert.deepEqual(saved.context, { platform: "android", version: "1.4.0", build: "14" });

  const retry = await worker.fetch(request("/api/park-proposals", { method: "POST", body: proposal() }), env as never);
  assert.equal(retry.status, 200);
  assert.equal(store.rows.size, 1);
  const reused = await worker.fetch(request("/api/park-proposals", { method: "POST", body: proposal({ name: "Other" }) }), env as never);
  assert.equal(reused.status, 409);
});

test("a pin without an outline is enough", async () => {
  const { store, worker, env } = setup();
  const response = await worker.fetch(request("/api/park-proposals", { method: "POST", body: proposal({ outline: null, note: undefined }) }), env as never);
  assert.equal(response.status, 201);
  assert.equal([...store.rows.values()][0].outline, null);
});

test("invalid proposals are refused", async () => {
  const { worker, env } = setup();
  for (const body of [
    proposal({ name: "" }),
    proposal({ name: "x".repeat(121) }),
    proposal({ point: [200, 48] }),
    proposal({ point: "here" }),
    proposal({ outline: [[-123, 48], [-123.1, 48]] }),
    proposal({ outline: Array.from({ length: 201 }, (_, i) => [-123 + i / 1000, 48]) }),
    proposal({ submissionId: "nope" }),
    proposal({ extra: true }),
  ]) {
    const response = await worker.fetch(request("/api/park-proposals", { method: "POST", body }), env as never);
    assert.equal(response.status, 400, JSON.stringify(body).slice(0, 80));
  }
});

test("one address can propose ten parks an hour", async () => {
  const { worker, env } = setup();
  const statuses = [];
  for (let index = 0; index < 11; index += 1) {
    const submissionId = `6f1c2f0e-3a4b-4c5d-8e9f-${String(index).padStart(12, "0")}`;
    const response = await worker.fetch(request("/api/park-proposals", { method: "POST", body: proposal({ submissionId }) }), env as never);
    statuses.push(response.status);
  }
  assert.deepEqual(statuses.slice(-2), [201, 429]);
});

test("the app no longer lists or reviews proposals; the operator dashboard does", async () => {
  const { store, worker, env } = setup();
  await worker.fetch(request("/api/park-proposals", { method: "POST", body: proposal() }), env as never);
  const id = [...store.rows.keys()][0];
  assert.equal((await worker.fetch(request("/api/operator/park-proposals?status=new"), env as never)).status, 404);
  const patch = await worker.fetch(request(`/api/operator/park-proposals/${id}`, { method: "PATCH", body: { status: "accepted" }, origin: API_ORIGIN }), env as never);
  assert.equal(patch.status, 404);
  assert.equal(store.rows.get(id)?.status, "new");
});
