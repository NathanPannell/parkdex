import assert from "node:assert/strict";
import { test } from "node:test";
import { deleteAccountData, handleProgressRequest } from "./accounts/progress.js";
import type { ProgressStore } from "./accounts/progress-store.js";
import type {
  AccountAuthContext,
  ClaimDisplay,
  ClaimDisplayRecord,
  ClaimPayload,
  ClaimRecord,
  PhotoContentType,
  PhotoMetadata,
  ProgressEnv,
} from "./accounts/progress-types.js";

const ACCOUNT_A = "ae172e85-a8ab-4e1d-a032-901100000001";
const ACCOUNT_B = "ae172e85-a8ab-4e1d-a032-901100000002";
const CLAIM_A = "be172e85-a8ab-4e1d-a032-901100000001";
const CLAIM_B = "be172e85-a8ab-4e1d-a032-901100000002";
const RECEIPT = "ce172e85-a8ab-4e1d-a032-901100000001";
const PHOTO_SERVICE = "https://private-photos.example.test";
const PHOTO_TOKEN = "test-private-service-token";
const CONTENT_TYPE = "image/jpeg" as const;

const authA: AccountAuthContext = { accountId: ACCOUNT_A, sessionId: "session-a", transport: "bearer" };
const authB: AccountAuthContext = { accountId: ACCOUNT_B, sessionId: "session-b", transport: "bearer" };
const env: ProgressEnv = { KIP_PHOTO_SERVICE_URL: PHOTO_SERVICE, KIP_PHOTO_SERVICE_TOKEN: PHOTO_TOKEN };

function claimPayload(claimId: string, name = "Pacific Rim National Park Reserve"): Omit<ClaimPayload, "claimId"> {
  return {
    parkId: "national-pacific-rim-national-park-reserve",
    claimedAt: "2026-09-20T18:12:41.000Z",
    parkSnapshot: {
      id: "national-pacific-rim-national-park-reserve",
      name,
      short: "Pacific Rim",
      category: "national",
      region: "West Coast",
      lat: 49.06041,
      lng: -125.7228,
      biome: "coast",
      shape: "seal",
      rarity: "legendary",
      seed: 341,
      blurb: "Surf, rainforest and Long Beach.",
      scene: "legendary-a",
    },
    contentReleaseId: "f".repeat(64),
  };
}

function jsonRequest(url: string, method: string, body?: unknown, headers: HeadersInit = {}): Request {
  const requestHeaders = new Headers(headers);
  if (body !== undefined) requestHeaders.set("content-type", "application/json");
  return new Request(url, {
    method,
    headers: requestHeaders,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function claimRequest(claimId: string, body: unknown): Request {
  return jsonRequest(`https://api.example.test/api/claims/${claimId}`, "PUT", body);
}

function jpegBytes(size = 4): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes.set([0xff, 0xd8, 0xff]);
  return bytes;
}

async function digest(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes).buffer);
  return Array.from(new Uint8Array(hash), (value) => value.toString(16).padStart(2, "0")).join("");
}

function claimKey(accountId: string, claimId: string): string {
  return `${accountId}:${claimId}`;
}

class MemoryProgressStore implements ProgressStore {
  readonly claims = new Map<string, ClaimRecord>();
  readonly photos = new Map<string, PhotoMetadata>();
  readonly deletionObjects = new Map<string, Set<string>>();
  readonly deletionAttempts = new Map<string, number>();
  readonly revisions = new Map<string, bigint>();
  readonly displays = new Map<string, ClaimDisplayRecord>();
  displayClock = 0;

  async listClaimDisplays(accountId: string, limit: number) {
    return [...this.displays.entries()]
      .filter(([key]) => key.startsWith(`${accountId}:`))
      .map(([, row]) => structuredClone(row))
      .slice(0, limit);
  }

