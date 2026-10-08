import type { ApiPointer, AppConfigPlatform, AppConfigStore, BuildConfigInput, BuildConfigRecord, UpdateRules } from "../../worker/appConfig.js";
import type { ParkProposalRecord, ParkProposalStore, ProposalStatus } from "../../worker/parkProposals.js";
import type { AttachmentRecord, ClaimEmailResult, EmailDeliveryView, FeedbackCursor, FeedbackStore, OperatorFeedbackRecord } from "../../worker/store.js";
import type { EmailAudience, FeedbackStatus } from "../../worker/validation.js";
import type { DashboardDependencies } from "./api.js";
import { HttpError } from "../../worker/validation.js";
import { publicFeature, publishBlockers, SHAPE_FOR_CATEGORY, type BadgeAsset, type Draft, type DraftFields, type DraftPlacement, type DraftStore, type DraftSummary } from "./drafts.js";
import type { MultiPolygon } from "./legacy.js";
import type { LivePark, LiveParkChanges, LiveParkDetail, LiveParkStore } from "./liveParks.js";

/** In-memory stores for tests and the local demo server. Never used by a deployment. */

export class MemoryFeedbackStore implements FeedbackStore {
  readonly reports = new Map<string, OperatorFeedbackRecord>();
  readonly attachments = new Map<string, AttachmentRecord>();

  async saveFeedback(): Promise<never> { throw new Error("not supported"); }
  async findBySubmissionId() { return null; }

  async getReport(id: string) {
    return structuredClone(this.reports.get(id) ?? null);
  }

  async listReports(limit: number, status: FeedbackStatus | null, cursor: FeedbackCursor | null) {
    return [...this.reports.values()]
      .filter((report) => !status || report.status === status)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
      .filter((report) => !cursor || report.createdAt < cursor.createdAt || (report.createdAt === cursor.createdAt && report.id < cursor.id))
      .slice(0, limit)
      .map((report) => structuredClone(report));
  }

  async getAttachment(id: string) {
    return this.attachments.get(id) ?? null;
  }

  async updateStatus(id: string, status: FeedbackStatus) {
    const report = this.reports.get(id);
    if (!report) return null;
    report.status = status;
    return structuredClone(report);
  }

  async getEmailDelivery(id: string, audience: EmailAudience) {
    return structuredClone(this.delivery(id, audience) ?? null);
  }

  async claimEmail(id: string, audience: EmailAudience): Promise<ClaimEmailResult> {
    const delivery = this.delivery(id, audience);
    const report = this.reports.get(id);
    if (!delivery || !report) return { status: "missing" };
    if (delivery.status !== "pending" && delivery.status !== "failed" && !delivery.canRetry) return { status: delivery.status };
    delivery.status = "sending";
    delivery.attempts += 1;
    delivery.lastAttemptAt = new Date().toISOString();
    const recipient = audience === "operator" ? "operator@example.test" : report.email ?? "";
    return {
      status: "claimed",
      email: {
        audience,
        recipient,
        payload: { from: "Parkdex <hello@example.test>", to: recipient ? [recipient] : [], subject: "Feedback", html: "<p>Feedback</p>", text: "Feedback" },
        idempotencyKey: `feedback-${id}-${audience}-v1`,
        initialStatus: "pending",
        initialError: null,
        attempts: delivery.attempts,
      },
    };
  }

  async markEmailDisabled(id: string, audience: EmailAudience) {
    const delivery = this.delivery(id, audience);
    if (delivery) delivery.status = "disabled";
  }

  async finishEmail(id: string, audience: EmailAudience, _lease: string, state: "sent" | "failed" | "ambiguous", error: string | null) {
    const delivery = this.delivery(id, audience);
    if (!delivery) return;
    delivery.status = state;
    delivery.lastError = error;
    delivery.canRetry = state !== "sent";
    if (state === "sent") delivery.sentAt = new Date().toISOString();
  }

