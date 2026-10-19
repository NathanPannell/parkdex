import assert from "node:assert/strict";
import { test } from "node:test";
import type { MultiPolygon, OsmClient, OsmFeature } from "./osmParks.ts";
import { categoryFor, MAX_BOUNDARY_POSITIONS, osmParkId, parkFromProposal, publishProposalPark, seedFor, type SqlRunner } from "./parkPublish.ts";
import { positionCount } from "./osmParks.ts";
import { provinceFor, provinceOfOutline } from "./provinces.ts";
import { createProposalModerator } from "./proposalModeration.ts";
import {
  approveThreshold,
  createSqlProposalReviewStore,
  decide,
  QUESTIONS,
  regionFor,
  reviewProposal,
  type ChoiceAnswer,
  type Decision,
  type ModerationRecord,
  type NearbyPark,
  type ProposalModerator,
  type ProposalReviewStore,
  type ReviewInput,
} from "./proposalReview.ts";

const square = (lng: number, lat: number, size: number): [number, number][] => [
  [lng, lat],
  [lng + size, lat],
  [lng + size, lat + size],
  [lng, lat + size],
  [lng, lat],
];
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
  inserted: unknown[][] = [];
  failTransaction: Error | null = null;

  async query(text: string, params: unknown[] = []) {
    const id = String(params[0]);
    if (text.includes("FROM kip_park_drafts.drafts WHERE id = $1")) {
      const draft = this.drafts.get(id);
      return draft ? [draft] : [];
    }
    if (text.includes("INSERT INTO kip_park_drafts.drafts")) {
      if (this.drafts.has(id) || this.parks.has(id)) return [];
      this.inserted.push(params);
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
    const id = String(statements.find((statement) => statement.text.includes("FOR UPDATE"))!.params[0]);
    this.parks.add(id);
    this.drafts.get(id)!.status = "published";
    const accept = statements.find((statement) => statement.text.includes("status = 'accepted'"))!;
    this.accepted.set(String(accept.params[0]), String(accept.params[1]));
    return statements.map((statement) => (statement.text.includes("RETURNING published_revision") ? [{ published_revision: "42" }] : []));
  }
}

class MemoryReviewStore implements ProposalReviewStore {
  decisions = new Map<string, { decision: Decision; moderation: ModerationRecord }>();
  nearby: NearbyPark[] = [];
  /** Parks only a wider search (more than 5 km) finds. */
  wide: NearbyPark[] = [];
  readonly db = new FakeSql();

  async state(id: string) {
    return { decision: this.decisions.get(id)?.decision ?? null, publishedParkId: this.db.accepted.get(id) ?? null };
  }
  async nearbyParks(_lat: number, _lng: number, km: number) {
    return km > 5 ? [...this.nearby, ...this.wide] : this.nearby;
  }
  async record(id: string, decision: Decision, moderation: ModerationRecord) {
    this.decisions.set(id, { decision, moderation });
  }
  sql() {
    return this.db;
  }
}

