import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Park } from "../parks";

class MemoryStorage {
  private values = new Map<string, string>();
  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string) { this.values.delete(key); }
  setItem(key: string, value: string) { this.values.set(String(key), String(value)); }
}

const DB_NAMES = ["parkdex-personal-v1", "parkdex"];
const ACCOUNT_A = "11111111-1111-4111-8111-111111111111";
const ACCOUNT_B = "22222222-2222-4222-8222-222222222222";
const REMOTE_ID = "33333333-3333-4333-8333-333333333333";

function deleteDatabase(name: string) {
  return new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error(`Database ${name} is blocked.`));
  });
}

function park(id = "cedar-point", name = "Cedar Point Park"): Park {
  return {
    id, name, short: "Cedar Point", category: "regional", region: "Victoria", lat: 48.4, lng: -123.3,
    biome: "coast", shape: "circle", rarity: "common", seed: 7, blurb: "A calm shore walk.", scene: "cedar-point",
  };
}

function png(last = 0): Blob {
  return new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, last]).buffer], { type: "image/png" });
}

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}

function remoteClaim(claimId = REMOTE_ID, parkValue = park(), photo: unknown = { status: "missing" }) {
  return {
    claimId, parkId: parkValue.id, claimedAt: "2025-04-03T12:34:56.000Z", parkSnapshot: parkValue,
    contentReleaseId: "release-17", createdAt: "2025-04-03T12:34:57.000Z", photo,
  };
}

function requestUrl(input: RequestInfo | URL) {
  return input instanceof Request ? input.url : String(input);
}

function requestHeader(init: RequestInit | undefined, name: string) {
  return new Headers(init?.headers).get(name);
}

function makeSession(accountId: string, fetchAuthenticated: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>, isCurrent?: () => boolean) {
  return { accountId, fetchAuthenticated, isCurrent };
}

beforeEach(async () => {
  vi.resetModules();
  for (const name of DB_NAMES) await deleteDatabase(name);
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: new MemoryStorage() });
});

