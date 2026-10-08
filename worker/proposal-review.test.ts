import assert from "node:assert/strict";
import { test } from "node:test";
import { createFeedbackWorker } from "./index.ts";
import type { MultiPolygon, OsmClient, OsmFeature } from "./osmParks.ts";
import type { ParkProposalRecord, ParkProposalStore, ProposalStatus, SaveProposalResult } from "./parkProposals.ts";
import { categoryFor, osmParkId, parkFromProposal, publishProposalPark, seedFor, type SqlRunner } from "./parkPublish.ts";
import { createProposalModerator } from "./proposalModeration.ts";
import {
  approveThreshold,
  decide,
  QUESTIONS,
  reviewProposal,
  type ChoiceAnswer,
  type Decision,
  type ModerationRecord,
  type NearbyPark,
  type ProposalModerator,
  type ProposalReviewStore,
  type ReviewInput,
} from "./proposalReview.ts";

const square = (lng: number, lat: number, size: number): [number, number][] =>
  [[lng, lat], [lng + size, lat], [lng + size, lat + size], [lng, lat + size], [lng, lat]];
const OUTLINE: MultiPolygon = { type: "MultiPolygon", coordinates: [[square(-123.36, 48.45, 0.004), square(-123.359, 48.451, 0.001)]] };

const FEATURE: OsmFeature = {
  type: "way",
  id: 123456,
  name: "Cedar Hill Woods",
  kind: "leisure=park",
  tags: { leisure: "park", name: "Cedar Hill Woods" },
  geometry: OUTLINE,
  areaM2: 85_000,
};

const PROPOSAL: ReviewInput = {
  id: "00000000-0000-4000-8000-000000000001",
  name: "Cedar Hill Woods",
  note: "Forest trail behind the rec centre",
  point: [-123.357, 48.4505],
  osm: { type: "way", id: 123456 },
  createdAt: "2026-10-07T12:00:00.000Z",
};

const choice = (probabilities: Record<string, number>): ChoiceAnswer => ({
  choice: Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0][0],
  probabilities,
});

const APPROVE = {
  park: choice({ approve: 0.93, reject: 0.03, unsure: 0.04 }),
  name: choice({ match: 0.9, mismatch: 0.05, unsure: 0.05 }),
  duplicate: choice({ new: 0.88, duplicate: 0.07, unsure: 0.05 }),
};

class FakeSql implements SqlRunner {
  drafts = new Map<string, { status: string; updated_at: string; proposal_id: string }>();
  parks = new Set<string>();
  accepted = new Map<string, string>();
  transactions: { text: string; params: unknown[] }[][] = [];
  failTransaction: Error | null = null;

  async query(text: string, params: unknown[] = []) {
    const id = String(params[0]);
    if (text.includes("FROM kip_park_drafts.drafts WHERE id = $1")) {
      const draft = this.drafts.get(id);
      return draft ? [draft] : [];
    }
    if (text.includes("INSERT INTO kip_park_drafts.drafts")) {
      if (this.drafts.has(id) || this.parks.has(id)) return [];
      const source = JSON.parse(String(params[1])) as { proposal: { id: string } };
      const draft = { status: "draft", updated_at: "2026-10-07T12:00:01.234Z", proposal_id: source.proposal.id };
      this.drafts.set(id, draft);
      return [{ updated_at: draft.updated_at }];
    }
    if (text.startsWith("SELECT 1 FROM public.parks")) return this.parks.has(id) ? [{ "?column?": 1 }] : [];
    if (text.includes("UPDATE kip_proposals.parks SET status = 'accepted'")) {
      this.accepted.set(id, String(params[1]));
      return [];
    }
    throw new Error(`unexpected query ${text}`);
  }

  async transaction(statements: { text: string; params: unknown[] }[]) {
    this.transactions.push(statements);
    if (this.failTransaction) throw this.failTransaction;
    const id = String(statements[0].params[0]);
    this.parks.add(id);
    this.drafts.get(id)!.status = "published";
    const accept = statements[statements.length - 1];
    this.accepted.set(String(accept.params[0]), String(accept.params[1]));
    return statements.map((statement) => statement.text.includes("RETURNING published_revision") ? [{ published_revision: "42" }] : []);
  }
}