  private delivery(id: string, audience: EmailAudience): EmailDeliveryView | undefined {
    return this.reports.get(id)?.emails.find((email) => email.audience === audience);
  }
}

export class MemoryAppConfigStore implements AppConfigStore {
  readonly rows = new Map<string, BuildConfigRecord>();

  async resolve(platform: AppConfigPlatform, build: number) {
    return [...this.rows.values()].filter((row) => row.platform === platform && (row.build === build || row.build === 0));
  }

  async list() {
    return [...this.rows.values()].sort((a, b) => a.platform.localeCompare(b.platform) || b.build - a.build);
  }

  async upsert(platform: AppConfigPlatform, build: number, input: BuildConfigInput) {
    const record = { platform, build, ...input, updatedAt: new Date().toISOString() };
    this.rows.set(`${platform}:${build}`, record);
    return record;
  }

  async remove(platform: AppConfigPlatform, build: number) {
    return this.rows.delete(`${platform}:${build}`);
  }

  readonly rules = new Map<ApiPointer, UpdateRules>();

  async updateRules(environment: ApiPointer) {
    return this.rules.get(environment) ?? { environment, minimumBuild: null, latestBuild: null, updatedAt: null };
  }

  async listUpdateRules() {
    return Promise.all((["production", "staging"] as const).map((environment) => this.updateRules(environment)));
  }

  async setUpdateRules(environment: ApiPointer, minimumBuild: number | null, latestBuild: number | null) {
    const rules = { environment, minimumBuild, latestBuild, updatedAt: new Date().toISOString() };
    this.rules.set(environment, rules);
    return rules;
  }
}

export class MemoryProposalStore implements ParkProposalStore {
  readonly rows = new Map<string, ParkProposalRecord>();

  async save(): Promise<never> { throw new Error("not supported"); }

  async list(status: ProposalStatus | null) {
    return [...this.rows.values()]
      .filter((row) => !status || row.status === status)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async updateStatus(id: string, status: ProposalStatus) {
    const row = this.rows.get(id);
    if (!row) return null;
    row.status = status;
    row.updatedAt = new Date().toISOString();
    return structuredClone(row);
  }
}

type StoredDraft = Draft & { badge: Uint8Array | null; reference: Uint8Array | null };

export class MemoryDraftStore implements DraftStore {
  readonly drafts = new Map<string, StoredDraft>();
  readonly parks = new Map<string, Record<string, unknown>>();
  readonly boundaries = new Map<string, unknown>();
  readonly assets = new Map<string, BadgeAsset>();
  revision = 0;

  private view(draft: StoredDraft | undefined): Draft | null {
    if (!draft) return null;
    const { badge: _badge, reference: _reference, ...rest } = draft;
    return structuredClone(rest);
  }

  private touch(draft: StoredDraft) {
    // Strictly increasing, so a stale updatedAt is always detected.
    const next = Math.max(Date.now(), Date.parse(draft.updatedAt) + 1);
    draft.updatedAt = new Date(next).toISOString();
  }

  async list(): Promise<DraftSummary[]> {
    return [...this.drafts.values()]
      .sort((a, b) => a.status.localeCompare(b.status) || b.updatedAt.localeCompare(a.updatedAt))
      .map((draft) => ({
        id: draft.id, name: draft.name, category: draft.category, rarity: draft.rarity, status: draft.status,
        hasBadge: Boolean(draft.badge), hasBlurb: Boolean(draft.blurb.trim()), hasReferencePhoto: Boolean(draft.reference), updatedAt: draft.updatedAt,
      }));
  }

  async get(id: string) { return this.view(this.drafts.get(id)); }
  async publishedParkIds() { return new Set(this.parks.keys()); }

