// The operator dashboard owns the draft table and its publish transaction. Instant publishing
// reuses that exact transaction so a park approved by the model reaches phones the same way.
import { guessBiome, publishStatements, SHAPE_FOR_CATEGORY, shortName, type SqlRunner } from "../operator/server/drafts.js";
import { positionCount, simplifyMultiPolygon, type MultiPolygon, type OsmFeature } from "./osmParks.js";
import { provinceOfOutline } from "./provinces.js";

export type { SqlRunner };

const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/**
 * Every content snapshot must stay under 4 MiB (docs/learnings/content-snapshot-size.md), and a
 * proposed park reaches every reader, so its boundary is thinned until it has at most this many
 * positions. Every part and hole stays; only redundant vertices go.
 */
export const MAX_BOUNDARY_POSITIONS = 2_000;

export function contentBoundary(geometry: MultiPolygon): MultiPolygon {
  let thinned = geometry;
  for (let toleranceM = 2; positionCount(thinned) > MAX_BOUNDARY_POSITIONS && toleranceM <= 128; toleranceM *= 2) {
    thinned = simplifyMultiPolygon(geometry, toleranceM);
  }
  return thinned;
}

/** A stable, unique park id for an OpenStreetMap feature, valid for content and claim backups. */
export function osmParkId(feature: { type: string; id: number }): string {
  return `osm-${feature.type}-${feature.id}`;
}

/** The same 0 to 1,000,000 range the dashboard draws from, derived from the id so retries agree. */
export function seedFor(id: string): number {
  let hash = 2166136261;
  for (const char of id) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0;
  return hash % 1_000_001;
}

// Parks Canada runs the national parks and park reserves in both provinces, named in English or French.
const NATIONAL = /\bnational park\b|\bparks canada\b|\bparcs canada\b/;
// BC Parks and its ecological reserves, and Nova Scotia's provincial parks, protected
// wilderness areas and the provincial departments that run them.
const PROVINCIAL = new RegExp([
  /\bprovincial (?:wildlife )?park\b/.source,
  /\becological reserve\b/.source,
  /\bbc parks\b/.source,
  /\bwilderness area\b/.source,
  /\bnova scotia (?:provincial parks|department of natural resources|natural resources and renewables|environment and climate change)\b/.source,
  /\bprovince of nova scotia\b/.source,
].join("|"));

/** Only categories every installed build accepts (docs/content-compatibility.md). */
export function categoryFor(feature: Pick<OsmFeature, "name" | "tags">): string {
  const text = `${feature.name ?? ""} ${feature.tags.protection_title ?? ""} ${feature.tags.operator ?? ""}`.toLowerCase();
  if (feature.tags.boundary === "national_park" || NATIONAL.test(text)) return "national";
  if (PROVINCIAL.test(text)) return "provincial";
  if (/\bregional park\b|\bregional district\b|\bcrd\b/.test(text)) return "regional";
  if (feature.tags.leisure === "park" || feature.tags.leisure === "garden" || feature.tags.leisure === "dog_park") return "municipal";
  return "community";
}

export function biomeFor(feature: Pick<OsmFeature, "tags">, name: string): string {
  const guess = guessBiome(name);
  if (guess !== "forest") return guess;
  if (feature.tags.natural === "wetland") return "marsh";
  if (feature.tags.natural === "beach" || feature.tags.natural === "coastline") return "coast";
  return guess;
}

function blurbFor(feature: Pick<OsmFeature, "tags">): string {
  if (feature.tags.leisure === "nature_reserve") return "A nature reserve added to Parkdex by a player.";
  if (feature.tags.leisure === "garden") return "A public garden added to Parkdex by a player.";
  if (feature.tags.leisure === "common") return "A shared green space added to Parkdex by a player.";
  if (feature.tags.boundary) return "A protected area added to Parkdex by a player.";
  return "A local park added to Parkdex by a player.";
}

function plainText(value: string, max: number): string {
  return value.replace(CONTROL, " ").replace(/\s+/g, " ").trim().slice(0, max).trim();
}

export interface ProposalProvenance {
  id: string;
  name: string;
  note: string;
  point: [number, number];
  createdAt: string;
}

export interface PublishablePark {
  id: string;
  name: string;
  short: string;
  category: string;
  region: string;
  lat: number;
  lng: number;
  biome: string;
  shape: string;
  rarity: string;
  seed: number;
  blurb: string;
  geometry: MultiPolygon;
  source: Record<string, unknown>;
}

/**
 * Every field the claim snapshot and account contract validators need: text within limits and
 * free of control characters, a nonempty region and blurb, known enum values and no scene.
 */