class MemoryReviewStore implements ProposalReviewStore {
  decisions = new Map<string, { decision: Decision; moderation: ModerationRecord }>();
  nearby: NearbyPark[] = [];
  readonly db = new FakeSql();

  async state(id: string) {
    return { decision: this.decisions.get(id)?.decision ?? null, publishedParkId: this.db.accepted.get(id) ?? null };
  }
  async nearbyParks() { return this.nearby; }
  async record(id: string, decision: Decision, moderation: ModerationRecord) { this.decisions.set(id, { decision, moderation }); }
  sql() { return this.db; }
}

function osm(feature: OsmFeature | null | Error = FEATURE): OsmClient {
  return {
    async search() { return []; },
    async feature() {
      if (feature instanceof Error) throw feature;
      return feature;
    },
  };
}

function setup(answers: Record<string, ChoiceAnswer> | null = APPROVE, feature: OsmFeature | null | Error = FEATURE) {
  const store = new MemoryReviewStore();
  const asked: Parameters<ProposalModerator>[0][] = [];
  const moderate: ProposalModerator = async (input) => {
    asked.push(input);
    return answers && { model: "openai/gpt-6-luna-decisions", answers };
  };
  const deps = { store, osm: osm(feature), moderate, threshold: 0.8, now: () => new Date("2026-10-07T12:00:02Z") };
  return { store, asked, deps };
}

test("a clearly approved OpenStreetMap proposal is published with the proposal accepted in one transaction", async () => {
  const { store, asked, deps } = setup();
  store.nearby = [{ id: "regional-thetis-lake", name: "Thetis Lake", region: "Capital Region", lat: 48.47, lng: -123.46, boundary: null }];
  const outcome = await reviewProposal(PROPOSAL, deps);
  assert.deepEqual(outcome, { decision: "approved", parkId: "osm-way-123456", parkName: "Cedar Hill Woods" });

  assert.equal(asked.length, 1);
  assert.equal(asked[0].kind, "park_proposal");
  assert.deepEqual(Object.keys(asked[0].questions), ["park", "name", "duplicate"]);
  const state = asked[0].state as { nearbyParks: { name: string }[]; openStreetMap: { pinInside: boolean } };
  assert.deepEqual(state.nearbyParks.map((park) => park.name), ["Thetis Lake"]);
  assert.equal(state.openStreetMap.pinInside, true);

  const [statements] = store.db.transactions;
  assert.ok(statements.some((s) => s.text.includes("INSERT INTO public.parks")), "uses the dashboard publish transaction");
  assert.ok(statements.some((s) => s.text.includes("INSERT INTO public.boundaries")));
  const accept = statements[statements.length - 1];
  assert.match(accept.text, /status = 'accepted', published_park_id = \$2/);
  assert.deepEqual(accept.params, [PROPOSAL.id, "osm-way-123456"]);
  const record = store.decisions.get(PROPOSAL.id)!;
  assert.equal(record.decision, "approved");
  assert.equal(record.moderation.model, "openai/gpt-6-luna-decisions");
  assert.equal(record.moderation.threshold, 0.8);
  assert.equal(record.moderation.osm?.containsPin, true);
});

test("a retry after publishing reports the live park without asking the model again", async () => {
  const { store, asked, deps } = setup();
  await reviewProposal(PROPOSAL, deps);
  const again = await reviewProposal(PROPOSAL, deps);
  assert.deepEqual(again, { decision: "approved", parkId: "osm-way-123456", parkName: "Cedar Hill Woods" });
  assert.equal(asked.length, 1);
  assert.equal(store.db.transactions.length, 1);
});

test("without the model key every proposal waits for the operator", async () => {
  const { store, deps } = setup();
  const outcome = await reviewProposal(PROPOSAL, { ...deps, moderate: null });
  assert.deepEqual(outcome, { decision: "pending" });
  assert.equal(store.decisions.get(PROPOSAL.id)?.decision, "skipped");
  assert.equal(store.db.transactions.length, 0);
});