  async create(input: Parameters<DraftStore["create"]>[0]) {
    if (this.drafts.has(input.id) || this.parks.has(input.id)) throw new HttpError(409, "already_imported", "This park already has a draft or is already in Parkdex.");
    const now = new Date().toISOString();
    const { sourceSha256: _sha, ...fields } = input;
    const draft: StoredDraft = { ...structuredClone(fields), scene: null, badgeSha256: null, badgeBytes: null, referencePhotoType: null, status: "draft", publishedAt: null, createdAt: now, updatedAt: now, badge: null, reference: null };
    this.drafts.set(input.id, draft);
    return this.view(draft)!;
  }

  async update(id: string, fields: Partial<DraftFields & DraftPlacement>) {
    const draft = this.drafts.get(id);
    if (!draft || draft.status !== "draft") return null;
    Object.assign(draft, fields);
    this.touch(draft);
    return this.view(draft);
  }

  async setBadge(id: string, bytes: Uint8Array | null, scene: string | null) {
    const draft = this.drafts.get(id);
    if (!draft || draft.status !== "draft") return null;
    draft.badge = bytes;
    draft.scene = scene;
    draft.badgeBytes = bytes?.byteLength ?? null;
    draft.badgeSha256 = bytes ? await sha256(bytes) : null;
    this.touch(draft);
    return this.view(draft);
  }

  async getBadge(id: string) { return this.drafts.get(id)?.badge ?? null; }

  async setReferencePhoto(id: string, bytes: Uint8Array | null, contentType: string | null) {
    const draft = this.drafts.get(id);
    if (!draft) return null;
    draft.reference = bytes;
    draft.referencePhotoType = contentType;
    this.touch(draft);
    return this.view(draft);
  }

  async getReferencePhoto(id: string) {
    const draft = this.drafts.get(id);
    return draft?.reference && draft.referencePhotoType ? { bytes: draft.reference, contentType: draft.referencePhotoType } : null;
  }

  async remove(id: string) {
    const draft = this.drafts.get(id);
    if (!draft || draft.status !== "draft") return false;
    return this.drafts.delete(id);
  }

  async publish(id: string, expectedUpdatedAt: string, asset: BadgeAsset | null) {
    const draft = this.drafts.get(id);
    if (!draft) throw new HttpError(404, "not_found", "Draft not found.");
    if (draft.updatedAt !== new Date(expectedUpdatedAt).toISOString()) throw new HttpError(409, "draft_changed", "This draft changed since you opened it. Reload and try again.");
    const blockers = publishBlockers(draft);
    if (blockers.length) throw new HttpError(422, "draft_incomplete", blockers.join(" "));
    if (this.parks.has(id)) throw new HttpError(409, "park_exists", "A park with this id is already in Parkdex.");
    if (asset) this.assets.set(asset.logicalPath, asset);
    const { id: parkId, name, short, category, region, lat, lng, biome, shape, rarity, scene, seed, blurb } = draft;
    this.parks.set(id, { id: parkId, name, short, category, region, lat, lng, biome, shape, rarity, scene, seed, blurb });
    this.boundaries.set(id, publicFeature(id, biome, draft.geometry!));
    this.revision += 1;
    draft.status = "published";
    draft.publishedAt = new Date().toISOString();
    this.touch(draft);
    return { id, revision: this.revision };
  }
}

export class MemoryLiveParkStore implements LiveParkStore {
  readonly parks = new Map<string, LivePark & { geometry: MultiPolygon | null }>();
  readonly assets = new Map<string, BadgeAsset>();
  revision = 0;

  async list(): Promise<LivePark[]> {
    return [...this.parks.values()].sort((a, b) => a.name.localeCompare(b.name)).map(({ geometry: _geometry, ...park }) => structuredClone(park));
  }

  async regions(): Promise<string[]> {
    return [...new Set([...this.parks.values()].map((park) => park.region).filter(Boolean))].sort();
  }

  async get(id: string): Promise<LiveParkDetail | null> {
    const park = this.parks.get(id);
    if (!park) return null;
    const asset = park.scene ? this.assets.get(`art/badges/scenes/${park.scene}.webp`) : undefined;
    return { ...structuredClone(park), badgeUrl: asset?.url ?? null };
  }

