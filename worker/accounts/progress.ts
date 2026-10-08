import { HttpError } from "../validation.js";
import { createProgressStore, type ProgressStore } from "./progress-store.js";
import { deleteAccountData, handlePhotoRequest, isPhotoRoute, type PhotoDependencies } from "./photos.js";
import type { AccountAuthContext, ClaimPayload, ClaimRecord, ParkSnapshot, ProgressEnv } from "./progress-types.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PARK_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_CLAIM_BYTES = 16 * 1024;
const PAGE_SIZE = 50;
const CATEGORY = new Set(["national", "provincial", "regional", "municipal", "community"]);
const BIOME = new Set(["coast", "forest", "mountain", "lake", "waterfall", "river", "cave", "marsh", "heritage"]);
const SHAPE = new Set(["circle", "hex", "shield", "arch", "seal"]);
const RARITY = new Set(["common", "uncommon", "rare", "epic", "legendary"]);
const PARK_KEYS = ["id", "name", "short", "category", "region", "lat", "lng", "biome", "shape", "rarity", "seed", "blurb", "scene"];

export type { AccountAuthContext, ProgressEnv } from "./progress-types.js";
export type { ProgressStore } from "./progress-store.js";
export { deleteAccountData };

export interface ProgressDependencies extends PhotoDependencies {
  createStore?: (env: ProgressEnv) => ProgressStore;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

function errorResponse(error: unknown): Response {
  if (error instanceof HttpError) {
    return json({ error: { code: error.code, message: error.message }, code: error.code, message: error.message }, error.status);
  }
  return json({ error: { code: "service_unavailable", message: "Progress service is unavailable." }, code: "service_unavailable", message: "Progress service is unavailable." }, 503);
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function boundedText(value: unknown, label: string, max: number): string {
  if (typeof value !== "string") throw new HttpError(400, "invalid_request", `Invalid ${label}.`);
  const normalized = value.trim();
  if (!normalized || normalized.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(normalized)) {
    throw new HttpError(400, "invalid_request", `Invalid ${label}.`);
  }
  return normalized;
}

export function validateParkSnapshot(value: unknown, parkId: string): ParkSnapshot {
  if (!record(value) || !hasExactKeys(value, PARK_KEYS)) throw new HttpError(400, "invalid_request", "Invalid park snapshot.");
  const id = boundedText(value.id, "park id", 160);
  if (!PARK_ID.test(id) || id !== parkId) throw new HttpError(400, "invalid_request", "Park snapshot ID must match the claim park ID.");
  const category = value.category;
  const biome = value.biome;
  const shape = value.shape;
  const rarity = value.rarity;
  if (typeof category !== "string" || !CATEGORY.has(category) || typeof biome !== "string" || !BIOME.has(biome) ||
    typeof shape !== "string" || !SHAPE.has(shape) || typeof rarity !== "string" || !RARITY.has(rarity)) {
    throw new HttpError(400, "invalid_request", "Invalid park snapshot.");
  }
  if (typeof value.lat !== "number" || !Number.isFinite(value.lat) || value.lat < -90 || value.lat > 90 ||
    typeof value.lng !== "number" || !Number.isFinite(value.lng) || value.lng < -180 || value.lng > 180 ||
    typeof value.seed !== "number" || !Number.isSafeInteger(value.seed) || value.seed < 0 || value.seed > 1_000_000) {
    throw new HttpError(400, "invalid_request", "Invalid park snapshot.");
  }
  const scene = value.scene === null ? null : boundedText(value.scene, "park scene", 80);
  if (scene !== null && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/i.test(scene)) throw new HttpError(400, "invalid_request", "Invalid park snapshot.");
  return {
    id,
    name: boundedText(value.name, "park name", 140),
    short: boundedText(value.short, "park short name", 140),
    category: category as ParkSnapshot["category"],
    region: boundedText(value.region, "park region", 140),
    lat: value.lat,
    lng: value.lng,
    biome: biome as ParkSnapshot["biome"],
    shape: shape as ParkSnapshot["shape"],
    rarity: rarity as ParkSnapshot["rarity"],
    seed: value.seed,
    blurb: boundedText(value.blurb, "park blurb", 800),
    scene,
  };
}

function validateClaimBody(value: unknown, claimId: string): Omit<ClaimPayload, "claimId"> {
  const keys = ["parkId", "claimedAt", "parkSnapshot", "contentReleaseId"];
  if (!record(value) || !hasExactKeys(value, keys)) throw new HttpError(400, "invalid_request", "Invalid claim.");
  const parkId = boundedText(value.parkId, "park id", 160);
  if (!PARK_ID.test(parkId)) throw new HttpError(400, "invalid_request", "Invalid park ID.");
  if (typeof value.claimedAt !== "string" || value.claimedAt.length > 64 || !Number.isFinite(Date.parse(value.claimedAt))) {
    throw new HttpError(400, "invalid_request", "Invalid claim time.");
  }
  const claimedAt = new Date(value.claimedAt).toISOString();
  if (Date.parse(claimedAt) > Date.now() + 10 * 60 * 1000) throw new HttpError(400, "invalid_request", "Claim time cannot be in the future.");
  const contentReleaseId = value.contentReleaseId === null ? null : boundedText(value.contentReleaseId, "content release ID", 128);
  if (contentReleaseId !== null && !/^[A-Za-z0-9._-]+$/.test(contentReleaseId)) throw new HttpError(400, "invalid_request", "Invalid content release ID.");
  return { parkId, claimedAt, parkSnapshot: validateParkSnapshot(value.parkSnapshot, parkId), contentReleaseId };
}

async function readJson(request: Request): Promise<unknown> {
  if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
    throw new HttpError(415, "invalid_content_type", "Claim must be JSON.");
  }
  const contentLength = request.headers.get("content-length");
  if (contentLength && /^\d+$/.test(contentLength) && Number(contentLength) > MAX_CLAIM_BYTES) {
    throw new HttpError(413, "request_too_large", "Claim request is too large.");
  }
  if (!request.body) throw new HttpError(400, "invalid_request", "Claim request body is required.");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_CLAIM_BYTES) {
        await reader.cancel();
        throw new HttpError(413, "request_too_large", "Claim request is too large.");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new HttpError(400, "invalid_request", "Invalid JSON claim.");
  }
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function payloadHash(payload: Omit<ClaimPayload, "claimId">): Promise<string> {
  return sha256Hex(JSON.stringify({
    parkId: payload.parkId,
    claimedAt: payload.claimedAt,
    parkSnapshot: payload.parkSnapshot,
    contentReleaseId: payload.contentReleaseId,
  }));
}

function apiClaim(claim: ClaimRecord) {
  return {
    claimId: claim.claimId,
    parkId: claim.parkId,
    claimedAt: claim.claimedAt,
    parkSnapshot: claim.parkSnapshot,
    contentReleaseId: claim.contentReleaseId,
    createdAt: claim.createdAt,
    photo: claim.photo,
  };
}

function encodeCursor(accountId: string, row: ClaimRecord): string {
  const jsonValue = JSON.stringify({ accountId, revision: row.syncRevision });
  const bytes = new TextEncoder().encode(jsonValue);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeCursor(value: string, accountId: string): string {
  if (value.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new HttpError(400, "invalid_cursor", "Invalid claim cursor.");
  try {
    const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(base64 + "=".repeat((4 - base64.length % 4) % 4));
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
    if (!record(parsed) || !hasExactKeys(parsed, ["accountId", "revision"]) || parsed.accountId !== accountId ||
      typeof parsed.revision !== "string" || !/^(?:0|[1-9][0-9]{0,18})$/.test(parsed.revision) || BigInt(parsed.revision) > 9_223_372_036_854_775_807n) {
      throw new Error("invalid cursor");
    }
    return parsed.revision;
  } catch {
    throw new HttpError(400, "invalid_cursor", "Invalid claim cursor.");
  }
}

async function listClaims(request: Request, accountId: string, store: ProgressStore): Promise<Response> {
  const url = new URL(request.url);
  if (Array.from(url.searchParams.keys()).some((key) => key !== "cursor") || url.searchParams.getAll("cursor").length > 1) {
    throw new HttpError(400, "invalid_query", "Invalid claim list query.");
  }
  const token = url.searchParams.get("cursor");
  const cursor = token === null ? null : decodeCursor(token, accountId);
  const page = await store.listClaims(accountId, cursor, PAGE_SIZE);
  const claims = page.rows.map(apiClaim);
  const nextCursor = page.rows.length > 0 ? encodeCursor(accountId, page.rows[page.rows.length - 1]) : null;
  return json({ claims, nextCursor });
}

async function putClaim(request: Request, accountId: string, claimId: string, store: ProgressStore): Promise<Response> {
  const body = await readJson(request);
  const payload = validateClaimBody(body, claimId);
  const complete: ClaimPayload = { claimId, ...payload };
  const hash = await payloadHash(payload);
  const saved = await store.putClaim(accountId, complete, hash);
  if (saved.status === "unavailable") throw new HttpError(410, "account_deleting", "This account is being deleted.");
  if (saved.status === "conflict") throw new HttpError(409, "claim_conflict", "This claim ID was already used for different claim data.");
  return json({ claim: apiClaim(saved.claim) }, saved.status === "created" ? 201 : 200);
}

export async function handleProgressRequest(
  request: Request,
  env: ProgressEnv,
  auth: AccountAuthContext | null,
  dependencies: ProgressDependencies = {},
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== "/api/claims" && !/^\/api\/claims\/[^/]+(?:\/photo)?$/.test(url.pathname)) return null;
  try {
    if (isPhotoRoute(request)) {
      const photoMatch = /^\/api\/claims\/([^/]+)\/photo$/.exec(url.pathname);
      if (request.method !== "GET" && request.method !== "PUT") {
        return json({ error: { code: "method_not_allowed", message: "Method not allowed." }, code: "method_not_allowed", message: "Method not allowed." }, 405);
      }
      if (!auth || !UUID.test(auth.accountId)) {
        return json({ error: { code: "unauthorized", message: "Sign in is required." }, code: "unauthorized", message: "Sign in is required." }, 401);
      }
      if (!photoMatch || !UUID.test(photoMatch[1])) {
        return json({ error: { code: "not_found", message: "Claim not found." }, code: "not_found", message: "Claim not found." }, 404);
      }
      const store = dependencies.createStore?.(env) ?? createProgressStore(env);
      return await handlePhotoRequest(request, env, auth, store, dependencies);
    }
    if (request.method !== "GET" && request.method !== "PUT") {
      return json({ error: { code: "method_not_allowed", message: "Method not allowed." }, code: "method_not_allowed", message: "Method not allowed." }, 405);
    }
    if (!auth || !UUID.test(auth.accountId)) {
      return json({ error: { code: "unauthorized", message: "Sign in is required." }, code: "unauthorized", message: "Sign in is required." }, 401);
    }
    const store = dependencies.createStore?.(env) ?? createProgressStore(env);
    if (url.pathname === "/api/claims") {
      if (request.method !== "GET") return json({ error: { code: "method_not_allowed", message: "Method not allowed." }, code: "method_not_allowed", message: "Method not allowed." }, 405);
      return await listClaims(request, auth.accountId.toLowerCase(), store);
    }
    const match = /^\/api\/claims\/([^/]+)$/.exec(url.pathname);
    if (!match) return null;
    const claimId = match[1].toLowerCase();
    if (!UUID.test(claimId)) return json({ error: { code: "not_found", message: "Claim not found." }, code: "not_found", message: "Claim not found." }, 404);
    if (request.method !== "PUT") return json({ error: { code: "method_not_allowed", message: "Method not allowed." }, code: "method_not_allowed", message: "Method not allowed." }, 405);
    return await putClaim(request, auth.accountId.toLowerCase(), claimId, store);
  } catch (error) {
    return errorResponse(error);
  }
}