describe("account progress sync", () => {
  it("retries an offline claim with the same immutable UUID and acknowledges only after the server response", async () => {
    const personal = await import("./personalStore");
    const sync = await import("./progressSync");
    const owner = { kind: "account" as const, accountId: ACCOUNT_A };
    const local = await personal.createPersonalClaim(owner, { park: park(), claimedAt: "2025-04-03T12:34:56.000Z", contentReleaseId: "release-17" });
    const attempts: string[] = [];
    const offline = sync.syncProgress(makeSession(ACCOUNT_A, async (input, init) => {
      const url = requestUrl(input);
      if (init?.method === "PUT") { attempts.push(url); throw new TypeError("offline"); }
      return jsonResponse({ claims: [], nextCursor: null });
    }));
    const first = await offline;
    expect(first.claimsPending).toBe(1);
    expect((await personal.listPersonalClaims(owner))[0].syncState).toBe("pending");

    const retried = await sync.syncProgress(makeSession(ACCOUNT_A, async (input, init) => {
      const url = requestUrl(input);
      if (init?.method === "PUT") {
        attempts.push(url);
        const payload = JSON.parse(String(init.body));
        return jsonResponse({ claim: { claimId: local.claimId, ...payload, photo: { status: "missing" } } }, 201);
      }
      return jsonResponse({ claims: [], nextCursor: null });
    }));
    expect(attempts).toEqual([`/api/claims/${local.claimId}`, `/api/claims/${local.claimId}`]);
    expect(retried.claimsUploaded).toBe(1);
    expect(retried.claimsPending).toBe(0);
    expect((await personal.listPersonalClaims(owner))[0].syncState).toBe("acknowledged");
  });

  it("restores retired park snapshots and resumes from the acknowledged page cursor", async () => {
    const personal = await import("./personalStore");
    const sync = await import("./progressSync");
    const owner = { kind: "account" as const, accountId: ACCOUNT_A };
    const urls: string[] = [];
    let firstSync = true;
    const fetcher = async (input: RequestInfo | URL) => {
      const url = requestUrl(input);
      urls.push(url);
      if (!url.startsWith("/api/claims")) throw new Error(`Unexpected URL: ${url}`);
      if (!firstSync && url === "/api/claims?cursor=stable-anchor") {
        return jsonResponse({ claims: [], nextCursor: null });
      }
      if (url === "/api/claims") {
        return jsonResponse({ claims: [remoteClaim(REMOTE_ID, park("retired-park", "Retired Park"))], nextCursor: "stable-anchor" });
      }
      if (url === "/api/claims?cursor=stable-anchor") {
        firstSync = false;
        return jsonResponse({ claims: [], nextCursor: null });
      }
      throw new Error(`Unexpected URL: ${url}`);
    };
    const first = await sync.syncProgress(makeSession(ACCOUNT_A, fetcher));
    expect(first.claimsRestored).toBe(1);
    expect((await personal.listPersonalClaims(owner))[0]).toMatchObject({ parkId: "retired-park", parkSnapshot: { name: "Retired Park" }, syncState: "acknowledged" });
    expect(await personal.getPullCursor(owner)).toBe("stable-anchor");

    await sync.syncProgress(makeSession(ACCOUNT_A, fetcher));
    expect(urls).toContain("/api/claims?cursor=stable-anchor");
  });

  it("revisits an existing claim when a later server revision makes its private photo ready", async () => {
    const personal = await import("./personalStore");
    const sync = await import("./progressSync");
    const owner = { kind: "account" as const, accountId: ACCOUNT_A };
    const savedPhoto = png(1);
    const metadata = { status: "ready", sha256: await personal.hashPhoto(savedPhoto), sizeBytes: savedPhoto.size, contentType: "image/png" };
    let photoBecameReady = false;
    const urls: string[] = [];
    const fetcher = async (input: RequestInfo | URL) => {
      const url = requestUrl(input);
      urls.push(url);
      if (url === "/api/claims") return jsonResponse({ claims: [remoteClaim(REMOTE_ID)], nextCursor: "claim-revision" });
      if (url === "/api/claims?cursor=claim-revision" && !photoBecameReady) return jsonResponse({ claims: [], nextCursor: null });
      if (url === "/api/claims?cursor=claim-revision" && photoBecameReady) {
        return jsonResponse({ claims: [remoteClaim(REMOTE_ID, park(), metadata)], nextCursor: "photo-revision" });
      }
      if (url === "/api/claims?cursor=photo-revision") return jsonResponse({ claims: [], nextCursor: null });
      if (url.endsWith("/photo")) return new Response(await savedPhoto.arrayBuffer(), { status: 200, headers: { "Content-Type": "image/png" } });
      throw new Error(`Unexpected URL: ${url}`);
    };

    await sync.syncProgress(makeSession(ACCOUNT_A, fetcher));
    expect((await personal.listPersonalClaims(owner))[0].remotePhoto).toEqual({ status: "missing" });
    photoBecameReady = true;
    const restored = await sync.syncProgress(makeSession(ACCOUNT_A, fetcher));
    expect(urls).toContain("/api/claims?cursor=claim-revision");
    expect(restored.photosRestored).toBe(1);
    expect((await personal.getPersonalPhoto(owner, REMOTE_ID))?.backupState).toBe("backed-up");
  });

  it("scopes claim upload, claim pages, photo upload, and private photo download to the captured account", async () => {
    const personal = await import("./personalStore");
    const sync = await import("./progressSync");
    const owner = { kind: "account" as const, accountId: ACCOUNT_A };
    const local = await personal.createPersonalClaim(owner, { park: park(), photo: png(1) });
    const remotePhoto = png(2);
    const photoMetadata = {
      status: "ready",
      sha256: await personal.hashPhoto(remotePhoto),
      sizeBytes: remotePhoto.size,
      contentType: "image/png",
    };
    const calls: Array<{ method: string; url: string; accountId: string | null }> = [];
    const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input);
      const method = init?.method ?? "GET";
      calls.push({ method, url, accountId: requestHeader(init, "X-Kip-Account-ID") });
      if (method === "PUT" && url === `/api/claims/${local.claimId}`) {
        const payload = JSON.parse(String(init?.body));
        return jsonResponse({ claim: { claimId: local.claimId, ...payload, photo: { status: "missing" } } }, 201);
      }
      if (method === "PUT" && url === `/api/claims/${local.claimId}/photo`) {
        const photo = await personal.getPersonalPhoto(owner, local.claimId);
        if (!photo) throw new Error("Test upload photo missing.");
        return jsonResponse({ claimId: local.claimId, photo: { status: "ready", sha256: photo.sha256, sizeBytes: photo.sizeBytes, contentType: photo.contentType } }, 201);
      }
      if (method === "GET" && url === "/api/claims") {
        return jsonResponse({ claims: [remoteClaim(REMOTE_ID, park("retired-park", "Retired Park"), photoMetadata)], nextCursor: "revision-one" });
      }
      if (method === "GET" && url === "/api/claims?cursor=revision-one") return jsonResponse({ claims: [], nextCursor: null });
      if (method === "GET" && url === `/api/claims/${REMOTE_ID}/photo`) {
        return new Response(await remotePhoto.arrayBuffer(), { status: 200, headers: { "Content-Type": "image/png" } });
      }
      throw new Error(`Unexpected request: ${method} ${url}`);
    };

    const result = await sync.syncProgress(makeSession(ACCOUNT_A, fetcher));
    expect(result.claimsUploaded).toBe(1);
    expect(result.photosUploaded).toBe(1);
    expect(result.claimsRestored).toBe(1);
    expect(result.photosRestored).toBe(1);
    expect(calls.map(({ method, url }) => `${method} ${url}`)).toEqual([
      `PUT /api/claims/${local.claimId}`,
      `PUT /api/claims/${local.claimId}/photo`,
      "GET /api/claims",
      "GET /api/claims?cursor=revision-one",
      `GET /api/claims/${REMOTE_ID}/photo`,
    ]);
    expect(calls.every((call) => call.accountId === ACCOUNT_A)).toBe(true);
  });

  it("persists each restored page with its cursor and resumes after an interrupted page fetch", async () => {
    const personal = await import("./personalStore");
    const sync = await import("./progressSync");
    const owner = { kind: "account" as const, accountId: ACCOUNT_A };
    const secondId = "44444444-4444-4444-8444-444444444444";
    const urls: string[] = [];
    let shouldDropConnection = true;
    const fetcher = async (input: RequestInfo | URL) => {
      const url = requestUrl(input);
      urls.push(url);
      if (url === "/api/claims") return jsonResponse({ claims: [remoteClaim(REMOTE_ID)], nextCursor: "revision-one" });
      if (url === "/api/claims?cursor=revision-one" && shouldDropConnection) {
        shouldDropConnection = false;
        throw new TypeError("connection dropped");
      }
      if (url === "/api/claims?cursor=revision-one") return jsonResponse({ claims: [remoteClaim(secondId, park("maple-cove", "Maple Cove"))], nextCursor: "revision-two" });
      if (url === "/api/claims?cursor=revision-two") return jsonResponse({ claims: [], nextCursor: null });
      throw new Error(`Unexpected URL: ${url}`);
    };
    const first = await sync.syncProgress(makeSession(ACCOUNT_A, fetcher));
    expect(first.issues.length).toBeGreaterThan(0);
    expect(await personal.getPullCursor(owner)).toBe("revision-one");
    expect((await personal.listPersonalClaims(owner)).map((claim) => claim.claimId)).toEqual([REMOTE_ID]);

    const resumedAt = urls.length;
    const second = await sync.syncProgress(makeSession(ACCOUNT_A, fetcher));
    expect(urls.slice(resumedAt)).not.toContain("/api/claims");
    expect(urls).toContain("/api/claims?cursor=revision-one");
    expect(second.claimsRestored).toBe(1);
    expect((await personal.listPersonalClaims(owner)).map((claim) => claim.claimId).sort()).toEqual([REMOTE_ID, secondId].sort());
  });

  it("never uploads one account's local collection through another account session", async () => {
    const personal = await import("./personalStore");
    const sync = await import("./progressSync");
    const ownerA = { kind: "account" as const, accountId: ACCOUNT_A };
    const ownerB = { kind: "account" as const, accountId: ACCOUNT_B };
    const claimA = await personal.createPersonalClaim(ownerA, { park: park("cedar-point", "A claim") });
    const claimB = await personal.createPersonalClaim(ownerB, { park: park("maple-cove", "B claim") });
    const sentIds: string[] = [];
    await sync.syncProgress(makeSession(ACCOUNT_B, async (input, init) => {
      const url = requestUrl(input);
      if (init?.method === "PUT") {
        sentIds.push(url.split("/").at(-1)!);
        const payload = JSON.parse(String(init.body));
        return jsonResponse({ claim: { claimId: claimB.claimId, ...payload, photo: { status: "missing" } } }, 201);
      }
      return jsonResponse({ claims: [], nextCursor: null });
    }));
    expect(sentIds).toEqual([claimB.claimId]);
    expect((await personal.listPersonalClaims(ownerA))[0].syncState).toBe("pending");
    expect((await personal.listPersonalClaims(ownerB))[0].syncState).toBe("acknowledged");
    expect((await personal.listPersonalClaims({ kind: "guest" })).map((claim) => claim.claimId)).toEqual([]);
    expect(claimA.claimId).not.toBe(claimB.claimId);
  });

  it("does not acknowledge an in-flight upload after the signed-in session changes", async () => {
    const personal = await import("./personalStore");
    const sync = await import("./progressSync");
    const owner = { kind: "account" as const, accountId: ACCOUNT_A };
    const claim = await personal.createPersonalClaim(owner, { park: park() });
    const session = makeSession(ACCOUNT_A, async (_input, init) => {
      if (init?.method === "PUT") {
        session.accountId = ACCOUNT_B;
        expect(requestHeader(init, "X-Kip-Account-ID")).toBe(ACCOUNT_A);
        const payload = JSON.parse(String(init.body));
        return jsonResponse({ claim: { claimId: claim.claimId, ...payload, photo: { status: "missing" } } }, 201);
      }
      return jsonResponse({ claims: [], nextCursor: null });
    });
    const result = await sync.syncProgress(session);
    expect(result.issues.some((issue) => issue.code === "session_changed")).toBe(true);
    expect(result.issues.some((issue) => issue.operation === "claim-restore")).toBe(false);
    expect((await personal.listPersonalClaims(owner))[0].syncState).toBe("pending");
  });

  it("keeps guest data until each claim is acknowledged, then completes explicit attachment", async () => {
    const personal = await import("./personalStore");
    const sync = await import("./progressSync");
    const guestClaim = await personal.createPersonalClaim({ kind: "guest" }, { park: park(), claimedAt: "2025-04-03T12:34:56.000Z", contentReleaseId: "release-17" });
    const guest = await personal.listPersonalClaims({ kind: "guest" });
    expect(guest).toHaveLength(1);

    let shouldFail = true;
    const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input);
      if (init?.method === "PUT") {
        if (shouldFail) throw new TypeError("offline");
        const payload = JSON.parse(String(init.body));
        return jsonResponse({ claim: { claimId: guestClaim.claimId, ...payload, photo: { status: "missing" } } }, 201);
      }
      return jsonResponse({ claims: [], nextCursor: null });
    };
    const first = await sync.attachGuestProgress(makeSession(ACCOUNT_A, fetcher));
    expect(first.guestClaimsCopied).toBe(1);
    expect(first.guestClaimsRemoved).toBe(0);
    expect((await personal.listPersonalClaims({ kind: "guest" }))).toHaveLength(1);
    expect((await personal.listPersonalClaims({ kind: "account", accountId: ACCOUNT_A }))[0].syncState).toBe("pending");

    shouldFail = false;
    const second = await sync.attachGuestProgress(makeSession(ACCOUNT_A, fetcher));
    expect(second.claimsUploaded).toBe(1);
    expect(second.guestClaimsRemoved).toBe(1);
    expect(await personal.listPersonalClaims({ kind: "guest" })).toHaveLength(0);
    expect((await personal.listPersonalClaims({ kind: "account", accountId: ACCOUNT_A }))[0].claimId).toBe(guestClaim.claimId);
  });

  it("preserves a local immutable record when the same UUID arrives with changed claim data", async () => {
    const personal = await import("./personalStore");
    const owner = { kind: "account" as const, accountId: ACCOUNT_A };
    const local = await personal.createPersonalClaim(owner, { park: park(), claimedAt: "2025-04-03T12:34:56.000Z" });
    const conflicting = { ...remoteClaim(local.claimId), claimedAt: "2025-04-04T12:34:56.000Z" };
    await expect(personal.commitRemotePage(owner, [personal.validateRemoteClaim(conflicting)], "cursor-after-conflict")).rejects.toThrow("immutable");
    const [stored] = await personal.listPersonalClaims(owner);
    expect(stored.claimId).toBe(local.claimId);
    expect(stored.claimedAt).toBe("2025-04-03T12:34:56.000Z");
    expect(await personal.getPullCursor(owner)).toBeNull();
  });

  it("keeps the guest collection intact when an account has a conflicting claim with the same UUID", async () => {
    const personal = await import("./personalStore");
    const sync = await import("./progressSync");
    const guest = await personal.createPersonalClaim({ kind: "guest" }, { park: park(), claimedAt: "2025-04-03T12:34:56.000Z", contentReleaseId: "release-17" });
    const accountOwner = { kind: "account" as const, accountId: ACCOUNT_A };
    await personal.commitRemotePage(accountOwner, [personal.validateRemoteClaim({
      ...remoteClaim(guest.claimId), claimedAt: "2025-04-04T12:34:56.000Z",
    })], "existing-account-revision");
    await expect(sync.attachGuestProgress(makeSession(ACCOUNT_A, async () => jsonResponse({ claims: [], nextCursor: null })))).rejects.toThrow("conflicts");
    expect((await personal.listPersonalClaims({ kind: "guest" }))[0].claimId).toBe(guest.claimId);
    expect((await personal.listPersonalClaims(accountOwner))[0].claimedAt).toBe("2025-04-04T12:34:56.000Z");
  });

  it("retries private photo backup independently and leaves the photo pending while offline", async () => {
    const personal = await import("./personalStore");
    const sync = await import("./progressSync");
    const owner = { kind: "account" as const, accountId: ACCOUNT_A };
    const local = await personal.createPersonalClaim(owner, { park: park(), claimedAt: "2025-04-03T12:34:56.000Z", photo: png() });
    const photo = await personal.getPersonalPhoto(owner, local.claimId);
    if (!photo) throw new Error("Test photo missing.");
    let photoAttempts = 0;
    let claimAttempts = 0;
    const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input);
      if (url.endsWith("/photo") && init?.method === "PUT") {
        photoAttempts += 1;
        if (photoAttempts === 1) throw new TypeError("offline");
        return jsonResponse({ claimId: local.claimId, photo: { status: "ready", sha256: photo.sha256, sizeBytes: photo.sizeBytes, contentType: photo.contentType } }, 201);
      }
      if (init?.method === "PUT") {
        claimAttempts += 1;
        const payload = JSON.parse(String(init.body));
        return jsonResponse({ claim: { claimId: local.claimId, ...payload, photo: { status: "missing" } } }, 201);
      }
      return jsonResponse({ claims: [], nextCursor: null });
    };
    const first = await sync.syncProgress(makeSession(ACCOUNT_A, fetcher));
    expect(claimAttempts).toBe(1);
    expect(first.photosPending).toBe(1);
    expect((await personal.getPersonalPhoto(owner, local.claimId))?.backupState).toBe("pending");
    const second = await sync.syncProgress(makeSession(ACCOUNT_A, fetcher));
    expect(claimAttempts).toBe(1);
    expect(photoAttempts).toBe(2);
    expect(second.photosUploaded).toBe(1);
    expect((await personal.getPersonalPhoto(owner, local.claimId))?.backupState).toBe("backed-up");
  });

  it("rejects corrupt private photo bytes and retains the claim for later restore retry", async () => {
    const personal = await import("./personalStore");
    const sync = await import("./progressSync");
    const good = png(1);
    const digest = await personal.hashPhoto(good);
    const metadata = { status: "ready", sha256: digest, sizeBytes: good.size, contentType: "image/png" };
    let requestCount = 0;
    const result = await sync.syncProgress(makeSession(ACCOUNT_A, async (input) => {
      const url = requestUrl(input);
      if (url.startsWith("/api/claims?cursor=")) return jsonResponse({ claims: [], nextCursor: null });
      if (url === "/api/claims") return jsonResponse({ claims: [remoteClaim(REMOTE_ID, park(), metadata)], nextCursor: "restore-anchor" });
      if (url.endsWith("/photo")) {
        requestCount += 1;
        return new Response(await png(2).arrayBuffer(), { status: 200, headers: { "Content-Type": "image/png" } });
      }
      throw new Error(`Unexpected URL: ${url}`);
    }));
    expect(requestCount).toBe(1);
    expect(result.photosRestored).toBe(0);
    expect(result.issues.some((issue) => issue.operation === "photo-restore")).toBe(true);
    expect(await personal.getPersonalPhoto({ kind: "account", accountId: ACCOUNT_A }, REMOTE_ID)).toBeNull();
    expect((await personal.listPersonalClaims({ kind: "account", accountId: ACCOUNT_A }))[0].remotePhoto).toMatchObject({ status: "ready", sha256: digest });
  });
});