  async putClaimDisplay(accountId: string, claimId: string, display: ClaimDisplay) {
    if (!this.claims.has(claimKey(accountId, claimId))) return { status: "claim_missing" as const };
    this.displayClock += 1;
    const saved: ClaimDisplayRecord = {
      claimId,
      ...structuredClone(display),
      updatedAt: new Date(Date.UTC(2026, 9, 1, 0, 0, this.displayClock)).toISOString(),
    };
    this.displays.set(claimKey(accountId, claimId), saved);
    return { status: "saved" as const, display: structuredClone(saved) };
  }

  nextRevision(accountId: string): string {
    const next = (this.revisions.get(accountId) ?? 0n) + 1n;
    this.revisions.set(accountId, next);
    return next.toString();
  }

  async putClaim(accountId: string, claim: ClaimPayload, payloadHash: string) {
    const key = claimKey(accountId, claim.claimId);
    const existing = this.claims.get(key);
    if (existing)
      return existing.payloadHash === payloadHash ? { status: "identical" as const, claim: structuredClone(existing) } : { status: "conflict" as const };
    const saved: ClaimRecord = {
      ...structuredClone(claim),
      payloadHash,
      createdAt: "2026-09-27T00:00:00.000000Z",
      syncRevision: this.nextRevision(accountId),
      photo: { status: "missing" },
    };
    this.claims.set(key, saved);
    return { status: "created" as const, claim: structuredClone(saved) };
  }

  async listClaims(accountId: string, cursorRevision: string | null, limit: number) {
    const rows = [...this.claims.entries()]
      .filter(([key]) => key.startsWith(`${accountId}:`))
      .map(([, row]) => row)
      .sort((left, right) =>
        BigInt(left.syncRevision) < BigInt(right.syncRevision)
          ? -1
          : BigInt(left.syncRevision) > BigInt(right.syncRevision)
            ? 1
            : left.claimId.localeCompare(right.claimId),
      )
      .filter((row) => cursorRevision === null || BigInt(row.syncRevision) > BigInt(cursorRevision));
    const page = rows.slice(0, limit);
    return { rows: page.map((row) => structuredClone(row)), hasMore: rows.length > limit };
  }

  async getClaim(accountId: string, claimId: string) {
    const row = this.claims.get(claimKey(accountId, claimId));
    return row ? structuredClone(row) : null;
  }

  async reservePhoto(accountId: string, claimId: string, photo: Omit<PhotoMetadata, "status" | "createdAt">) {
    const key = claimKey(accountId, claimId);
    if (!this.claims.has(key)) return { status: "claim_missing" as const };
    const existing = this.photos.get(key);
    if (existing) {
      return existing.sha256 === photo.sha256 ? { status: "existing" as const, photo: structuredClone(existing) } : { status: "conflict" as const };
    }
    const saved: PhotoMetadata = { ...photo, status: "pending", createdAt: "2026-09-27T00:00:00.000Z" };
    const claim = this.claims.get(key)!;
    claim.syncRevision = this.nextRevision(accountId);
    claim.photo = { status: "pending" };
    this.photos.set(key, saved);
    return { status: "reserved" as const, photo: structuredClone(saved) };
  }

  async markPhotoReady(accountId: string, claimId: string, sha256: string) {
    const photo = this.photos.get(claimKey(accountId, claimId));
    if (!photo || photo.sha256 !== sha256) return false;
    if (photo.status === "ready") return true;
    photo.status = "ready";
    const claim = this.claims.get(claimKey(accountId, claimId));
    if (claim) {
      claim.syncRevision = this.nextRevision(accountId);
      claim.photo = { status: "ready", sha256: photo.sha256, sizeBytes: photo.sizeBytes, contentType: photo.contentType };
    }
    return true;
  }

  async getPhoto(accountId: string, claimId: string) {
    const photo = this.photos.get(claimKey(accountId, claimId));
    return photo ? structuredClone(photo) : null;
  }

