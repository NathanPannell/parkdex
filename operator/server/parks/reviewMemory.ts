import {
  emptyCounts, type ApproveResult, type FoundingReviewStore, type ReviewDetail, type ReviewListItem, type ReviewReasonCode, type ReviewStatus,
} from "../../../worker/founding-reviews.js";
import type { OsmFeature } from "../../../worker/osmParks.js";
import { osmParkId } from "../../../worker/parkPublish.js";
import { HttpError } from "../../../worker/validation.js";
import type { CoverPhoto } from "./manager.js";
import type { MemoryLiveParkStore, MemoryOsmStore, MemoryParkManagerStore } from "./memory.js";
import { neighbourhood, osmDraft } from "./osm.js";

/**
 * Review requests in memory for tests and the local demo. Approval follows the same rules as
 * worker/founding-reviews.ts: publish an OpenStreetMap target, make the player founder with the
 * photo as the cover, close other pending requests for the park, and never record a visit.
 */

export interface MemoryReview {
  id: string;
  accountId: string;
  handle: string | null;
  status: ReviewStatus;
  parkId: string;
  parkName: string;
  /** The outline checked, for an OpenStreetMap park not in Parkdex yet. */
  feature: OsmFeature | null;
  outcome: "reject" | "unsure";
  flags: string[];
  position: { lat: number; lng: number; accuracyM: number };
  photo: CoverPhoto | null;
  width: number;
  height: number;
  moderation: ReviewDetail["moderation"];
  createdAt: string;
  checkedAt: string;
  decidedAt: string | null;
  reasonCode: ReviewReasonCode | null;
  reason: string | null;
  foundedParkId: string | null;
  seenAt: string | null;
}

function conflict(status: string): HttpError {
  return new HttpError(409, "review_decided", `This request is already ${status}. Reload to see it.`);
}

export class MemoryFoundingReviewStore implements FoundingReviewStore {
  requests: MemoryReview[] = [];
  /** Off shows the dashboard as it looks on a database without founders_002. */
  available = true;
  /** Decisions as the dashboard would record them in kip_analytics.events. */
  events: Array<{ type: string; parkId: string; properties: Record<string, unknown> }> = [];

  constructor(readonly live: MemoryLiveParkStore, readonly manager: MemoryParkManagerStore, readonly osm: MemoryOsmStore) {}

  private item(row: MemoryReview): ReviewListItem {
    return {
      id: row.id, status: row.status, parkId: row.parkId, parkName: this.live.parks.get(row.parkId)?.name ?? row.parkName,
      osm: row.feature ? { type: row.feature.type, id: row.feature.id } : null, handle: row.handle, outcome: row.outcome, flags: [...row.flags],
      createdAt: row.createdAt, checkedAt: row.checkedAt, decidedAt: row.decidedAt, reasonCode: row.reasonCode, reason: row.reason,
      foundedParkId: row.foundedParkId, photoSha256: row.photo?.sha256 ?? "0".repeat(64), hasPhoto: row.photo !== null,
    };
  }