test("free-form proposals without an OpenStreetMap outline wait without a model call", async () => {
  const { store, asked, deps } = setup();
  assert.deepEqual(await reviewProposal({ ...PROPOSAL, osm: null }, deps), { decision: "pending" });
  assert.equal(asked.length, 0);
  assert.match(store.decisions.get(PROPOSAL.id)!.moderation.reasons[0], /No OpenStreetMap outline/);
});

test("unsure answers below the threshold wait for the operator", async () => {
  const { store, deps } = setup({ ...APPROVE, park: choice({ approve: 0.7, reject: 0.1, unsure: 0.2 }) });
  assert.deepEqual(await reviewProposal(PROPOSAL, deps), { decision: "pending" });
  const stored = store.decisions.get(PROPOSAL.id)!;
  assert.equal(stored.decision, "unsure");
  assert.deepEqual(stored.moderation.answers, { ...APPROVE, park: choice({ approve: 0.7, reject: 0.1, unsure: 0.2 }) });
  assert.equal(store.db.transactions.length, 0);
});

test("a model rejection waits for the operator and is never published", async () => {
  const { store, deps } = setup({ ...APPROVE, park: choice({ approve: 0.1, reject: 0.85, unsure: 0.05 }) });
  assert.deepEqual(await reviewProposal(PROPOSAL, deps), { decision: "pending" });
  assert.equal(store.decisions.get(PROPOSAL.id)?.decision, "rejected");
  assert.equal(store.db.transactions.length, 0);
});

test("an outline overlapping an existing park waits even when the model approves", async () => {
  const { store, deps } = setup();
  store.nearby = [{ id: "municipal-cedar-hill", name: "Cedar Hill Park", region: "Capital Region", lat: 48.452, lng: -123.358, boundary: null }];
  assert.deepEqual(await reviewProposal(PROPOSAL, deps), { decision: "pending" });
  const stored = store.decisions.get(PROPOSAL.id)!;
  assert.equal(stored.decision, "unsure");
  assert.match(stored.moderation.reasons.join(" "), /overlaps Cedar Hill Park/);
});

test("an outline far from the pin is rejected before asking the model", async () => {
  const { store, asked, deps } = setup();
  assert.deepEqual(await reviewProposal({ ...PROPOSAL, point: [-123.2, 48.45] }, deps), { decision: "pending" });
  assert.equal(asked.length, 0);
  assert.equal(store.decisions.get(PROPOSAL.id)?.decision, "rejected");
});

test("OpenStreetMap or model outages leave the proposal waiting", async () => {
  const outage = setup(APPROVE, new Error("overpass down"));
  assert.deepEqual(await reviewProposal(PROPOSAL, outage.deps), { decision: "pending" });
  assert.equal(outage.store.decisions.get(PROPOSAL.id)?.decision, "skipped");
  const silent = setup(null);
  assert.deepEqual(await reviewProposal(PROPOSAL, silent.deps), { decision: "pending" });
  assert.equal(silent.store.decisions.get(PROPOSAL.id)?.decision, "skipped");
});

test("a failed publish rolls back and leaves the approved proposal waiting", async () => {
  const { store, deps } = setup();
  store.db.failTransaction = new Error("draft_incomplete: detail with postgres://user:secret@host/db");
  assert.deepEqual(await reviewProposal(PROPOSAL, deps), { decision: "pending" });
  const stored = store.decisions.get(PROPOSAL.id)!;
  assert.equal(stored.decision, "approved");
  assert.equal(stored.moderation.publishError, "Publishing was rolled back (draft_incomplete).");
  assert.ok(!JSON.stringify(stored).includes("secret"));
});