  async snapshotDeletionPhotoObjects(receiptId: string, accountId: string) {
    const keys = this.deletionObjects.get(receiptId) ?? new Set<string>();
    for (const [key, photo] of this.photos) if (key.startsWith(`${accountId}:`)) keys.add(photo.objectKey);
    this.deletionObjects.set(receiptId, keys);
    return keys.size;
  }

  async listDeletionPhotoObjects(receiptId: string) {
    return [...(this.deletionObjects.get(receiptId) ?? [])];
  }

  async deleteAccountProgress(accountId: string) {
    for (const key of this.claims.keys()) if (key.startsWith(`${accountId}:`)) this.claims.delete(key);
    for (const key of this.photos.keys()) if (key.startsWith(`${accountId}:`)) this.photos.delete(key);
  }

  async recordPhotoDeletionFailure(receiptId: string) {
    this.deletionAttempts.set(receiptId, (this.deletionAttempts.get(receiptId) ?? 0) + 1);
  }

  async clearDeletionPhotoObjects(receiptId: string) {
    this.deletionObjects.delete(receiptId);
  }
}

class PrivatePhotoService {
  readonly objects = new Map<string, { bytes: Uint8Array; contentType: PhotoContentType; sha256: string }>();
  failAccountDelete = false;
  failPut = false;
  badPutAck = false;
  putCount = 0;
  deleteAccountCount = 0;

  async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const request = new Request(input, init);
    assert.equal(request.headers.get("authorization"), `Bearer ${PHOTO_TOKEN}`);
    const path = new URL(request.url).pathname;
    const objectMatch = /^\/v1\/objects\/(accounts\/[^/]+\/claims\/[^/]+)$/.exec(path);
    if (objectMatch) {
      const key = objectMatch[1];
      if (request.method === "PUT") {
        if (this.failPut) return new Response("unavailable", { status: 503 });
        const bytes = new Uint8Array(await request.arrayBuffer());
        const sha256 = await digest(bytes);
        assert.equal(request.headers.get("x-content-sha256"), sha256);
        const contentType = request.headers.get("content-type") as PhotoContentType;
        this.objects.set(key, { bytes, contentType, sha256 });
        this.putCount += 1;
        return new Response(null, { status: 204, headers: { "x-content-sha256": this.badPutAck ? "0".repeat(64) : sha256 } });
      }
      if (request.method === "GET") {
        const object = this.objects.get(key);
        if (!object) return new Response(null, { status: 404 });
        return new Response(new Uint8Array(object.bytes), {
          status: 200,
          headers: { "content-type": object.contentType, "x-content-sha256": object.sha256 },
        });
      }
      if (request.method === "DELETE") {
        this.objects.delete(key);
        return new Response(null, { status: 204 });
      }
    }
    const accountMatch = /^\/v1\/accounts\/([^/]+)$/.exec(path);
    if (accountMatch && request.method === "DELETE") {
      this.deleteAccountCount += 1;
      if (this.failAccountDelete) return new Response("unavailable", { status: 503 });
      const prefix = `accounts/${accountMatch[1]}/`;
      const keys = [...this.objects.keys()].filter((key) => key.startsWith(prefix)).slice(0, 100);
      for (const key of keys) this.objects.delete(key);
      const complete = ![...this.objects.keys()].some((key) => key.startsWith(prefix));
      return Response.json({ complete, deleted: keys.length });
    }
    return new Response(null, { status: 404 });
  }
}

function addClaim(store: MemoryProgressStore, accountId: string, claimId: string, name?: string) {
  const payload = claimPayload(claimId, name);
  const saved: ClaimRecord = {
    claimId,
    ...structuredClone(payload),
    payloadHash: "0".repeat(64),
    createdAt: "2026-09-27T00:00:00.000000Z",
    syncRevision: store.nextRevision(accountId),
    photo: { status: "missing" },
  };
  store.claims.set(claimKey(accountId, claimId), saved);
}