  async update(id: string, expected: LivePark, changes: LiveParkChanges, asset: BadgeAsset | null) {
    const park = this.parks.get(id);
    if (!park || LIVE_KEYS.some((key) => park[key] !== expected[key])) {
      throw new HttpError(409, "park_changed", "This park changed since you opened it. Reload it and make your edit again.");
    }
    const { geometry, ...fields } = changes;
    Object.assign(park, fields);
    if (changes.category && changes.category !== expected.category) park.shape = SHAPE_FOR_CATEGORY[changes.category] ?? park.shape;
    if (geometry) park.geometry = geometry;
    if (asset) {
      this.assets.set(asset.logicalPath, asset);
      park.scene = asset.logicalPath.slice("art/badges/scenes/".length, -".webp".length);
    }
    this.revision += 1;
    return this.revision;
  }
}

const LIVE_KEYS = ["name", "short", "category", "region", "lat", "lng", "biome", "shape", "rarity", "scene", "blurb"] as const;

function square(lng: number, lat: number, size: number): MultiPolygon {
  return { type: "MultiPolygon", coordinates: [[[[lng - size, lat - size], [lng + size, lat - size], [lng + size, lat + size], [lng - size, lat + size], [lng - size, lat - size]]]] };
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
}

function delivery(audience: EmailAudience, status: EmailDeliveryView["status"], hoursAgo: number): EmailDeliveryView {
  const at = new Date(Date.now() - hoursAgo * 3_600_000).toISOString();
  return {
    audience,
    status,
    attempts: status === "pending" ? 0 : 1,
    lastAttemptAt: status === "pending" ? null : at,
    sentAt: status === "sent" ? at : null,
    providerMessageId: null,
    lastError: status === "failed" ? "Email provider rejected the message (HTTP 422)." : null,
    canRetry: status === "failed" || status === "pending",
    requiresConfirmation: false,
  };
}

const SAMPLE_SHOT = `<svg xmlns="http://www.w3.org/2000/svg" width="360" height="640" viewBox="0 0 360 640"><rect width="360" height="640" fill="#fff8ec"/><rect x="24" y="80" width="312" height="300" rx="24" fill="#9fd8ff" stroke="#14231c" stroke-width="4"/><circle cx="180" cy="230" r="26" fill="#ff5a1f" stroke="#14231c" stroke-width="4"/><rect x="24" y="410" width="312" height="70" rx="18" fill="#ffc93c" stroke="#14231c" stroke-width="4"/><text x="180" y="453" font-family="sans-serif" font-size="22" font-weight="700" text-anchor="middle" fill="#14231c">Collect visit</text></svg>`;

/** Fictional sample rows so the dashboard can be explored without a database. */
const choice = (probabilities: Record<string, number>) => ({ choice: Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0][0], probabilities });

