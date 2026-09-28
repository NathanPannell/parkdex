import {
  claimPayload,
  commitDownloadedPhoto,
  commitRemotePage,
  finalizeReservedGuestClaims,
  getPersonalPhoto,
  hashPhoto,
  getPullCursor,
  isPhotoEligible,
  listPhotosNeedingDownload,
  listPersonalClaims,
  listPersonalOutbox,
  listPersonalPhotos,
  markClaimUploaded,
  markPhotoConflict,
  markPhotoUnsupported,
  markPhotoUploaded,
  ownerKey,
  validateRemoteClaim,
  type PersonalClaim,
  type ProgressOwner,
  type RemoteClaim,
  type RemotePhoto,
} from "./personalStore";
import { getContentConnectivity, isContentWifiAvailable, type ContentConnectivity } from "../content/transport";

export type AuthenticatedFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** Capture this fetch function from the same auth session as accountId. It must not silently rebind to a later session. */
export type ProgressSession = {
  accountId: string;
  fetchAuthenticated: AuthenticatedFetch;
  /** Return false after logout, account switch, or session replacement. */
  isCurrent?: () => boolean;
};

export type SyncIssue = {
  operation: "claim-upload" | "photo-upload" | "claim-restore" | "photo-restore" | "guest-finalize" | "session";
  claimId?: string;
  code: string;
  message: string;
};

export type ProgressSyncResult = {
  ownerKey: string;
  claimsUploaded: number;
  photosUploaded: number;
  claimsRestored: number;
  photosRestored: number;
  claimsPending: number;
  photosPending: number;
  issues: SyncIssue[];
};

export class ProgressSessionChangedError extends Error {
  constructor() {
    super("The signed-in account changed during progress sync.");
    this.name = "ProgressSessionChangedError";
  }
}

export class ProgressHttpError extends Error {
  constructor(readonly status: number, readonly operation: SyncIssue["operation"]) {
    super(`Progress ${operation} failed with HTTP ${status}.`);
    this.name = "ProgressHttpError";
  }
}

const CLAIMS_PATH = "/api/claims";
const ACCOUNT_SCOPE_HEADER = "X-Kip-Account-ID";
const MAX_PAGES_PER_SYNC = 10_000;
const MAX_CLAIMS_PER_PAGE = 50;

function accountOwner(session: ProgressSession): ProgressOwner {
  const key = ownerKey({ kind: "account", accountId: session.accountId });
  if (key !== `account:${session.accountId.toLowerCase()}`) throw new Error("Invalid account session.");
  return { kind: "account", accountId: session.accountId };
}

/** Bind one run to its starting identity and write the scope header after merging request headers. */
function captureProgressSession(session: ProgressSession): ProgressSession {
  accountOwner(session);
  const accountId = session.accountId.toLowerCase();
  const fetchAuthenticated = session.fetchAuthenticated;
  const isCurrent = session.isCurrent;
  return {
    ...session,
    accountId,
    fetchAuthenticated(input, init) {
      const headers = new Headers(init?.headers);
      headers.set(ACCOUNT_SCOPE_HEADER, accountId);
      return fetchAuthenticated(input, { ...init, headers });
    },
    isCurrent: () => session.accountId.toLowerCase() === accountId && (!isCurrent || isCurrent()),
  };
}

function assertCurrent(session: ProgressSession) {
  if (session.isCurrent && !session.isCurrent()) throw new ProgressSessionChangedError();
}

function sessionIssue(error: unknown): SyncIssue {
  return {
    operation: error instanceof ProgressSessionChangedError ? "session" : "claim-restore",
    code: error instanceof ProgressSessionChangedError ? "session_changed" : "network_error",
    message: error instanceof Error ? error.message : "Progress could not be synced.",
  };
}