test("publishing is blocked when another park or draft already uses the id", async () => {
  const db = new FakeSql();
  const park = parkFromProposal(FEATURE, { id: PROPOSAL.id, name: PROPOSAL.name, note: "", point: PROPOSAL.point, createdAt: PROPOSAL.createdAt }, "Capital Region", PROPOSAL.point);
  db.parks.add(park.id);
  assert.deepEqual(await publishProposalPark(db, park, PROPOSAL.id), { status: "blocked", reason: "park_exists" });
  const other = new FakeSql();
  other.drafts.set(park.id, { status: "draft", updated_at: "2026-10-07T00:00:00Z", proposal_id: "someone-else" });
  assert.deepEqual(await publishProposalPark(other, park, PROPOSAL.id), { status: "blocked", reason: "draft_conflict" });
  // Our own draft left by an earlier failed attempt is published on retry.
  const ours = new FakeSql();
  ours.drafts.set(park.id, { status: "draft", updated_at: "2026-10-07T00:00:00.000Z", proposal_id: PROPOSAL.id });
  assert.deepEqual(await publishProposalPark(ours, park, PROPOSAL.id), { status: "published", parkId: park.id, revision: 42 });
});

test("park fields use installed-build enum values, a stable id and seed, and no scene", () => {
  const park = parkFromProposal(
    { ...FEATURE, name: "Mount\u0007Tolmie  Park" },
    { id: PROPOSAL.id, name: "Tolmie", note: "", point: PROPOSAL.point, createdAt: PROPOSAL.createdAt },
    "",
    PROPOSAL.point,
  );
  assert.equal(park.id, osmParkId(FEATURE));
  assert.equal(park.name, "Mount Tolmie Park");
  assert.equal(park.short, "Mount Tolmie");
  assert.equal(park.region, "British Columbia");
  assert.equal(park.category, "municipal");
  assert.equal(park.shape, "circle");
  assert.equal(park.biome, "mountain");
  assert.equal(park.rarity, "common");
  assert.equal(park.seed, seedFor(park.id));
  assert.ok(park.seed >= 0 && park.seed <= 1_000_000);
  assert.ok(park.blurb.length > 0 && park.blurb.length <= 800);
  assert.equal(categoryFor({ name: "Thetis Lake Regional Park", tags: { boundary: "protected_area" } }), "regional");
  assert.equal(categoryFor({ name: "Goldstream Provincial Park", tags: { leisure: "park" } }), "provincial");
  assert.equal(categoryFor({ name: null, tags: { leisure: "nature_reserve" } }), "community");
});

test("decide() approves only when every answer clears the threshold", () => {
  assert.deepEqual(decide(APPROVE, 0.8), { decision: "approved", reasons: [] });
  assert.equal(decide(APPROVE, 0.95).decision, "unsure");
  assert.equal(decide({ ...APPROVE, name: choice({ match: 0.2, mismatch: 0.7, unsure: 0.1 }) }, 0.8).decision, "rejected");
  assert.equal(decide({ ...APPROVE, duplicate: choice({ new: 0.45, duplicate: 0.5, unsure: 0.05 }) }, 0.8).decision, "rejected");
  assert.equal(decide({ park: APPROVE.park }, 0.8).decision, "unsure", "missing answers never approve");
  assert.equal(approveThreshold(undefined), 0.8);
  assert.equal(approveThreshold("0.9"), 0.9);
  assert.equal(approveThreshold("0.2"), 0.8, "a threshold below 0.5 is ignored");
  assert.equal(approveThreshold("lots"), 0.8);
});

test("the proposal moderator sends choice questions through the shared module and keeps the key out of the body", async () => {
  assert.equal(createProposalModerator({}), null);
  const calls: { url: string; init: RequestInit }[] = [];
  const fetcher = async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init! });
    return new Response(JSON.stringify({
      id: "dec_1",
      model: "openai/gpt-6-luna-decisions",
      answers: Object.fromEntries(Object.entries(APPROVE).map(([name, answer]) => [name, { type: "choice", choice: answer.choice, confidence: 0.9, probabilities: answer.probabilities }])),
    }), { status: 200 });
  };
  const moderator = createProposalModerator({ OPENROUTER_API_KEY: "test-key-not-real" }, fetcher)!;
  const result = await moderator({ kind: "park_proposal", state: { proposal: { name: "x" } }, questions: QUESTIONS });
  assert.deepEqual(result, { model: "openai/gpt-6-luna-decisions", answers: APPROVE });
  assert.equal(calls[0].url, "https://openrouter.ai/api/alpha/decisions");
  const body = JSON.parse(String(calls[0].init.body)) as { model: string; questions: Record<string, { type: string; criteria: Record<string, string> }> };
  assert.equal(body.model, "openai/gpt-6-luna-decisions");
  assert.deepEqual(Object.keys(body.questions.park.criteria), ["approve", "reject", "unsure"]);
  assert.ok(!String(calls[0].init.body).includes("test-key-not-real"));
});