  async list(status: ReviewStatus | null, limit: number) {
    if (!this.available) return null;
    const counts = emptyCounts();
    for (const row of this.requests) counts[row.status] += 1;
    const requests = this.requests.filter((row) => status === null || row.status === status)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)).slice(0, limit).map((row) => this.item(row));
    return { requests, counts };
  }

  async get(id: string): Promise<ReviewDetail | null> {
    const row = this.requests.find((request) => request.id === id);
    if (!row || !this.available) return null;
    const founded = this.manager.founders.get(row.foundedParkId ?? row.parkId);
    return {
      ...this.item(row),
      position: { ...row.position },
      photo: { sha256: row.photo?.sha256 ?? "0".repeat(64), width: row.width, height: row.height, bytes: row.photo?.bytes.byteLength ?? null, purgedAt: row.photo ? null : row.decidedAt },
      moderation: row.moderation ? structuredClone(row.moderation) : null,
      geometry: structuredClone(row.feature?.geometry ?? this.live.parks.get(row.parkId)?.geometry ?? null),
      park: {
        inParkdex: this.live.parks.has(row.parkId),
        hidden: this.manager.hidden.has(row.parkId),
        founder: founded ? { handle: founded.handle, foundedAt: founded.foundedAt } : null,
      },
      otherPending: this.requests.filter((other) => other.id !== row.id && other.parkId === row.parkId && other.status === "pending").length,
      seenAt: row.seenAt,
    };
  }

  async photo(id: string) {
    const photo = this.requests.find((request) => request.id === id)?.photo;
    return photo ? { bytes: photo.bytes, sha256: photo.sha256, contentType: photo.contentType } : null;
  }

  private pending(id: string): MemoryReview {
    const row = this.requests.find((request) => request.id === id);
    if (!row) throw new HttpError(404, "not_found", "That review request does not exist.");
    if (row.status !== "pending") throw conflict(row.status);
    return row;
  }

  async approve(id: string, input: { at: string }): Promise<ApproveResult> {
    const row = this.pending(id);
    if (!row.photo) throw new HttpError(409, "photo_missing", "This request has no photo any more, so it cannot be approved.");
    let parkId = row.parkId;
    let source: ApproveResult["source"] = "existing";
    if (row.feature && !this.live.parks.has(osmParkId(row.feature))) {
      // Publish the outline as founding would, unless it is a Parkdex park already.
      const catalogue = await this.osm.catalogue(neighbourhood(row.feature));
      await this.osm.publish(osmDraft(row.feature, catalogue));
      source = "osm_new";
    }
    if (row.feature) parkId = osmParkId(row.feature);
    const park = this.live.parks.get(parkId);
    if (!park || this.manager.hidden.has(parkId)) {
      throw new HttpError(409, "park_unavailable", "The park is hidden or no longer in Parkdex, so it cannot be founded. Unhide it first or reject the request.");
    }
    const founder = this.manager.founders.get(parkId);
    if (founder) {
      row.status = "superseded";
      row.decidedAt = input.at;
      throw new HttpError(409, "already_founded", `${park.name} was founded first${founder.handle ? ` by @${founder.handle}` : ""}. The request is closed as superseded.`);
    }
    this.manager.founders.set(parkId, { handle: row.handle, foundedAt: input.at, source, photo: row.photo, width: row.width, height: row.height });
    for (const other of this.requests) {
      if (other.id !== row.id && other.parkId === row.parkId && other.status === "pending") Object.assign(other, { status: "superseded", decidedAt: input.at });
    }
    Object.assign(row, { status: "approved", decidedAt: input.at, foundedParkId: parkId });
    this.events.push({ type: "founding_review_decided", parkId, properties: { decision: "approved", source } }, { type: "park_founded", parkId, properties: { source, via: "review" } });
    return { parkId, parkName: park.name, source };
  }

  async reject(id: string, input: { at: string; reasonCode: ReviewReasonCode; reason: string }) {
    const row = this.pending(id);
    Object.assign(row, { status: "rejected", decidedAt: input.at, reasonCode: input.reasonCode, reason: input.reason });
    this.events.push({ type: "founding_review_decided", parkId: row.parkId, properties: { decision: "rejected", reason_code: input.reasonCode } });
  }
}

// ---------------------------------------------------------------- demo data