function photoRequest(claimId: string, method: string, bytes: Uint8Array, contentType: string): Request {
  return new Request(`https://api.example.test/api/claims/${claimId}/photo`, {
    method,
    headers: { "content-type": contentType },
    body: new Uint8Array(bytes).buffer,
  });
}

test("claim uploads are account scoped, idempotent, and conflict on changed retry payloads", async () => {
  const store = new MemoryProgressStore();
  const original = claimPayload(CLAIM_A);
  const deps = { createStore: () => store };

  const created = await handleProgressRequest(claimRequest(CLAIM_A, original), env, authA, deps);
  assert.equal(created?.status, 201);
  const retried = await handleProgressRequest(claimRequest(CLAIM_A, original), env, authA, deps);
  assert.equal(retried?.status, 200);
  const changed = await handleProgressRequest(claimRequest(CLAIM_A, claimPayload(CLAIM_A, "Changed title")), env, authA, deps);
  assert.equal(changed?.status, 409);

  const otherAccount = await handleProgressRequest(claimRequest(CLAIM_A, original), env, authB, deps);
  assert.equal(otherAccount?.status, 201);
  const pageA = await handleProgressRequest(new Request("https://api.example.test/api/claims"), env, authA, deps);
  const pageB = await handleProgressRequest(new Request("https://api.example.test/api/claims"), env, authB, deps);
  assert.equal(((await pageA?.json()) as { claims: unknown[] }).claims.length, 1);
  assert.equal(((await pageB?.json()) as { claims: unknown[] }).claims.length, 1);
});

test("all catalogue park categories upload and restore with their frozen category", async () => {
  const store = new MemoryProgressStore();
  const deps = { createStore: () => store };
  for (const [claimId, category, parkId, name] of [
    [CLAIM_A, "municipal", "municipal-city-of-victoria-1442", "Beacon Hill Park"],
    [CLAIM_B, "community", "community-cove", "Community Cove"],
    ["be172e85-a8ab-4e1d-a032-901100000003", "regional", "regional-qa-park", "QA Regional Park"],
    ["be172e85-a8ab-4e1d-a032-901100000004", "provincial", "provincial-qa-park", "QA Provincial Park"],
    ["be172e85-a8ab-4e1d-a032-901100000005", "national", "national-qa-park", "QA National Park"],
  ] as const) {
    const payload = claimPayload(claimId, name);
    payload.parkId = parkId;
    payload.parkSnapshot = { ...payload.parkSnapshot, id: parkId, category };
    const created = await handleProgressRequest(claimRequest(claimId, payload), env, authA, deps);
    assert.equal(created?.status, 201);
    assert.deepEqual(((await created?.json()) as { claim: { parkSnapshot: unknown } }).claim.parkSnapshot, payload.parkSnapshot);
    const retry = await handleProgressRequest(claimRequest(claimId, payload), env, authA, deps);
    assert.equal(retry?.status, 200);
  }
  const page = await handleProgressRequest(new Request("https://api.example.test/api/claims"), env, authA, deps);
  const restored = ((await page?.json()) as { claims: ClaimRecord[] }).claims;
  assert.equal(restored.length, 5);
  assert.deepEqual(restored.map((claim) => claim.parkSnapshot.category).sort(), ["community", "municipal", "national", "provincial", "regional"]);

  const invalid = claimPayload("be172e85-a8ab-4e1d-a032-901100000006");
  const rejected = await handleProgressRequest(
    claimRequest("be172e85-a8ab-4e1d-a032-901100000006", {
      ...invalid,
      parkSnapshot: { ...invalid.parkSnapshot, category: "unknown" },
    }),
    env,
    authA,
    deps,
  );
  assert.equal(rejected?.status, 400);
  assert.equal(store.claims.size, 5);
});