function osm(feature: OsmFeature | null | Error = FEATURE): OsmClient {
  return {
    async search() {
      return [];
    },
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
  assert.deepEqual(
    state.nearbyParks.map((park) => park.name),
    ["Thetis Lake"],
  );
  assert.equal(state.openStreetMap.pinInside, true);

  const [statements] = store.db.transactions;
  assert.ok(
    statements.some((s) => s.text.includes("INSERT INTO public.parks")),
    "uses the dashboard publish transaction",
  );
  assert.ok(statements.some((s) => s.text.includes("INSERT INTO public.boundaries")));
  // The acceptance comes before the park insert, so the category soft-hide can tell the park was proposed.
  const accept = statements[0];
  assert.match(accept.text, /status = 'accepted', published_park_id = \$2/);
  assert.deepEqual(accept.params, [PROPOSAL.id, "osm-way-123456"]);
  assert.ok(statements.findIndex((s) => s.text.includes("INSERT INTO public.parks")) > 0);
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

test("an outline that is already a catalogue park is reported as already listed without asking the model", async () => {
  const { store, asked, deps } = setup();
  const boundary = { type: "MultiPolygon" as const, coordinates: [[square(-123.3605, 48.4495, 0.005)]] };
  store.nearby = [{ id: "municipal-cedar-hill", name: "Cedar Hill Park", region: "Capital Region", lat: 48.452, lng: -123.358, boundary }];
  assert.deepEqual(await reviewProposal(PROPOSAL, deps), { decision: "already_listed", parkId: "municipal-cedar-hill", parkName: "Cedar Hill Park" });
  assert.equal(asked.length, 0);
  assert.equal(store.db.transactions.length, 0);
  const stored = store.decisions.get(PROPOSAL.id)!;
  assert.equal(stored.decision, "rejected");
  assert.match(stored.moderation.reasons.join(" "), /Already in Parkdex as Cedar Hill Park/);
});

test("a large outline around a small catalogue park is still new", async () => {
  const { store, deps } = setup();
  // A playground-sized catalogue park well inside the proposed outline, under a quarter of its area.
  const boundary = { type: "MultiPolygon" as const, coordinates: [[square(-123.3575, 48.4525, 0.0004)]] };
  store.nearby = [{ id: "municipal-tiny-playground", name: "Tiny Playground", region: "Capital Region", lat: 48.4527, lng: -123.3573, boundary }];
  assert.equal((await reviewProposal(PROPOSAL, deps)).decision, "approved");
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
  const park = parkFromProposal(
    FEATURE,
    { id: PROPOSAL.id, name: PROPOSAL.name, note: "", point: PROPOSAL.point, createdAt: PROPOSAL.createdAt },
    "Capital Region",
    PROPOSAL.point,
  );
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

test("a published park never has an empty region, even when the nearest park has none", async () => {
  const { store, deps } = setup();
  // Like proposed-bell-park-2f66 on staging: a nearby park whose region was left empty.
  store.nearby = [
    { id: "proposed-bell-park-2f66", name: "Bell Park", region: "  ", lat: 48.45, lng: -123.35, boundary: null },
    { id: "regional-thetis-lake", name: "Thetis Lake", region: "Capital Region", lat: 48.47, lng: -123.46, boundary: null },
  ];
  assert.equal((await reviewProposal(PROPOSAL, deps)).decision, "approved");
  assert.equal(store.db.inserted[0][7], "Capital Region");

  const alone = setup();
  alone.store.nearby = [{ id: "proposed-bell-park-2f66", name: "Bell Park", region: "", lat: 48.45, lng: -123.35, boundary: null }];
  assert.equal((await reviewProposal(PROPOSAL, alone.deps)).decision, "approved");
  assert.equal(alone.store.db.inserted[0][7], "British Columbia");

  for (const region of ["", "   ", "\u0007\u0008"]) {
    const park = parkFromProposal(
      FEATURE,
      { id: PROPOSAL.id, name: PROPOSAL.name, note: "", point: PROPOSAL.point, createdAt: PROPOSAL.createdAt },
      region,
      PROPOSAL.point,
    );
    assert.equal(park.region, "British Columbia", JSON.stringify(region));
  }
  const db = new FakeSql();
  const park = parkFromProposal(
    FEATURE,
    { id: PROPOSAL.id, name: PROPOSAL.name, note: "", point: PROPOSAL.point, createdAt: PROPOSAL.createdAt },
    "Capital Region",
    PROPOSAL.point,
  );
  await assert.rejects(publishProposalPark(db, { ...park, region: " " }, PROPOSAL.id), /park_incomplete/);
  assert.equal(db.inserted.length, 0);
});

test("with no catalogue park close by, the region comes from one up to 30 km away", async () => {
  const { store, deps } = setup();
  store.wide = [{ id: "regional-metro-vancouver-bou", name: "Boundary Bay Regional Park", region: "Metro Vancouver", lat: 48.55, lng: -123.4, boundary: null }];
  assert.equal((await reviewProposal(PROPOSAL, deps)).decision, "approved");
  assert.equal(store.db.inserted[0][7], "Metro Vancouver");
});

// Point Pleasant Park in Halifax, and a Nova Scotia proposal for it.
const HALIFAX_OUTLINE: MultiPolygon = { type: "MultiPolygon", coordinates: [[square(-63.575, 44.62, 0.01)]] };
const HALIFAX_FEATURE: OsmFeature = {
  ...FEATURE,
  id: 654321,
  name: "Point Pleasant Park",
  tags: { leisure: "park", name: "Point Pleasant Park" },
  geometry: HALIFAX_OUTLINE,
};
const HALIFAX_PROPOSAL: ReviewInput = { ...PROPOSAL, name: "Point Pleasant Park", point: [-63.57, 44.625], osm: { type: "way", id: 654321 } };

test("a Nova Scotia park takes the region of the nearest Nova Scotia park, else Nova Scotia", async () => {
  const { store, deps } = setup(APPROVE, HALIFAX_FEATURE);
  store.nearby = [{ id: "provincial-ns-york-redoubt", name: "York Redoubt", region: "Halifax Metro", lat: 44.6, lng: -63.55, boundary: null }];
  assert.equal((await reviewProposal(HALIFAX_PROPOSAL, deps)).decision, "approved");
  assert.equal(store.db.inserted[0][7], "Halifax Metro");

  const alone = setup(APPROVE, HALIFAX_FEATURE);
  assert.equal((await reviewProposal(HALIFAX_PROPOSAL, alone.deps)).decision, "approved");
  assert.equal(alone.store.db.inserted[0][7], "Nova Scotia");

  // An empty region falls back to the province that holds the outline, not British Columbia.
  const park = parkFromProposal(
    HALIFAX_FEATURE,
    { id: PROPOSAL.id, name: "Point Pleasant Park", note: "", point: HALIFAX_PROPOSAL.point, createdAt: PROPOSAL.createdAt },
    " ",
    HALIFAX_PROPOSAL.point,
  );
  assert.equal(park.region, "Nova Scotia");
});

test("a region is only borrowed from a park in the same province", async () => {
  const nearbyParks = async () => [] as NearbyPark[];
  const bc: NearbyPark = { id: "regional-thetis-lake", name: "Thetis Lake", region: "Capital Region", lat: 48.47, lng: -123.46, boundary: null };
  const ns: NearbyPark = { id: "provincial-ns-york-redoubt", name: "York Redoubt", region: "Halifax Metro", lat: 44.6, lng: -63.55, boundary: null };
  assert.equal(await regionFor({ nearbyParks }, [ns, bc], [-63.57, 44.625], HALIFAX_OUTLINE), "Halifax Metro");
  assert.equal(await regionFor({ nearbyParks }, [ns], PROPOSAL.point, OUTLINE), "British Columbia");
  assert.equal(await regionFor({ nearbyParks }, [bc], [-63.57, 44.625]), "Nova Scotia");
  // Near Thunder Bay, where the nearest province changes from BC to Nova Scotia, a park
  // 15 km west belongs to BC and does not lend its region to a point that belongs to Nova Scotia.
  const west: NearbyPark = { id: "west", name: "West Park", region: "West Region", lat: 49, lng: -90.04, boundary: null };
  assert.equal(await regionFor({ nearbyParks }, [west], [-89.84, 49]), "Nova Scotia");
  assert.equal(await regionFor({ nearbyParks }, [west], [-90.0, 49]), "West Region");
  // The outline decides the province, even when the pin beside it is outside every box.
  assert.equal(await regionFor({ nearbyParks }, [], [-70, 44.625], HALIFAX_OUTLINE), "Nova Scotia");
  // Outside every province, the nearest one: Toronto is closer to Nova Scotia, Seattle to BC.
  const toronto: MultiPolygon = { type: "MultiPolygon", coordinates: [[square(-79.39, 43.64, 0.01)]] };
  assert.equal(await regionFor({ nearbyParks }, [], [-79.385, 43.645], toronto), "Nova Scotia");
  assert.equal(await regionFor({ nearbyParks }, [], [-122.33, 47.61]), "British Columbia");
});

test("provinces resolve every point, in a box or nearest to one", () => {
  assert.equal(provinceFor([-123.3656, 48.4284]), "British Columbia");
  assert.equal(provinceFor([-60.65, 46.73]), "Nova Scotia");
  assert.equal(provinceFor([-79.38, 43.65]), "Nova Scotia");
  assert.equal(provinceFor([-113.49, 53.55]), "British Columbia");
  assert.equal(provinceFor([Number.NaN, 0]), "British Columbia");
  assert.equal(provinceOfOutline(HALIFAX_OUTLINE), "Nova Scotia");
});

test("categories recognise Nova Scotia's park names and operators and keep BC's", () => {
  const park = (name: string | null, tags: Record<string, string> = {}) => categoryFor({ name, tags });
  // BC.
  assert.equal(park("Goldstream Provincial Park", { leisure: "park" }), "provincial");
  assert.equal(park("Race Rocks Ecological Reserve", { boundary: "protected_area" }), "provincial");
  assert.equal(park("Mount Work", { boundary: "protected_area", operator: "BC Parks" }), "provincial");
  assert.equal(park("Thetis Lake Regional Park", { boundary: "protected_area" }), "regional");
  assert.equal(park("Mount Work", { boundary: "protected_area", operator: "CRD" }), "regional");
  assert.equal(park("Pacific Rim National Park Reserve", { boundary: "national_park" }), "national");
  // Nova Scotia.
  assert.equal(park("Cape Breton Highlands National Park", { boundary: "protected_area" }), "national");
  assert.equal(park("Sable Island National Park Reserve", {}), "national");
  assert.equal(park("Kejimkujik", { boundary: "protected_area", operator: "Parks Canada" }), "national");
  assert.equal(park("Kejimkujik", { boundary: "protected_area", operator: "Parcs Canada" }), "national");
  assert.equal(park("Blomidon Provincial Park", { leisure: "park" }), "provincial");
  assert.equal(park("Shubenacadie Provincial Wildlife Park", { leisure: "park" }), "provincial");
  assert.equal(park("Waverley - Salmon River Long Lake Wilderness Area", { boundary: "protected_area" }), "provincial");
  assert.equal(park("Abraham Lake", { leisure: "nature_reserve", operator: "Nova Scotia Environment and Climate Change" }), "provincial");
  assert.equal(park("Dollar Lake", { leisure: "park", operator: "Province of Nova Scotia" }), "provincial");
  assert.equal(park("Blue Mountain-Birch Cove Lakes Regional Park", { leisure: "park" }), "regional");
  // Halifax Regional Municipality is a town, not a regional park.
  assert.equal(park("Shubie Park", { leisure: "park", operator: "Halifax Regional Municipality" }), "municipal");
  assert.equal(park("Victoria Park", { leisure: "park" }), "municipal");
});

test("a huge outline is thinned to the content size budget but keeps every part and hole", () => {
  // A wiggly 5,000-point ring, like a bog boundary traced along every ditch, plus a hole and a second part.
  const wiggly: [number, number][] = Array.from({ length: 5_000 }, (_, index) => {
    const angle = (index / 5_000) * Math.PI * 2;
    const radius = 0.02 + 0.00002 * Math.sin(index * 7);
    return [-122.94 + radius * Math.cos(angle), 49.14 + radius * Math.sin(angle) * 0.66];
  });
  wiggly.push(wiggly[0]);
  const geometry = { type: "MultiPolygon" as const, coordinates: [[wiggly, square(-122.942, 49.139, 0.002)], [square(-122.9, 49.16, 0.003)]] };
  const park = parkFromProposal(
    { ...FEATURE, geometry },
    { id: PROPOSAL.id, name: PROPOSAL.name, note: "", point: [-122.94, 49.14], createdAt: PROPOSAL.createdAt },
    "Metro Vancouver",
    [-122.94, 49.14],
  );
  assert.ok(positionCount(park.geometry) <= MAX_BOUNDARY_POSITIONS, `${positionCount(park.geometry)} positions`);
  assert.equal(park.geometry.coordinates.length, 2);
  assert.equal(park.geometry.coordinates[0].length, 2, "the hole stays");
  const small = parkFromProposal(
    FEATURE,
    { id: PROPOSAL.id, name: PROPOSAL.name, note: "", point: PROPOSAL.point, createdAt: PROPOSAL.createdAt },
    "Capital Region",
    PROPOSAL.point,
  );
  assert.deepEqual(small.geometry, FEATURE.geometry, "small outlines are untouched");
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
    return new Response(
      JSON.stringify({
        id: "dec_1",
        model: "openai/gpt-6-luna-decisions",
        answers: Object.fromEntries(
          Object.entries(APPROVE).map(([name, answer]) => [
            name,
            { type: "choice", choice: answer.choice, confidence: 0.9, probabilities: answer.probabilities },
          ]),
        ),
      }),
      { status: 200 },
    );
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

test("nearby catalogue parks include parks whose boundary box reaches the point, and fall back to pins without founders_004", async () => {
  const row = { id: "national-far", name: "Far National Park", region: "South Shore", lat: 44.44, lng: -65.21, geometry: OUTLINE };
  const queries: { text: string; params: unknown[] }[] = [];
  let missing = false;
  const db: SqlRunner = {
    async query(text, params = []) {
      queries.push({ text, params });
      if (missing && text.includes("park_boundary_box"))
        throw Object.assign(new Error("function public.park_boundary_box(jsonb) does not exist"), { code: "42883" });
      return [row];
    },
    async transaction() {
      throw new Error("unused");
    },
  };
  const store = createSqlProposalReviewStore(db);
  // A point in Kejimkujik Seaside, about 72 km from the park's pin.
  const parks = await store.nearbyParks(43.85124, -64.82927, 5);
  assert.deepEqual(
    parks.map((park) => park.id),
    ["national-far"],
  );
  assert.equal(queries.length, 1);
  assert.match(queries[0].text, /public\.park_boundary_box\(b\.feature\) && box\(point\(\$3, \$1\), point\(\$4, \$2\)\)/);
  const [south, north, west, east, lat, lng] = queries[0].params as number[];
  assert.ok(south < 43.85124 && north > 43.85124 && west < -64.82927 && east > -64.82927);
  assert.ok(Math.abs(((north - south) / 2) * 110.54 - 5) < 1e-9, "the box is the same 5 km as the pin search");
  assert.deepEqual([lat, lng], [43.85124, -64.82927]);

  missing = true;
  queries.length = 0;
  assert.deepEqual(
    (await store.nearbyParks(43.85124, -64.82927, 5)).map((park) => park.id),
    ["national-far"],
  );
  assert.equal(queries.length, 2);
  assert.doesNotMatch(queries[1].text, /park_boundary_box/);

  const failing = createSqlProposalReviewStore({
    ...db,
    async query() {
      throw Object.assign(new Error("db down"), { code: "57P01" });
    },
  });
  await assert.rejects(failing.nearbyParks(43.85124, -64.82927, 5), /db down/);
});