/** Sample model checks so the dashboard shows each decision without a database. */
function demoModeration(index: number, checkedAt: string): Partial<ParkProposalRecord> {
  const base = { version: 1 as const, checkedAt, model: "openai/gpt-6-luna-decisions", threshold: 0.8, reasons: [] as string[], nearby: [] as { id: string; name: string; distanceM: number; overlaps: boolean }[] };
  if (index === 0) {
    return {
      osm: { type: "relation", id: 2_093_447 },
      decision: "unsure",
      publishedParkId: null,
      decidedAt: checkedAt,
      moderation: {
        ...base,
        answers: {
          park: choice({ approve: 0.72, reject: 0.06, unsure: 0.22 }),
          name: choice({ match: 0.91, mismatch: 0.03, unsure: 0.06 }),
          duplicate: choice({ new: 0.84, duplicate: 0.1, unsure: 0.06 }),
        },
        reasons: ["Not clearly a public park."],
        osm: { type: "relation", id: 2_093_447, name: "Swan Lake Christmas Hill Nature Sanctuary", kind: "leisure=nature_reserve", areaM2: 437_000, distanceM: 0, containsPin: true },
        nearby: [{ id: "beacon-hill-park", name: "Beacon Hill Park", distanceM: 5_900, overlaps: false }],
      },
    };
  }
  if (index === 1) {
    return { osm: null, decision: "skipped", publishedParkId: null, decidedAt: checkedAt, moderation: { ...base, model: null, threshold: null, answers: null, osm: null, reasons: ["No OpenStreetMap outline was chosen."] } };
  }
  if (index === 2) {
    return {
      osm: { type: "way", id: 24_420_117 },
      decision: "rejected",
      publishedParkId: null,
      decidedAt: checkedAt,
      moderation: {
        ...base,
        answers: {
          park: choice({ approve: 0.2, reject: 0.7, unsure: 0.1 }),
          name: choice({ match: 0.88, mismatch: 0.04, unsure: 0.08 }),
          duplicate: choice({ new: 0.9, duplicate: 0.05, unsure: 0.05 }),
        },
        reasons: ["The model judged this is not a public park."],
        osm: { type: "way", id: 24_420_117, name: "Playfair Park", kind: "leisure=park", areaM2: 38_000, distanceM: 12, containsPin: false },
      },
    };
  }
  return {
    osm: { type: "way", id: 31_337_001 },
    decision: "approved",
    publishedParkId: "osm-way-31337001",
    decidedAt: checkedAt,
    moderation: {
      ...base,
      answers: {
        park: choice({ approve: 0.95, reject: 0.02, unsure: 0.03 }),
        name: choice({ match: 0.93, mismatch: 0.02, unsure: 0.05 }),
        duplicate: choice({ new: 0.91, duplicate: 0.04, unsure: 0.05 }),
      },
      osm: { type: "way", id: 31_337_001, name: "Haro Woods", kind: "leisure=park", areaM2: 172_000, distanceM: 0, containsPin: true },
    },
  };
}