export function parkFromProposal(feature: OsmFeature, proposal: ProposalProvenance, region: string, pin: [number, number]): PublishablePark {
  const id = osmParkId(feature);
  const name = plainText(feature.name ?? proposal.name, 140) || plainText(proposal.name, 140) || "Unnamed park";
  const category = categoryFor({ name, tags: feature.tags });
  return {
    id,
    name,
    short: plainText(shortName(name), 140) || name,
    category,
    // Without a region from a park nearby, the province that holds the outline.
    region: plainText(region, 140) || provinceOfOutline(feature.geometry),
    // The proposer's pin is where they stood or tapped, so it makes a sensible marker.
    lat: pin[1],
    lng: pin[0],
    biome: biomeFor(feature, name),
    shape: SHAPE_FOR_CATEGORY[category] ?? "circle",
    rarity: "common",
    seed: seedFor(id),
    blurb: blurbFor(feature),
    geometry: contentBoundary(feature.geometry),
    source: { proposal, osm: { type: feature.type, id: feature.id, name: feature.name, kind: feature.kind, tags: feature.tags, areaM2: feature.areaM2 } },
  };
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
}

export type PublishOutcome =
  | { status: "published"; parkId: string; revision: number | null }
  | { status: "already_published"; parkId: string }
  | { status: "blocked"; reason: "park_exists" | "draft_conflict" };

type DraftState = { status: string; updated_at: unknown; proposal_id: string | null } | undefined;

async function draftState(db: SqlRunner, parkId: string): Promise<{ draft: DraftState; live: boolean }> {
  const [drafts, parks] = await Promise.all([
    db.query("SELECT status, updated_at, source->'proposal'->>'id' AS proposal_id FROM kip_park_drafts.drafts WHERE id = $1", [parkId]),
    db.query("SELECT 1 FROM public.parks WHERE id = $1", [parkId]),
  ]);
  return { draft: drafts[0] as DraftState, live: parks.length > 0 };
}

function acceptStatement(proposalId: string, parkId: string) {
  return {
    text: `UPDATE kip_proposals.parks SET status = 'accepted', published_park_id = $2, updated_at = now() WHERE id = $1::uuid`,
    params: [proposalId, parkId],
  };
}

/**
 * Writes the park as a draft, then publishes it with the dashboard's transaction plus the
 * proposal's acceptance. Safe to retry: a park already published from this proposal is
 * reported as done, and anything else already using the id blocks publication.
 */
export async function publishProposalPark(db: SqlRunner, park: PublishablePark, proposalId: string): Promise<PublishOutcome> {
  // Claim backups reject a park with an empty region, name or blurb, so never publish one.
  if (![park.name, park.short, park.region, park.blurb].every((text) => text.trim().length > 0)) throw new Error("park_incomplete");
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const { draft, live } = await draftState(db, park.id);
    const ours = draft?.proposal_id === proposalId;
    if (live) {
      if (draft?.status === "published" && ours) {
        await db.query(acceptStatement(proposalId, park.id).text, acceptStatement(proposalId, park.id).params);
        return { status: "already_published", parkId: park.id };
      }
      return { status: "blocked", reason: "park_exists" };
    }
    if (draft && !ours) return { status: "blocked", reason: "draft_conflict" };
    let updatedAt = draft ? new Date(draft.updated_at as string).toISOString() : null;
    if (!draft) {
      const sourceSha256 = await sha256Hex(JSON.stringify(park.source));
      const inserted = await db.query(
        `INSERT INTO kip_park_drafts.drafts (id, source, source_sha256, geometry, name, short, category, region, lat, lng, biome, shape, rarity, seed, blurb)
         SELECT $1, $2::jsonb, $3, $4::jsonb, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15
         WHERE NOT EXISTS (SELECT 1 FROM public.parks WHERE id = $1)
         ON CONFLICT (id) DO NOTHING RETURNING updated_at`,
        [park.id, JSON.stringify(park.source), sourceSha256, JSON.stringify(park.geometry), park.name, park.short, park.category, park.region,
          park.lat, park.lng, park.biome, park.shape, park.rarity, park.seed, park.blurb],
      );
      // Someone else wrote the draft between our read and insert; look again.
      if (!inserted.length) continue;
      updatedAt = new Date(inserted[0].updated_at as string).toISOString();
    }
    try {
      // The acceptance goes first so that, when the park row is inserted, the proposal already
      // names it: the category soft-hide keeps parks that players proposed on the map.
      const results = await db.transaction([acceptStatement(proposalId, park.id), ...publishStatements(park.id, updatedAt!, null)]);
      const revision = results[results.length - 1]?.[0]?.published_revision;
      return { status: "published", parkId: park.id, revision: revision === null || revision === undefined ? null : Number(revision) };
    } catch (error) {
      // A concurrent retry may have published first; the next pass reports that as done.
      if (attempt === 0 && error instanceof Error && /park_exists|draft_changed/.test(error.message)) continue;
      throw error;
    }
  }
  return { status: "blocked", reason: "draft_conflict" };
}