test("claim cursor is account scoped and the final nonempty page carries a high-water cursor", async () => {
  const store = new MemoryProgressStore();
  addClaim(store, ACCOUNT_A, CLAIM_A);
  const deps = { createStore: () => store };
  const first = await handleProgressRequest(new Request("https://api.example.test/api/claims"), env, authA, deps);
  const firstBody = (await first?.json()) as { claims: unknown[]; nextCursor: string | null };
  assert.equal(firstBody.claims.length, 1);
  assert.equal(typeof firstBody.nextCursor, "string");
  const terminal = await handleProgressRequest(
    new Request(`https://api.example.test/api/claims?cursor=${encodeURIComponent(firstBody.nextCursor!)}`),
    env,
    authA,
    deps,
  );
  assert.deepEqual(await terminal?.json(), { claims: [], nextCursor: null });
  const wrongAccount = await handleProgressRequest(
    new Request(`https://api.example.test/api/claims?cursor=${encodeURIComponent(firstBody.nextCursor!)}`),
    env,
    authB,
    deps,
  );
  assert.equal(wrongAccount?.status, 400);
});

test("revision cursor pages claims created within the same millisecond exactly once", async () => {
  const store = new MemoryProgressStore();
  for (let index = 0; index < 51; index += 1) {
    const claimId = `de172e85-a8ab-4e1d-a032-${String(index + 1).padStart(12, "0")}`;
    addClaim(store, ACCOUNT_A, claimId);
    store.claims.get(claimKey(ACCOUNT_A, claimId))!.createdAt = `2026-09-27T12:00:00.123${String(index).padStart(3, "0")}Z`;
  }
  const deps = { createStore: () => store };
  const first = await handleProgressRequest(new Request("https://api.example.test/api/claims"), env, authA, deps);
  const firstBody = (await first?.json()) as { claims: Array<{ claimId: string }>; nextCursor: string | null };
  assert.equal(firstBody.claims.length, 50);
  assert.ok(firstBody.nextCursor);
  const second = await handleProgressRequest(
    new Request(`https://api.example.test/api/claims?cursor=${encodeURIComponent(firstBody.nextCursor)}`),
    env,
    authA,
    deps,
  );
  const secondBody = (await second?.json()) as { claims: Array<{ claimId: string }>; nextCursor: string | null };
  assert.equal(secondBody.claims.length, 1);
  const terminal = await handleProgressRequest(
    new Request(`https://api.example.test/api/claims?cursor=${encodeURIComponent(secondBody.nextCursor!)}`),
    env,
    authA,
    deps,
  );
  assert.deepEqual(await terminal?.json(), { claims: [], nextCursor: null });
  assert.equal(new Set([...firstBody.claims, ...secondBody.claims].map((claim) => claim.claimId)).size, 51);
});

test("photo backup validates raster format and size, serves verified private bytes, and rejects overwrite", async () => {
  const store = new MemoryProgressStore();
  const photoService = new PrivatePhotoService();
  addClaim(store, ACCOUNT_A, CLAIM_A);
  const deps = { createStore: () => store, fetch: photoService.fetch.bind(photoService) };
  const bytes = jpegBytes();
  const upload = await handleProgressRequest(photoRequest(CLAIM_A, "PUT", bytes, CONTENT_TYPE), env, authA, deps);
  assert.equal(upload?.status, 201);
  const same = await handleProgressRequest(photoRequest(CLAIM_A, "PUT", bytes, CONTENT_TYPE), env, authA, deps);
  assert.equal(same?.status, 200);
  assert.equal(photoService.putCount, 2);
  assert.equal((await handleProgressRequest(photoRequest(CLAIM_A, "PUT", jpegBytes(5), CONTENT_TYPE), env, authA, deps))?.status, 409);

  const download = await handleProgressRequest(new Request(`https://api.example.test/api/claims/${CLAIM_A}/photo`), env, authA, deps);
  assert.equal(download?.status, 200, await download?.clone().text());
  assert.equal(download?.headers.get("cache-control"), "no-store");
  assert.deepEqual(new Uint8Array(await download!.arrayBuffer()), bytes);
  assert.equal((await handleProgressRequest(new Request(`https://api.example.test/api/claims/${CLAIM_A}/photo`), env, authB, deps))?.status, 404);
});