// ---------------------------------------------------------------- the submit route

class MemoryProposalStore implements ParkProposalStore {
  readonly rows = new Map<string, ParkProposalRecord & { submissionId: string; payloadHash: string }>();
  async save({ id, payloadHash, proposal }: Parameters<ParkProposalStore["save"]>[0]): Promise<SaveProposalResult> {
    const existing = [...this.rows.values()].find((row) => row.submissionId === proposal.submissionId);
    if (existing) return existing.payloadHash === payloadHash ? { status: "duplicate", proposal: existing } : { status: "conflict" };
    const record = {
      id, name: proposal.name, note: proposal.note, point: proposal.point, outline: proposal.outline, context: proposal.context,
      status: "new" as ProposalStatus, createdAt: "2026-10-07T12:00:00.000Z", updatedAt: "", submissionId: proposal.submissionId, payloadHash,
    };
    this.rows.set(id, record);
    return { status: "created", proposal: record };
  }
  async list() { return [...this.rows.values()]; }
  async updateStatus() { return null; }
}

function submit(worker: ReturnType<typeof createFeedbackWorker>, body: Record<string, unknown>) {
  return worker.fetch(new Request("https://api.example.test/api/park-proposals", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.7" },
    body: JSON.stringify(body),
  }), { SESSION_SECRET: "test-session-secret-which-is-long-enough" } as never);
}

const BODY = {
  submissionId: "6f1c2f0e-3a4b-4c5d-8e9f-0a1b2c3d4e5f",
  name: "Cedar Hill Woods",
  point: [-123.357, 48.4505],
  osm: { type: "way", id: 123456 },
};

test("POST /api/park-proposals tells the app when a proposal went live", async () => {
  const review = new MemoryReviewStore();
  const moderator: ProposalModerator = async () => ({ model: "m", answers: APPROVE });
  const worker = createFeedbackWorker({
    createParkProposalStore: () => new MemoryProposalStore(),
    createProposalReviewStore: () => review,
    osmClient: osm(),
    proposalModerator: moderator,
    uuid: () => PROPOSAL.id,
  });
  const response = await submit(worker, BODY);
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), { id: PROPOSAL.id, review: { decision: "approved", parkId: "osm-way-123456", parkName: "Cedar Hill Woods" } });
});

test("POST /api/park-proposals waits for the operator when the model is off, and rejects a malformed OpenStreetMap pick", async () => {
  const worker = createFeedbackWorker({
    createParkProposalStore: () => new MemoryProposalStore(),
    createProposalReviewStore: () => new MemoryReviewStore(),
    osmClient: osm(),
    proposalModerator: null,
  });
  const waiting = await submit(worker, BODY);
  assert.equal(waiting.status, 201);
  assert.deepEqual((await waiting.json() as { review: unknown }).review, { decision: "pending" });
  for (const bad of [{ type: "node", id: 1 }, { type: "way", id: -4 }, { type: "way", id: 1.5 }, { type: "way", id: 1, extra: true }, "way/1"]) {
    const response = await submit(worker, { ...BODY, submissionId: "6f1c2f0e-3a4b-4c5d-8e9f-0a1b2c3d4e60", osm: bad });
    assert.equal(response.status, 400, JSON.stringify(bad));
    assert.equal((await response.json() as { code: string }).code, "invalid_osm");
  }
});