/** A landscape card standing in for a player's photo; people and dark ones show why the check said no. */
export function demoPhoto(seed: number, mood: "plain" | "people" | "dark" | "screen"): CoverPhoto {
  const hues = [[150, 200], [28, 205], [95, 190], [190, 45], [130, 215]][seed % 5];
  const people = mood === "people" ? `<g fill="#3b2f2f"><circle cx="300" cy="248" r="16"/><rect x="286" y="266" width="28" height="62" rx="12"/><circle cx="352" cy="256" r="13"/><rect x="341" y="271" width="23" height="54" rx="10"/></g>` : "";
  const dark = mood === "dark" ? `<rect width="1280" height="840" fill="#05080a" opacity=".78"/><circle cx="980" cy="160" r="26" fill="#f4f1d0" opacity=".6"/>` : "";
  const screen = mood === "screen" ? `<rect x="40" y="40" width="1200" height="760" rx="36" fill="none" stroke="#1d1d1f" stroke-width="56"/><rect x="560" y="70" width="160" height="18" rx="9" fill="#2c2c2e"/>` : "";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="840" viewBox="0 0 640 420">
<defs><linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="hsl(${hues[1]} 70% 78%)"/><stop offset="1" stop-color="hsl(${hues[1] - 20} 60% 92%)"/></linearGradient></defs>
<rect width="640" height="420" fill="url(#s)"/><circle cx="${470 - seed * 23}" cy="96" r="38" fill="hsl(45 95% 70%)"/>
<path d="M0 290 L120 180 L230 270 L350 150 L470 260 L640 170 L640 420 L0 420 Z" fill="hsl(${hues[0]} 28% 48%)"/>
<path d="M0 330 Q160 270 320 320 T640 300 L640 420 L0 420 Z" fill="hsl(${hues[0]} 45% 34%)"/>
${Array.from({ length: 9 }, (_, index) => `<path d="M${40 + index * 68} 360 l16 -52 l16 52 z" fill="hsl(${hues[0]} 50% ${22 + (index % 3) * 4}%)"/>`).join("")}
${people}<g transform="scale(.5)">${dark}${screen}</g>
</svg>`;
  const bytes = new TextEncoder().encode(svg);
  let hash = 0;
  for (const byte of bytes) hash = (Math.imul(hash, 31) + byte) >>> 0;
  return { bytes, contentType: "image/svg+xml", sha256: hash.toString(16).padStart(8, "0").repeat(8) };
}

type Probabilities = Partial<Record<"verdict" | "people" | "lighting" | "not_park" | "inappropriate" | "not_photo" | "personal_info", number>>;

/** Model answers in the stored shape: the verdict's approve probability and each flag's yes. */
export function demoModeration(answers: Probabilities): NonNullable<ReviewDetail["moderation"]> {
  const approve = answers.verdict ?? 0.1;
  const flag = (yes: number) => ({ choice: yes > 0.5 ? "yes" : "no", probabilities: { yes, no: Math.round((1 - yes) * 1000) / 1000 } });
  return {
    model: "openai/gpt-6-luna-decisions",
    threshold: 0.8,
    answers: {
      verdict: { choice: approve >= 0.5 ? "approve" : approve > 0.3 ? "unsure" : "reject", probabilities: { approve, reject: Math.round((1 - approve) * 700) / 1000, unsure: Math.round((1 - approve) * 300) / 1000 } },
      people: flag(answers.people ?? 0.02),
      lighting: flag(answers.lighting ?? 0.03),
      not_park: flag(answers.not_park ?? 0.04),
      inappropriate: flag(answers.inappropriate ?? 0.01),
      not_photo: flag(answers.not_photo ?? 0.02),
      personal_info: flag(answers.personal_info ?? 0.01),
    },
  };
}

/** Realistic requests over the demo parks: three waiting, one approved, one rejected, one beaten to it. */
export function seedDemoReviews(store: MemoryFoundingReviewStore, now: number): void {
  const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
  const feature = (name: string) => store.osm.features.find((item) => item.name === name) ?? null;
  const centre = (geometry: { coordinates: number[][][][] }, dx = 0, dy = 0) => {
    const ring = geometry.coordinates[0][0];
    const lng = ring.reduce((sum, point) => sum + point[0], 0) / ring.length, lat = ring.reduce((sum, point) => sum + point[1], 0) / ring.length;
    return { lng: Math.round((lng + dx) * 1e6) / 1e6, lat: Math.round((lat + dy) * 1e6) / 1e6 };
  };
  type Defaulted = "width" | "height" | "decidedAt" | "reasonCode" | "reason" | "foundedParkId" | "seenAt";
  const base: Pick<MemoryReview, Defaulted> = { width: 1280, height: 840, decidedAt: null, reasonCode: null, reason: null, foundedParkId: null, seenAt: null };
  const add = (row: Omit<MemoryReview, Defaulted> & Partial<Pick<MemoryReview, Defaulted>>) => store.requests.push({ ...base, ...row });

  const gonzales = feature("Gonzales Hill Regional Park");
  if (gonzales) {
    add({
      id: "6f3d2b1a-8c4e-4f7a-9b2d-1e5c7a9b3d01", accountId: "demo-7", handle: "trail_tia", status: "pending", parkId: osmParkId(gonzales), parkName: gonzales.name!,
      feature: gonzales, outcome: "reject", flags: ["people"], position: { ...centre(gonzales.geometry, 0.0002, -0.0001), accuracyM: 9 },
      photo: demoPhoto(1, "people"), moderation: demoModeration({ verdict: 0.08, people: 0.91 }), createdAt: ago(185), checkedAt: ago(188),
    });
  }
  const thetis = store.live.parks.get("thetis-lake-park");
  if (thetis) {
    add({
      id: "0b7e9a52-4c1d-4f7e-9a51-2d8c6b3f1e07", accountId: "demo-12", handle: "fern_gully", status: "pending", parkId: thetis.id, parkName: thetis.name,
      feature: null, outcome: "unsure", flags: [], position: { lat: thetis.lat + 0.0011, lng: thetis.lng - 0.0016, accuracyM: 14 },
      photo: demoPhoto(2, "plain"), moderation: demoModeration({ verdict: 0.62, not_park: 0.31 }), createdAt: ago(52), checkedAt: ago(54),
    });
  }
  const hollywood = feature("Hollywood Park");
  if (hollywood) {
    add({
      id: "9a41c0de-2b7f-4e3a-8d6c-5f1b2a7e9c44", accountId: "demo-3", handle: "owl_eyes", status: "pending", parkId: osmParkId(hollywood), parkName: hollywood.name!,
      feature: hollywood, outcome: "reject", flags: ["lighting"], position: { ...centre(hollywood.geometry), accuracyM: 6 },
      photo: demoPhoto(3, "dark"), moderation: demoModeration({ verdict: 0.12, lighting: 0.84 }), createdAt: ago(21), checkedAt: ago(22),
    });
  }
  const cattle = store.live.parks.get("cattle-point");
  const cattleFounder = store.manager.founders.get("cattle-point");
  if (cattle && cattleFounder) {
    add({
      id: "5d0c8e17-3a9b-4c2d-b6e1-7f4a0c9d2b58", accountId: "demo-4", handle: cattleFounder.handle, status: "approved", parkId: cattle.id, parkName: cattle.name,
      feature: null, outcome: "unsure", flags: [], position: { lat: cattle.lat - 0.0003, lng: cattle.lng + 0.0002, accuracyM: 11 },
      photo: cattleFounder.photo, moderation: demoModeration({ verdict: 0.71 }), createdAt: ago(1_560), checkedAt: ago(1_565),
      decidedAt: cattleFounder.foundedAt, foundedParkId: cattle.id, seenAt: ago(1_300),
    });
  }
  const douglas = store.live.parks.get("mount-douglas-park");
  if (douglas) {
    add({
      id: "2c8b4f6e-1d3a-4b5c-9e7f-0a2d4c6e8b19", accountId: "demo-0", handle: "summit_sam", status: "rejected", parkId: douglas.id, parkName: douglas.name,
      feature: null, outcome: "reject", flags: ["not_photo"], position: { lat: douglas.lat + 0.0021, lng: douglas.lng + 0.0012, accuracyM: 18 },
      photo: demoPhoto(4, "screen"), moderation: demoModeration({ verdict: 0.05, not_photo: 0.88 }), createdAt: ago(2_900), checkedAt: ago(2_902),
      decidedAt: ago(2_700), reasonCode: "other", reason: "That's a photo of a screen. Take one of the park itself.",
    });
  }
  const highrock = store.live.parks.get("osm-relation-6012450");
  const highrockFounder = store.manager.founders.get("osm-relation-6012450");
  if (highrock && highrockFounder) {
    add({
      id: "c3e2a9f1-6b8d-4e0c-a2f5-9d7b1c3e5a60", accountId: "demo-9", handle: "kip_fan_22", status: "superseded", parkId: highrock.id, parkName: highrock.name,
      feature: null, outcome: "reject", flags: ["people", "personal_info"], position: { lat: highrock.lat, lng: highrock.lng + 0.0004, accuracyM: 8 },
      photo: demoPhoto(0, "people"), moderation: demoModeration({ verdict: 0.04, people: 0.77, personal_info: 0.58 }),
      createdAt: new Date(Date.parse(highrockFounder.foundedAt) - 95 * 60_000).toISOString(), checkedAt: new Date(Date.parse(highrockFounder.foundedAt) - 97 * 60_000).toISOString(),
      decidedAt: highrockFounder.foundedAt,
    });
  }
}