test("photo accepts PNG and WebP magic bytes, rejects SVG and MIME mismatches, and enforces 2.5 MiB", async () => {
  const store = new MemoryProgressStore();
  const photoService = new PrivatePhotoService();
  addClaim(store, ACCOUNT_A, CLAIM_A);
  addClaim(store, ACCOUNT_A, CLAIM_B);
  const thirdClaim = "be172e85-a8ab-4e1d-a032-901100000003";
  const fourthClaim = "be172e85-a8ab-4e1d-a032-901100000004";
  addClaim(store, ACCOUNT_A, thirdClaim);
  addClaim(store, ACCOUNT_A, fourthClaim);
  const deps = { createStore: () => store, fetch: photoService.fetch.bind(photoService) };
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
  assert.equal((await handleProgressRequest(photoRequest(CLAIM_A, "PUT", png, "image/png"), env, authA, deps))?.status, 201);
  assert.equal((await handleProgressRequest(photoRequest(CLAIM_B, "PUT", webp, "image/webp"), env, authA, deps))?.status, 201);
  assert.equal(
    (await handleProgressRequest(photoRequest(thirdClaim, "PUT", new TextEncoder().encode("<svg/>"), "image/svg+xml"), env, authA, deps))?.status,
    415,
  );
  assert.equal((await handleProgressRequest(photoRequest(thirdClaim, "PUT", png, "image/jpeg"), env, authA, deps))?.status, 415);
  assert.equal((await handleProgressRequest(photoRequest(fourthClaim, "PUT", jpegBytes(2_621_440), CONTENT_TYPE), env, authA, deps))?.status, 201);
  const oversized = jpegBytes(2_621_441);
  assert.equal((await handleProgressRequest(photoRequest(thirdClaim, "PUT", oversized, CONTENT_TYPE), env, authA, deps))?.status, 413);
});

test("photo pending and ready transitions are replayed after an earlier claim cursor", async () => {
  const store = new MemoryProgressStore();
  const photoService = new PrivatePhotoService();
  const deps = { createStore: () => store, fetch: photoService.fetch.bind(photoService) };
  const created = await handleProgressRequest(claimRequest(CLAIM_A, claimPayload(CLAIM_A)), env, authA, deps);
  assert.equal(created?.status, 201);
  const initial = await handleProgressRequest(new Request("https://api.example.test/api/claims"), env, authA, deps);
  const initialBody = (await initial?.json()) as { claims: Array<{ photo: { status: string } }>; nextCursor: string };
  assert.equal(initialBody.claims[0].photo.status, "missing");

  const bytes = jpegBytes();
  photoService.failPut = true;
  assert.equal((await handleProgressRequest(photoRequest(CLAIM_A, "PUT", bytes, CONTENT_TYPE), env, authA, deps))?.status, 503);
  const pending = await handleProgressRequest(
    new Request(`https://api.example.test/api/claims?cursor=${encodeURIComponent(initialBody.nextCursor)}`),
    env,
    authA,
    deps,
  );
  const pendingBody = (await pending?.json()) as { claims: Array<{ claimId: string; photo: { status: string } }>; nextCursor: string };
  assert.equal(pendingBody.claims[0].claimId, CLAIM_A);
  assert.equal(pendingBody.claims[0].photo.status, "pending");

  photoService.failPut = false;
  photoService.badPutAck = true;
  assert.equal((await handleProgressRequest(photoRequest(CLAIM_A, "PUT", bytes, CONTENT_TYPE), env, authA, deps))?.status, 503);
  photoService.badPutAck = false;
  assert.equal((await handleProgressRequest(photoRequest(CLAIM_A, "PUT", bytes, CONTENT_TYPE), env, authA, deps))?.status, 200);
  const ready = await handleProgressRequest(
    new Request(`https://api.example.test/api/claims?cursor=${encodeURIComponent(pendingBody.nextCursor)}`),
    env,
    authA,
    deps,
  );
  const readyBody = (await ready?.json()) as { claims: Array<{ claimId: string; photo: { status: string } }>; nextCursor: string };
  assert.equal(readyBody.claims[0].claimId, CLAIM_A);
  assert.equal(readyBody.claims[0].photo.status, "ready");
});