function issueFor(error: unknown, operation: SyncIssue["operation"], claimId?: string): SyncIssue {
  if (error instanceof ProgressSessionChangedError) return sessionIssue(error);
  if (error instanceof ProgressHttpError) {
    return { operation, claimId, code: `http_${error.status}`, message: error.message };
  }
  if (error instanceof Error && /Park details are unavailable/.test(error.message)) {
    return { operation, claimId, code: "snapshot_unavailable", message: "Park details are unavailable for this saved claim." };
  }
  if (error instanceof Error && /different immutable|conflict|changed/.test(error.message.toLowerCase())) {
    return { operation, claimId, code: "conflict", message: error.message };
  }
  return { operation, claimId, code: "network_or_storage_error", message: error instanceof Error ? error.message : "Progress could not be synced." };
}

async function responseJson(response: Response, fallback: string): Promise<Record<string, unknown>> {
  try {
    const value: unknown = await response.json();
    if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch { /* reported as a stable invalid-response error below */ }
  throw new Error(fallback);
}

function sameWirePayload(a: Pick<RemoteClaim, "parkId" | "claimedAt" | "parkSnapshot" | "contentReleaseId">, b: PersonalClaim) {
  if (!b.parkSnapshot) return false;
  return JSON.stringify({ parkId: a.parkId, claimedAt: a.claimedAt, parkSnapshot: a.parkSnapshot, contentReleaseId: a.contentReleaseId }) ===
    JSON.stringify({ parkId: b.parkId, claimedAt: b.claimedAt, parkSnapshot: b.parkSnapshot, contentReleaseId: b.contentReleaseId });
}

async function ensureOk(response: Response, operation: SyncIssue["operation"]) {
  if (!response.ok) throw new ProgressHttpError(response.status, operation);
}

async function pushClaims(session: ProgressSession, owner: ProgressOwner, result: ProgressSyncResult) {
  const outbox = await listPersonalOutbox(owner);
  for (const item of outbox) {
    if (item.kind !== "claim") continue;
    try {
      assertCurrent(session);
      const claim = (await listPersonalClaims(owner)).find((row) => row.claimId === item.claimId);
      if (!claim) continue;
      const payload = claimPayload(claim);
      const response = await session.fetchAuthenticated(`${CLAIMS_PATH}/${encodeURIComponent(claim.claimId)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      assertCurrent(session);
      await ensureOk(response, "claim-upload");
      const body = await responseJson(response, "The server did not confirm the saved claim.");
      const saved = validateRemoteClaim(body.claim);
      if (saved.claimId !== claim.claimId || !sameWirePayload(saved, claim)) {
        throw new Error("The server confirmed different immutable claim data.");
      }
      assertCurrent(session);
      await markClaimUploaded(owner, claim.claimId, payload);
      result.claimsUploaded += 1;
    } catch (error) {
      result.issues.push(issueFor(error, "claim-upload", item.claimId));
      if (error instanceof ProgressSessionChangedError) return;
    }
  }
}

async function pushPhotos(session: ProgressSession, owner: ProgressOwner, result: ProgressSyncResult) {
  const outbox = await listPersonalOutbox(owner);
  for (const item of outbox) {
    if (item.kind !== "photo") continue;
    try {
      assertCurrent(session);
      const [claim, photo] = await Promise.all([
        listPersonalClaims(owner).then((claims) => claims.find((row) => row.claimId === item.claimId)),
        getPersonalPhoto(owner, item.claimId),
      ]);
      if (!claim || claim.syncState !== "acknowledged" || !photo) continue;
      const eligible = await isPhotoEligible(photo.blob);
      assertCurrent(session);
      if (!eligible) {
        await markPhotoUnsupported(owner, item.claimId);
        result.issues.push({ operation: "photo-upload", claimId: item.claimId, code: "unsupported_photo", message: "This photo cannot be backed up in its current format." });
        continue;
      }
      const digest = await hashPhoto(photo.blob);
      assertCurrent(session);
      if (digest !== photo.sha256) {
        await markPhotoConflict(owner, item.claimId);
        result.issues.push({ operation: "photo-upload", claimId: item.claimId, code: "photo_changed", message: "The saved photo failed its integrity check." });
        continue;
      }
      assertCurrent(session);
      const response = await session.fetchAuthenticated(`${CLAIMS_PATH}/${encodeURIComponent(item.claimId)}/photo`, {
        method: "PUT",
        headers: { "Content-Type": photo.contentType },
        body: photo.blob,
      });
      assertCurrent(session);
      if (response.status === 409) {
        await markPhotoConflict(owner, item.claimId);
        result.issues.push({ operation: "photo-upload", claimId: item.claimId, code: "photo_conflict", message: "A different photo is already backed up for this claim." });
        continue;
      }
      await ensureOk(response, "photo-upload");
      const body = await responseJson(response, "The server did not confirm the saved photo.");
      const remotePhoto = body.photo as RemotePhoto;
      const photoState = validateRemoteClaim({
        claimId: item.claimId,
        parkId: claim.parkId,
        claimedAt: claim.claimedAt,
        parkSnapshot: claim.parkSnapshot,
        contentReleaseId: claim.contentReleaseId,
        photo: remotePhoto,
      }).photo;
      if (body.claimId !== item.claimId || photoState.status !== "ready" || photoState.sha256 !== digest ||
          photoState.sizeBytes !== photo.sizeBytes || photoState.contentType !== photo.contentType) {
        throw new Error("The server confirmed different photo data.");
      }
      assertCurrent(session);
      await markPhotoUploaded(owner, item.claimId, digest);
      result.photosUploaded += 1;
    } catch (error) {
      result.issues.push(issueFor(error, "photo-upload", item.claimId));
      if (error instanceof ProgressSessionChangedError) return;
    }
  }
}

type ClaimPage = { claims: RemoteClaim[]; nextCursor: string | null };

async function fetchPage(session: ProgressSession, cursor: string | null): Promise<ClaimPage> {
  const url = cursor === null ? CLAIMS_PATH : `${CLAIMS_PATH}?cursor=${encodeURIComponent(cursor)}`;
  const response = await session.fetchAuthenticated(url, { method: "GET" });
  assertCurrent(session);
  await ensureOk(response, "claim-restore");
  let body: unknown;
  try { body = await response.json(); }
  catch { throw new Error("The server returned an invalid progress page."); }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("The server returned an invalid progress page.");
  const page = body as Record<string, unknown>;
  if (!Array.isArray(page.claims) || page.claims.length > MAX_CLAIMS_PER_PAGE ||
      (page.nextCursor !== null && (typeof page.nextCursor !== "string" || page.nextCursor.length > 2048))) {
    throw new Error("The server returned an invalid progress page.");
  }
  const claims = page.claims.map(validateRemoteClaim);
  const ids = new Set<string>();
  for (const claim of claims) {
    if (ids.has(claim.claimId)) throw new Error("The server returned a duplicate claim in one page.");
    ids.add(claim.claimId);
  }
  if (claims.length > 0 && page.nextCursor === null) {
    throw new Error("The server did not provide a resumable cursor for the claim page.");
  }
  return { claims, nextCursor: page.nextCursor as string | null };
}

async function pullClaims(session: ProgressSession, owner: ProgressOwner, result: ProgressSyncResult) {
  let cursor = await getPullCursor(owner);
  const visited = new Set<string>();
  for (let pageNumber = 0; pageNumber < MAX_PAGES_PER_SYNC; pageNumber += 1) {
    assertCurrent(session);
    if (cursor !== null) {
      if (visited.has(cursor)) throw new Error("The server repeated a claim cursor.");
      visited.add(cursor);
    }
    const page = await fetchPage(session, cursor);
    assertCurrent(session);
    await commitRemotePage(owner, page.claims, page.nextCursor);
    result.claimsRestored += page.claims.length;
    if (page.nextCursor === null) return;
    if (page.nextCursor === cursor) throw new Error("The server repeated a claim cursor.");
    cursor = page.nextCursor;
    if (page.claims.length === 0) return;
  }
  throw new Error("Progress restore exceeded the page limit.");
}

async function pullPhotos(session: ProgressSession, owner: ProgressOwner, result: ProgressSyncResult) {
  const pending = await listPhotosNeedingDownload(owner);
  if (pending.length === 0 || !(await isContentWifiAvailable())) return;
  for (const item of pending) {
    try {
      assertCurrent(session);
      if (!(await isContentWifiAvailable())) return;
      const response = await session.fetchAuthenticated(`${CLAIMS_PATH}/${encodeURIComponent(item.claim.claimId)}/photo`, { method: "GET" });
      assertCurrent(session);
      await ensureOk(response, "photo-restore");
      const bytes = await response.arrayBuffer();
      const responseType = response.headers.get("Content-Type")?.split(";", 1)[0].trim().toLowerCase();
      const blob = new Blob([bytes], { type: responseType || item.photo.contentType });
      const digest = await hashPhoto(blob);
      assertCurrent(session);
      const outcome = await commitDownloadedPhoto(owner, item.claim.claimId, item.photo, blob, digest);
      if (outcome === "stored") result.photosRestored += 1;
      else result.issues.push({ operation: "photo-restore", claimId: item.claim.claimId, code: "photo_conflict", message: "A different local photo is already saved for this claim." });
    } catch (error) {
      result.issues.push(issueFor(error, "photo-restore", item.claim.claimId));
      if (error instanceof ProgressSessionChangedError) return;
      if (error instanceof Error && (error.name === "WifiUnavailableError" || /wi[\s-]?fi/i.test(error.message))) return;
    }
  }
}

async function countPending(owner: ProgressOwner, result: ProgressSyncResult) {
  const claims = await listPersonalClaims(owner);
  const outbox = await listPersonalOutbox(owner);
  const photos = await listPersonalPhotos(owner);
  const photoIds = new Set(outbox.filter((item) => item.kind === "photo").map((item) => item.claimId));
  for (const claim of claims) {
    if (claim.remotePhoto.status === "pending") photoIds.add(claim.claimId);
  }
  for (const item of await listPhotosNeedingDownload(owner)) photoIds.add(item.claim.claimId);
  for (const photo of photos) {
    const issue = photo.backupState === "unsupported"
      ? { code: "unsupported_photo", message: "This saved photo cannot be backed up in its current format." }
      : photo.backupState === "conflict"
        ? { code: "photo_conflict", message: "A different photo is already backed up for this claim." }
        : null;
    if (issue && !result.issues.some((existing) => existing.claimId === photo.claimId && existing.code === issue.code)) {
      result.issues.push({ operation: "photo-upload", claimId: photo.claimId, ...issue });
    }
  }
  result.claimsPending = outbox.filter((item) => item.kind === "claim").length + claims.filter((claim) => claim.syncState === "pending" && !outbox.some((item) => item.kind === "claim" && item.claimId === claim.claimId)).length;
  result.photosPending = photoIds.size;
}

/** Run once on foreground/network recovery or on explicit retry. No polling or background retry loop is created here. */
export async function syncProgress(session: ProgressSession): Promise<ProgressSyncResult> {
  const capturedSession = captureProgressSession(session);
  const owner = accountOwner(capturedSession);
  const result: ProgressSyncResult = {
    ownerKey: ownerKey(owner), claimsUploaded: 0, photosUploaded: 0, claimsRestored: 0, photosRestored: 0,
    claimsPending: 0, photosPending: 0, issues: [],
  };
  try {
    assertCurrent(capturedSession);
    await pushClaims(capturedSession, owner, result);
    if (!result.issues.some((issue) => issue.operation === "session")) await pushPhotos(capturedSession, owner, result);
    if (!result.issues.some((issue) => issue.operation === "session")) await pullClaims(capturedSession, owner, result);
    if (!result.issues.some((issue) => issue.operation === "session")) await pullPhotos(capturedSession, owner, result);
  } catch (error) {
    result.issues.push(sessionIssue(error));
  }
  try {
    await finalizeReservedGuestClaims(capturedSession.accountId);
  } catch (error) {
    result.issues.push({
      operation: "guest-finalize",
      code: "guest_finalize_failed",
      message: error instanceof Error ? error.message : "Reserved guest progress could not be finalized.",
    });
  }
  await countPending(owner, result);
  return result;
}

/** Run a backup only when the app is foregrounded and the transport confirms Wi-Fi. */
export async function runProgressSyncWhenReady(
  session: ProgressSession,
  isForeground: () => boolean,
  knownConnectivity?: ContentConnectivity,
): Promise<ProgressSyncResult | null> {
  if (!isForeground()) return null;
  const connectivity = knownConnectivity ?? await getContentConnectivity().catch(() => ({ connected: false, wifi: false }));
  if (!connectivity.connected || !connectivity.wifi || !isForeground()) return null;
  return syncProgress(session);
}

/** Coalesce concurrent triggers and optionally queue one follow-up for a meaningful new trigger. */
export function coalesceProgressSync<T>(
  inFlight: Map<string, Promise<T>>,
  rerunRequested: Set<string>,
  key: string,
  run: () => Promise<T>,
  retryAfterFlight: boolean,
  rerun: () => void,
): Promise<T> {
  const active = inFlight.get(key);
  if (active) {
    if (retryAfterFlight) rerunRequested.add(key);
    return active;
  }

  let task: Promise<T>;
  task = Promise.resolve().then(run).finally(() => {
    if (inFlight.get(key) === task) inFlight.delete(key);
    if (rerunRequested.delete(key)) queueMicrotask(rerun);
  });
  inFlight.set(key, task);
  return task;
}

/** Record only acknowledged outgoing work after all backup work is clear. */
export function canPersistSuccessfulOutboundBackup(result: ProgressSyncResult): boolean {
  if (result.claimsUploaded + result.photosUploaded === 0 || result.claimsPending > 0 || result.photosPending > 0) return false;
  return !result.issues.some((issue) => issue.operation === "session" || issue.operation === "claim-upload" || issue.operation === "photo-upload" || /conflict|changed/i.test(issue.code));
}

/** Schedule backup only for a real transition into confirmed Wi-Fi, not the initial subscription snapshot. */
export function shouldScheduleWifiBackup(
  previous: ContentConnectivity | null,
  current: ContentConnectivity,
): boolean {
  return previous !== null && current.connected && current.wifi && (!previous.connected || !previous.wifi);
}

export async function persistSuccessfulOutboundBackupTimestamp(
  accountId: string,
  result: ProgressSyncResult,
  currentTimestamp: number | null,
  storage: {
    get: (accountId: string) => Promise<number | null>;
    set: (accountId: string, timestamp: number) => Promise<void>;
  },
  timestamp = Date.now(),
): Promise<number | null> {
  if (!canPersistSuccessfulOutboundBackup(result)) return currentTimestamp;
  try {
    await storage.set(accountId, timestamp);
    const durableTimestamp = await storage.get(accountId);
    return Math.max(currentTimestamp ?? 0, durableTimestamp ?? timestamp);
  } catch {
    return currentTimestamp;
  }
}

export function claimEventContext(claim: Pick<PersonalClaim, "claimId" | "parkId">, firstClaim: boolean) {
  return { claimId: claim.claimId, parkId: claim.parkId, firstClaim };
}

export function remotePhotoState(photo: RemotePhoto): "missing" | "pending" | "ready" {
  return photo.status;
}