export function demoDependencies(): DashboardDependencies {
  const feedback = new MemoryFeedbackStore();
  const samples: Array<[FeedbackStatus, OperatorFeedbackRecord["kind"], string, string | null, number, boolean]> = [
    ["new", "bug", "The map froze after I zoomed out past the harbour. Had to close the app to get it moving again.", "Beacon Hill Park", 2, true],
    ["new", "idea", "Could parks show which entrance is closest to the bus stop? I walked the long way round twice.", "Mount Douglas Park", 5, false],
    ["new", "general", "Love Kip. My kids race to collect every badge on the weekend.", null, 9, false],
    ["reviewing", "bug", "Badge photo stayed blurry after the visit was collected on my Pixel.", "Cattle Point", 26, true],
    ["reviewing", "idea", "A dark map style for evening walks would be lovely.", null, 50, false],
    ["planned", "idea", "Let me favourite parks so they show up first on the list.", "Thetis Lake", 80, false],
    ["planned", "bug", "Offline download stopped at 80 percent on a slow connection.", null, 120, false],
    ["closed", "general", "Thanks for adding Saanich parks!", "Cuthbert Holmes Park", 200, false],
  ];
  samples.forEach(([status, kind, message, parkName, hoursAgo, screenshot], index) => {
    const id = `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
    const contact = index % 2 === 0;
    feedback.reports.set(id, {
      id,
      submissionId: id,
      kind,
      message,
      email: contact ? `player${index + 1}@example.test` : null,
      contact,
      context: { version: "1.4.0", build: String(40 + index), platform: index % 3 === 0 ? "android" : "web", screen: parkName ? "park" : "map", parkId: parkName ? `park-${index}` : null, parkName },
      createdAt: new Date(Date.now() - hoursAgo * 3_600_000).toISOString(),
      status,
      hasScreenshot: screenshot,
      screenshot: screenshot ? { contentType: "image/svg+xml", size: SAMPLE_SHOT.length } : null,
      emails: [delivery("operator", index === 1 ? "failed" : "sent", hoursAgo), ...(contact ? [delivery("receipt", "sent", hoursAgo)] : [])],
    });
    if (screenshot) feedback.attachments.set(id, { contentType: "image/svg+xml", size: SAMPLE_SHOT.length, base64: btoa(SAMPLE_SHOT) });
  });

  const builds = new MemoryAppConfigStore();
  void builds.upsert("android", 0, { label: "Default", apiPointer: "production", flags: { rankProgression: true, parkProposals: true, mapDownloads: false }, notes: "Applies to every Android build without its own row." });
  void builds.upsert("android", 12, { label: "1.4 closed test", apiPointer: "staging", flags: { parkProposals: true, mapDownloads: true }, notes: "" });
  void builds.setUpdateRules("production", 9, 11);
  void builds.setUpdateRules("staging", null, 12);

  const proposals = new MemoryProposalStore();
  const proposalSamples: Array<[string, string, ProposalStatus, [number, number], boolean]> = [
    ["Swan Lake Nature Sanctuary", "Boardwalk loop with heron nests. Main gate on Swan Lake Road.", "new", [-123.3726, 48.4655], true],
    ["Gonzales Beach", "Small beach park, stairs from Crescent Road.", "new", [-123.3299, 48.4126], false],
    ["Playfair Park", "", "reviewing", [-123.3361, 48.4598], true],
    ["Haro Woods", "Trails connect to Cadboro Bay.", "accepted", [-123.3044, 48.4686], false],
  ];
  proposalSamples.forEach(([name, note, status, point, outline], index) => {
    const id = `10000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
    const createdAt = new Date(Date.now() - (index + 1) * 20 * 3_600_000).toISOString();
    const [lng, lat] = point;
    proposals.rows.set(id, {
      id,
      name,
      note,
      point,
      outline: outline ? [[lng - 0.004, lat + 0.002], [lng + 0.003, lat + 0.003], [lng + 0.004, lat - 0.002], [lng - 0.001, lat - 0.004], [lng - 0.005, lat - 0.001]] : null,
      context: { platform: "android", version: "1.4.0", build: "44" },
      status,
      createdAt,
      updatedAt: createdAt,
      ...demoModeration(index, createdAt),
    });
  });

  const drafts = new MemoryDraftStore();

  const live = new MemoryLiveParkStore();
  const liveSamples: Array<[string, string, string, string, number, number, string, string]> = [
    ["beacon-hill-park", "Beacon Hill Park", "Beacon Hill", "municipal", -123.3632, 48.4136, "forest", "uncommon"],
    ["mount-douglas-park", "Mount Douglas Park", "Mount Doug", "regional", -123.3453, 48.4927, "mountain", "rare"],
    ["thetis-lake-park", "Thetis Lake Regional Park", "Thetis Lake", "regional", -123.4642, 48.4646, "lake", "uncommon"],
    ["cattle-point", "Cattle Point", "Cattle Point", "municipal", -123.2985, 48.4383, "coast", "common"],
  ];
  liveSamples.forEach(([id, name, short, category, lng, lat, biome, rarity], index) => {
    live.parks.set(id, {
      id, name, short, category, region: index % 2 ? "Saanich" : "Capital", lat, lng, biome, shape: SHAPE_FOR_CATEGORY[category], rarity, scene: null, seed: 1000 + index,
      blurb: index === 0 ? "Gardens, ponds and a view across the strait to the Olympic Mountains." : "", geometry: square(lng, lat, 0.004 + index * 0.001),
    });
  });
  return { feedbackStore: () => feedback, appConfigStore: () => builds, proposalStore: () => proposals, draftStore: () => drafts, liveParkStore: () => live,
    // The demo has one set of sample rows, so the other database reports fixed counts.
    queueCounts: async () => ({ feedback: { new: 6, reviewing: 2, closed: 9 }, proposals: { new: 14, reviewing: 3, declined: 1 } }) };
}