test("account deletion keeps private object inventory on provider failure and clears it on manual retry", async () => {
  const store = new MemoryProgressStore();
  const photoService = new PrivatePhotoService();
  addClaim(store, ACCOUNT_A, CLAIM_A);
  const bytes = jpegBytes();
  const deps = { createStore: () => store, fetch: photoService.fetch.bind(photoService) };
  assert.equal((await handleProgressRequest(photoRequest(CLAIM_A, "PUT", bytes, CONTENT_TYPE), env, authA, deps))?.status, 201);
  photoService.failAccountDelete = true;

  const first = await deleteAccountData({ accountId: ACCOUNT_A, receiptId: RECEIPT }, env, deps);
  assert.deepEqual(first, { complete: false });
  assert.equal(store.claims.size, 0);
  assert.equal((await store.listDeletionPhotoObjects(RECEIPT)).length, 1);
  assert.equal(store.deletionAttempts.get(RECEIPT), 1);

  photoService.failAccountDelete = false;
  const retry = await deleteAccountData({ accountId: ACCOUNT_A, receiptId: RECEIPT }, env, deps);
  assert.deepEqual(retry, { complete: true });
  assert.equal((await store.listDeletionPhotoObjects(RECEIPT)).length, 0);
  assert.equal(photoService.objects.size, 0);
});

test("account deletion calls the private prefix cleanup for orphan objects and continues bounded pages", async () => {
  const store = new MemoryProgressStore();
  const photoService = new PrivatePhotoService();
  for (let index = 0; index < 205; index += 1) {
    const claimId = `accounts-${String(index).padStart(3, "0")}`;
    photoService.objects.set(`accounts/${ACCOUNT_A}/claims/${claimId}`, { bytes: jpegBytes(), contentType: CONTENT_TYPE, sha256: "0".repeat(64) });
  }
  const result = await deleteAccountData({ accountId: ACCOUNT_A, receiptId: RECEIPT }, env, {
    createStore: () => store,
    fetch: photoService.fetch.bind(photoService),
  });
  assert.deepEqual(result, { complete: true });
  assert.equal(photoService.deleteAccountCount, 3);
  assert.equal(photoService.objects.size, 0);
});

test("photo uploads return not found for another account and unsupported content cannot reach the service", async () => {
  const store = new MemoryProgressStore();
  const photoService = new PrivatePhotoService();
  addClaim(store, ACCOUNT_A, CLAIM_A);
  const deps = { createStore: () => store, fetch: photoService.fetch.bind(photoService) };
  const bytes = jpegBytes();
  assert.equal((await handleProgressRequest(photoRequest(CLAIM_A, "PUT", bytes, CONTENT_TYPE), env, authB, deps))?.status, 404);
  assert.equal(photoService.putCount, 0);
});

function displayRequest(claimId: string, body: unknown): Request {
  return jsonRequest(`https://api.example.test/api/claims/${claimId}/display`, "PUT", body);
}

test("photo display choices back up per claim, last write wins, and list per account", async () => {
  const store = new MemoryProgressStore();
  addClaim(store, ACCOUNT_A, CLAIM_A);
  addClaim(store, ACCOUNT_B, CLAIM_B);
  const deps = { createStore: () => store };
  const crop = { x: 0.1, y: 0, width: 0.5625, height: 1 };

  const saved = await handleProgressRequest(displayRequest(CLAIM_A, { crop, coverAt: "2026-09-21T10:00:00Z", removed: false }), env, authA, deps);
  assert.equal(saved?.status, 200);
  const savedBody = (await saved?.json()) as { display: Record<string, unknown> };
  assert.deepEqual(savedBody.display, { claimId: CLAIM_A, crop, coverAt: "2026-09-21T10:00:00.000Z", removed: false, updatedAt: "2026-10-01T00:00:01.000Z" });

  const replaced = await handleProgressRequest(displayRequest(CLAIM_A, { crop: null, coverAt: null, removed: true }), env, authA, deps);
  assert.equal(replaced?.status, 200);

  const listA = await handleProgressRequest(new Request("https://api.example.test/api/claims/display"), env, authA, deps);
  assert.equal(listA?.status, 200);
  assert.deepEqual(await listA?.json(), { displays: [{ claimId: CLAIM_A, crop: null, coverAt: null, removed: true, updatedAt: "2026-10-01T00:00:02.000Z" }] });
  const listB = await handleProgressRequest(new Request("https://api.example.test/api/claims/display"), env, authB, deps);
  assert.deepEqual(await listB?.json(), { displays: [] });

  // Another account's claim, and a claim never backed up, are not found.
  assert.equal((await handleProgressRequest(displayRequest(CLAIM_B, { crop: null, coverAt: null, removed: false }), env, authA, deps))?.status, 404);
  assert.equal(
    (await handleProgressRequest(displayRequest("be172e85-a8ab-4e1d-a032-901100000009", { crop: null, coverAt: null, removed: false }), env, authA, deps))
      ?.status,
    404,
  );
  assert.equal((await handleProgressRequest(displayRequest("not-a-uuid", { crop: null, coverAt: null, removed: false }), env, authA, deps))?.status, 404);
  assert.equal((await handleProgressRequest(new Request(`https://api.example.test/api/claims/${CLAIM_A}/display`), env, authA, deps))?.status, 405);
  assert.equal((await handleProgressRequest(jsonRequest("https://api.example.test/api/claims/display", "PUT", {}), env, authA, deps))?.status, 405);
  assert.equal((await handleProgressRequest(new Request("https://api.example.test/api/claims/display"), env, null, deps))?.status, 401);
});

test("photo display bodies are exact and crops stay inside the photo", async () => {
  const store = new MemoryProgressStore();
  addClaim(store, ACCOUNT_A, CLAIM_A);
  const deps = { createStore: () => store };
  const good = { crop: { x: 0, y: 0.1, width: 1, height: 0.75 }, coverAt: null, removed: false };
  assert.equal((await handleProgressRequest(displayRequest(CLAIM_A, good), env, authA, deps))?.status, 200);
  for (const body of [
    { ...good, extra: true },
    { crop: good.crop, coverAt: null },
    { ...good, removed: "no" },
    { ...good, coverAt: "yesterday" },
    { ...good, coverAt: "2099-01-01T00:00:00Z" },
    { ...good, crop: { x: 0.5, y: 0, width: 0.6, height: 1 } },
    { ...good, crop: { x: -0.1, y: 0, width: 0.5, height: 1 } },
    { ...good, crop: { x: 0, y: 0, width: 0, height: 1 } },
    { ...good, crop: { x: 0, y: 0, width: 0.5 } },
    { ...good, crop: { x: 0, y: 0, width: 0.5, height: 1, z: 1 } },
    { ...good, crop: { x: "0", y: 0, width: 0.5, height: 1 } },
    { ...good, crop: [0, 0, 0.5, 1] },
  ]) {
    const response = await handleProgressRequest(displayRequest(CLAIM_A, body), env, authA, deps);
    assert.equal(response?.status, 400, JSON.stringify(body));
  }
});
