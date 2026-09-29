import { ApiError, type VisitClaim } from "./account";
import {
  createOfflineClaimRequest,
  issueOfflineClaimGrantRequest,
  type ClaimConfirmation,
  type ClaimLocation,
  type ClaimOwner,
  type ClaimRecommendation,
  type OfflineClaimGrant,
} from "./claims-client";
import type { BoundaryFeature } from "./boundaries";
import { isPointInBoundary } from "./offline-geometry";
import { getNativeCapabilities } from "./native-capabilities";
import { getRecentPlaceCache } from "./place-cache";
import type { Place } from "./places";
import { getPlatformStorage, type KeyValueStore } from "./platform-storage";
import type { PhotoRetryStore } from "./photo-retry";

export const OFFLINE_CLAIM_LOCATION_MAX_AGE_MS = 20_000;
export const OFFLINE_CLAIM_LOCATION_MAX_ACCURACY_METERS = 50;

const STORAGE_VERSION = 1;
const RECOMMENDATION_PREFIX = "offline-claim-v1:";
const MAX_SAVED_RECOMMENDATIONS = 20;

export function isOfflineClaimRecommendationToken(token: string) {
  return token.startsWith(RECOMMENDATION_PREFIX);
}

export type OfflineClaimOwner = ClaimOwner & { accountId: string };

export type OfflineClaimQueueState = "pending" | "rejected" | "photo-retry";
export type OfflineClaimPhotoState = "none" | "pending" | "retry" | "volatile" | "missing";

export type OfflineClaimQueueItem = {
  requestId: string;
  placeId: string;
  state: OfflineClaimQueueState;
  photoState: OfflineClaimPhotoState;
  createdAt: string;
  lastError?: string;
  attemptCount: number;
};

export type OfflineClaimPhotoOutcome = {
  requestId: string;
  placeId: string;
  status: "none" | "uploaded" | "retry" | "volatile" | "missing";
  message?: string;
};

export type OfflineClaimDrainResult = {
  confirmed: ClaimConfirmation[];
  photos: OfflineClaimPhotoOutcome[];
};

export type CachedPlaceBundleForClaims = {
  place: Place;
  boundary: BoundaryFeature | null;
  boundaryVersion: string | number | null;
  viewedAt?: number;
};

export type RecentPlaceCacheForClaims = {
  get(placeId: string): Promise<CachedPlaceBundleForClaims | null>;
  list(): Promise<CachedPlaceBundleForClaims[]>;
  listForClaims?(): Promise<CachedPlaceBundleForClaims[]>;
};

export type OfflineClaimsServiceOptions = {
  apiBaseUrl: string;
  store?: KeyValueStore;
  placeCache?: RecentPlaceCacheForClaims;
  now?: () => number;
  uploadPhoto?: (owner: ClaimOwner, placeId: string, file: File) => Promise<void>;
  photoRetry?: PhotoRetryStore;
  photoRetryIsDurable?: () => boolean;
};

type StoredGrant = OfflineClaimGrant & {
  id: string;
  ownerId: string;
  cachedBoundaryFingerprint?: string;
  cachedLatestBoundaryVersion?: string;
};

type LocalRecommendation = {
  id: string;
  ownerId: string;
  requestId: string;
  grantId: string;
  placeId: string;
  location: ClaimLocation;
  boundaryVersion: string | number;
  createdAt: string;
};

type StoredQueueItem = {
  requestId: string;
  recommendationId: string;
  ownerId: string;
  grantId: string;
  placeId: string;
  location: ClaimLocation;
  boundaryVersion: string | number;
  createdAt: string;
  state: "pending" | "confirmed" | "rejected";
  photoState: OfflineClaimPhotoState;
  attemptCount: number;
  lastError?: string;
  pendingConfirmation: ClaimConfirmation;
  serverConfirmation?: ClaimConfirmation;
};

type StoredCollection<T> = {
  version: typeof STORAGE_VERSION;
  ownerId: string;
  items: T[];
};

type OwnerLane = {
  tail: Promise<void>;
  generation: number;
  clearing: boolean;
  clearPromise?: Promise<void>;
  drainPromise?: Promise<OfflineClaimDrainResult>;
  controllers: Set<AbortController>;
};

function ownerKey(accountId: string) {
  return encodeURIComponent(accountId);
}

function storageKey(kind: "grants" | "recommendations" | "queue", accountId: string) {
  return `parkdex:offline-claims:${kind}:v1:${ownerKey(accountId)}`;
}

function requireOwner(owner: OfflineClaimOwner): OfflineClaimOwner {
  if (!owner || owner.kind !== "account" || !owner.accountId || !owner.token) {
    throw new Error("Offline visit saving requires an authenticated account.");
  }
  return owner;
}

function uuid() {
  if (typeof crypto === "undefined" || typeof crypto.randomUUID !== "function") {
    throw new Error("Secure offline visit IDs are unavailable on this device.");
  }
  return crypto.randomUUID();
}

function versionMatches(left: string | number | null | undefined, right: string | number | null | undefined) {
  return left !== null && left !== undefined && right !== null && right !== undefined && String(left) === String(right);
}

function validateLocation(location: ClaimLocation, now: number) {
  if (!Number.isFinite(location.latitude) || !Number.isFinite(location.longitude)
    || location.latitude < -90 || location.latitude > 90
    || location.longitude < -180 || location.longitude > 180
    || !Number.isFinite(location.accuracyMeters) || location.accuracyMeters <= 0
    || !Number.isFinite(location.capturedAtEpochMs)) {
    throw new Error("A valid precise location is needed to check in offline.");
  }
  const age = now - location.capturedAtEpochMs;
  if (age < 0 || age > OFFLINE_CLAIM_LOCATION_MAX_AGE_MS) {
    throw new Error("Your location is out of date. Refresh your location before saving this visit.");
  }
  if (location.accuracyMeters > OFFLINE_CLAIM_LOCATION_MAX_ACCURACY_METERS) {
    throw new Error("Your location is too broad. Turn on Precise location and try again.");
  }
}

function parseCollection<T>(value: string | null, ownerId: string): T[] {
  if (value === null) return [];
  let parsed: Partial<StoredCollection<T>>;
  try {
    parsed = JSON.parse(value) as Partial<StoredCollection<T>>;
  } catch {
    throw new Error("Saved offline visit data could not be read. It remains on this device; reset offline visit data before continuing.");
  }
  if (parsed.version !== STORAGE_VERSION || parsed.ownerId !== ownerId || !Array.isArray(parsed.items)) {
    throw new Error("Saved offline visit data has an unsupported format. It remains on this device; reset offline visit data before continuing.");
  }
  return parsed.items;
}

function serializeCollection<T>(ownerId: string, items: T[]) {
  return JSON.stringify({ version: STORAGE_VERSION, ownerId, items } satisfies StoredCollection<T>);
}

function boundaryArea(boundary: BoundaryFeature): number {
  const ringArea = (coordinates: readonly number[][]) => {
    let area = 0;
    for (let index = 0; index < coordinates.length - 1; index += 1) {
      const current = coordinates[index];
      const next = coordinates[index + 1];
      area += current[0] * next[1] - next[0] * current[1];
    }
    return Math.abs(area / 2);
  };
  const polygonArea = (polygon: readonly (readonly number[][])[]) => Math.max(0,
    ringArea(polygon[0]) - polygon.slice(1).reduce((sum, hole) => sum + ringArea(hole), 0));
  return boundary.geometry.type === "Polygon"
    ? polygonArea(boundary.geometry.coordinates as readonly (readonly number[][])[])
    : boundary.geometry.coordinates.reduce((sum, polygon) => sum + polygonArea(polygon as readonly (readonly number[][])[]), 0);
}

function pendingConfirmation(item: StoredQueueItem): ClaimConfirmation {
  if (item.serverConfirmation) return item.serverConfirmation;
  return { ...item.pendingConfirmation, pendingSync: true };
}

function isServerConfirmed(value: unknown, placeId: string): value is ClaimConfirmation {
  if (typeof value !== "object" || value === null) return false;
  const confirmation = value as Partial<ClaimConfirmation>;
  return confirmation.placeId === placeId
    && confirmation.visited === true
    && confirmation.pendingSync !== true
    && typeof confirmation.visitedAt === "string"
    && Number.isFinite(confirmation.visitedCount)
    && typeof confirmation.claim === "object"
    && confirmation.claim !== null;
}

function localConfirmation(item: LocalRecommendation, now: number): ClaimConfirmation {
  const capturedAt = new Date(item.location.capturedAtEpochMs).toISOString();
  const claim: VisitClaim = {
    claimedAt: new Date(now).toISOString(),
    capturedAt,
    coordinates: { latitude: item.location.latitude, longitude: item.location.longitude },
    accuracyMeters: item.location.accuracyMeters,
    boundaryVersion: String(item.boundaryVersion),
    matchKind: "exact",
    distanceMeters: 0,
    hasPhoto: false,
  };
  return { placeId: item.placeId, visited: true, visitedCount: 0, visitedAt: capturedAt, claim, pendingSync: true };
}

function messageFor(error: unknown) {
  if (error instanceof Error && error.message) return error.message;
  return "This offline visit is waiting for a connection. Try syncing again.";
}

function shouldReject(error: unknown) {
  if (!(error instanceof ApiError)) return false;
  if (error.status === 401 || error.status === 408 || error.status === 425 || error.status === 429 || error.status >= 500) return false;
  return error.status >= 400;
}

function isDurablePhotoStorage() {
  const capacitor = (globalThis as typeof globalThis & { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor;
  return capacitor?.isNativePlatform?.() === true || typeof indexedDB !== "undefined";
}

function newController(lane: OwnerLane) {
  const controller = new AbortController();
  lane.controllers.add(controller);
  return controller;
}

export function createOfflineClaimsService(options: OfflineClaimsServiceOptions) {
  let storagePromise: Promise<KeyValueStore> | undefined;
  const lanes = new Map<string, OwnerLane>();
  const storage = () => options.store ?? (storagePromise ??= getPlatformStorage());
  const cache = () => options.placeCache ?? getRecentPlaceCache();
  const currentTime = () => (options.now ?? Date.now)();
  const photoStore = () => options.photoRetry ?? getNativeCapabilities().photoRetry;
  const photoIsDurable = () => options.photoRetryIsDurable?.() ?? isDurablePhotoStorage();

  function laneFor(accountId: string): OwnerLane {
    let lane = lanes.get(accountId);
    if (!lane) {
      lane = { tail: Promise.resolve(), generation: 0, clearing: false, controllers: new Set() };
      lanes.set(accountId, lane);
    }
    return lane;
  }

  function enqueue<T>(accountId: string, operation: (lane: OwnerLane, generation: number) => Promise<T>): Promise<T> {
    const lane = laneFor(accountId);
    if (lane.clearing) return Promise.reject(new Error("Offline visit storage is being cleared for this account."));
    const generation = lane.generation;
    const result = lane.tail.then(async () => {
      if (lane.clearing || lane.generation !== generation) throw new Error("This account changed before the offline visit operation finished.");
      return operation(lane, generation);
    });
    lane.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  function assertCurrent(lane: OwnerLane, generation: number) {
    if (lane.clearing || lane.generation !== generation) {
      throw new Error("This account changed before the offline visit operation finished.");
    }
  }

  async function read<T>(key: string, accountId: string) {
    const target = await storage();
    return parseCollection<T>(await target.getItem(key), accountId);
  }

  async function write<T>(key: string, accountId: string, items: T[]) {
    const target = await storage();
    await target.setItem(key, serializeCollection(accountId, items));
  }

  async function storeQueue(lane: OwnerLane, generation: number, accountId: string, items: StoredQueueItem[]) {
    assertCurrent(lane, generation);
    await write(storageKey("queue", accountId), accountId, items);
    assertCurrent(lane, generation);
  }

  function findGrant(grants: StoredGrant[], id: string, accountId: string) {
    return grants.find((grant) => grant.id === id && grant.ownerId === accountId);
  }

  async function syncPhoto(
    owner: OfflineClaimOwner,
    item: StoredQueueItem,
    lane: OwnerLane,
    generation: number,
    queue: StoredQueueItem[],
  ): Promise<OfflineClaimPhotoOutcome> {
    if (item.photoState === "none") {
      queue.splice(queue.indexOf(item), 1);
      await storeQueue(lane, generation, owner.accountId, queue);
      return { requestId: item.requestId, placeId: item.placeId, status: "none" };
    }

    const photos = photoStore();
    if (!photos) {
      if (item.photoState !== "missing") item.photoState = photoIsDurable() ? "retry" : "volatile";
      item.lastError = "The saved visit photo is unavailable for upload.";
      await storeQueue(lane, generation, owner.accountId, queue);
      return {
        requestId: item.requestId,
        placeId: item.placeId,
        status: item.photoState,
        message: item.lastError,
      };
    }

    let asset;
    try {
      asset = await photos.load(`account:${owner.accountId}`, item.placeId);
    } catch (error) {
      assertCurrent(lane, generation);
      if (item.photoState !== "missing") item.photoState = photoIsDurable() ? "retry" : "volatile";
      item.lastError = messageFor(error);
      await storeQueue(lane, generation, owner.accountId, queue);
      return { requestId: item.requestId, placeId: item.placeId, status: item.photoState, message: item.lastError };
    }

    assertCurrent(lane, generation);
    if (!asset) {
      item.photoState = "missing";
      item.lastError = photoIsDurable()
        ? "The accepted visit photo is missing from retry storage. Choose it again to attach it."
        : "This device could not keep the accepted photo for retry. Choose it again to attach it.";
      await storeQueue(lane, generation, owner.accountId, queue);
      return { requestId: item.requestId, placeId: item.placeId, status: "missing", message: item.lastError };
    }

    if (!options.uploadPhoto) {
      item.photoState = photoIsDurable() ? "retry" : "volatile";
      item.lastError = "The visit is saved. Its photo is waiting for an upload handler.";
      await storeQueue(lane, generation, owner.accountId, queue);
      return { requestId: item.requestId, placeId: item.placeId, status: item.photoState, message: item.lastError };
    }

    try {
      await options.uploadPhoto({ kind: "account", token: owner.token }, item.placeId, asset.file);
      assertCurrent(lane, generation);
      if (item.serverConfirmation) {
        item.serverConfirmation = { ...item.serverConfirmation, claim: { ...item.serverConfirmation.claim, hasPhoto: true } };
      }
      await photos.remove(`account:${owner.accountId}`, item.placeId);
      assertCurrent(lane, generation);
      queue.splice(queue.indexOf(item), 1);
      await storeQueue(lane, generation, owner.accountId, queue);
      return { requestId: item.requestId, placeId: item.placeId, status: "uploaded" };
    } catch (error) {
      assertCurrent(lane, generation);
      item.photoState = photoIsDurable() ? "retry" : "volatile";
      item.lastError = messageFor(error);
      await storeQueue(lane, generation, owner.accountId, queue);
      return { requestId: item.requestId, placeId: item.placeId, status: item.photoState, message: item.lastError };
    }
  }

  async function retainExpectedPhoto(
    owner: OfflineClaimOwner,
    item: StoredQueueItem,
    queue: StoredQueueItem[],
    lane: OwnerLane,
    generation: number,
  ) {
    if (item.serverConfirmation?.claim.hasPhoto) return;
    const photos = photoStore();
    if (!photos) throw new Error("The accepted visit photo is not saved for retry yet. Save the photo again before queuing this visit.");
    let savedPhoto;
    try {
      savedPhoto = await photos.load(`account:${owner.accountId}`, item.placeId);
    } catch (error) {
      throw new Error(`Could not check the saved photo before queuing this visit: ${messageFor(error)}`);
    }
    assertCurrent(lane, generation);
    if (!savedPhoto) throw new Error("The accepted visit photo is not saved for retry yet. Save the photo again before queuing this visit.");
    item.photoState = photoIsDurable() ? "pending" : "volatile";
    item.lastError = undefined;
    await storeQueue(lane, generation, owner.accountId, queue);
  }

  async function maintainGrants(owner: OfflineClaimOwner, lane: OwnerLane, generation: number, grants: StoredGrant[]) {
    const queue = await read<StoredQueueItem>(storageKey("queue", owner.accountId), owner.accountId);
    const recommendationKey = storageKey("recommendations", owner.accountId);
    const recommendations = await read<LocalRecommendation>(recommendationKey, owner.accountId);
    const savedAt = currentTime();
    const liveRecommendations = recommendations.filter((item) => {
      const age = savedAt - Date.parse(item.createdAt);
      return age >= 0 && age <= OFFLINE_CLAIM_LOCATION_MAX_AGE_MS;
    });
    if (liveRecommendations.length !== recommendations.length) {
      await write(recommendationKey, owner.accountId, liveRecommendations);
    }
    const referenced = new Set([
      ...queue.filter((item) => item.state === "pending" || item.state === "confirmed")
        .map((item) => item.grantId),
      ...liveRecommendations.map((item) => item.grantId),
    ]);
    const newestUsable = grants
      .filter((item) => Date.parse(item.expiresAt) > savedAt)
      .sort((left, right) => Date.parse(right.issuedAt) - Date.parse(left.issuedAt)
        || grants.indexOf(right) - grants.indexOf(left))[0];
    const retained = grants.filter((item) => item.id === newestUsable?.id || referenced.has(item.id));
    assertCurrent(lane, generation);
    await write(storageKey("grants", owner.accountId), owner.accountId, retained);
    assertCurrent(lane, generation);
    return retained;
  }

  async function cachedBoundarySnapshot() {
    const placeCache = cache();
    const bundles = placeCache.listForClaims ? await placeCache.listForClaims() : await placeCache.list();
    const versions = bundles
      .filter((bundle) => bundle.boundaryVersion !== null)
      .map((bundle) => String(bundle.boundaryVersion));
    return {
      fingerprint: [...new Set(versions)].sort().join("\u0000"),
      latestVersion: versions[0],
    };
  }

  async function issueAndPersistGrant(owner: OfflineClaimOwner, lane: OwnerLane, generation: number) {
    const controller = newController(lane);
    let grant: OfflineClaimGrant;
    try {
      grant = await issueOfflineClaimGrantRequest(options.apiBaseUrl, owner, controller.signal);
    } finally {
      lane.controllers.delete(controller);
    }
    assertCurrent(lane, generation);
    if (!grant.grantToken || !Number.isFinite(Date.parse(grant.issuedAt)) || !Number.isFinite(Date.parse(grant.expiresAt))
      || Date.parse(grant.expiresAt) <= currentTime() || grant.boundaryVersion === null || grant.boundaryVersion === undefined) {
      throw new Error("The server returned an invalid offline visit grant.");
    }
    let boundarySnapshot: Awaited<ReturnType<typeof cachedBoundarySnapshot>> | undefined;
    try {
      const snapshot = await cachedBoundarySnapshot();
      if (snapshot.fingerprint) boundarySnapshot = snapshot;
    } catch {
      // A catalogue cache miss does not prevent retaining a valid grant.
    }
    assertCurrent(lane, generation);
    const grants = await read<StoredGrant>(storageKey("grants", owner.accountId), owner.accountId);
    const savedGrant = {
      ...grant,
      id: uuid(),
      ownerId: owner.accountId,
      cachedBoundaryFingerprint: boundarySnapshot?.fingerprint,
      cachedLatestBoundaryVersion: boundarySnapshot?.latestVersion,
    } satisfies StoredGrant;
    await maintainGrants(owner, lane, generation, [...grants, savedGrant]);
  }

  async function grantNeedsRefresh(grant: StoredGrant, now: number, refreshBeforeMs: number) {
    if (Date.parse(grant.expiresAt) - now <= refreshBeforeMs) return true;
    try {
      const snapshot = await cachedBoundarySnapshot();
      return Boolean(snapshot.latestVersion)
        && snapshot.latestVersion !== String(grant.boundaryVersion)
        && (grant.cachedBoundaryFingerprint !== snapshot.fingerprint
          || grant.cachedLatestBoundaryVersion !== snapshot.latestVersion);
    } catch {
      return false;
    }
  }

  return {
    async provisionGrant(ownerInput: OfflineClaimOwner): Promise<void> {
      const owner = requireOwner(ownerInput);
      await enqueue(owner.accountId, (lane, generation) => issueAndPersistGrant(owner, lane, generation));
    },

    async ensureGrant(ownerInput: OfflineClaimOwner, refreshBeforeMs = 24 * 60 * 60 * 1_000): Promise<void> {
      const owner = requireOwner(ownerInput);
      if (!Number.isFinite(refreshBeforeMs) || refreshBeforeMs < 0) throw new Error("The offline grant refresh window is invalid.");
      await enqueue(owner.accountId, async (lane, generation) => {
        const now = currentTime();
        const grants = await read<StoredGrant>(storageKey("grants", owner.accountId), owner.accountId);
        const newest = grants
          .filter((item) => item.ownerId === owner.accountId && Date.parse(item.expiresAt) > now)
          .sort((left, right) => Date.parse(right.issuedAt) - Date.parse(left.issuedAt)
            || grants.indexOf(right) - grants.indexOf(left))[0];
        const refresh = !newest || await grantNeedsRefresh(newest, now, refreshBeforeMs);
        if (refresh) {
          await issueAndPersistGrant(owner, lane, generation);
        } else {
          await maintainGrants(owner, lane, generation, grants);
        }
      });
    },

    async recommendLocal(ownerInput: OfflineClaimOwner, input: { location: ClaimLocation; excludedPlaceIds?: ReadonlySet<string> }): Promise<ClaimRecommendation> {
      const owner = requireOwner(ownerInput);
      const now = currentTime();
      validateLocation(input.location, now);
      return enqueue(owner.accountId, async (lane, generation) => {
        const queue = await read<StoredQueueItem>(storageKey("queue", owner.accountId), owner.accountId);
        const excludedPlaceIds = new Set(input.excludedPlaceIds ?? []);
        for (const item of queue) {
          if (item.ownerId === owner.accountId && item.state !== "rejected") excludedPlaceIds.add(item.placeId);
        }
        const grantList = await read<StoredGrant>(storageKey("grants", owner.accountId), owner.accountId);
        const grant = grantList
          .filter((item) => item.ownerId === owner.accountId && Date.parse(item.expiresAt) > now)
          .sort((left, right) => Date.parse(right.issuedAt) - Date.parse(left.issuedAt)
            || grantList.indexOf(right) - grantList.indexOf(left))[0];
        if (!grant) throw new Error("Reconnect to prepare offline visit saving before you leave service.");
        const placeCache = cache();
        const bundles = placeCache.listForClaims ? await placeCache.listForClaims() : await placeCache.list();
        assertCurrent(lane, generation);
        const recommendationNow = currentTime();
        validateLocation(input.location, recommendationNow);
        if (Date.parse(grant.expiresAt) <= recommendationNow) throw new Error("Your offline visit grant expired. Reconnect before trying again.");
        const matching = bundles.filter((bundle) => !excludedPlaceIds.has(bundle.place.id)
          && bundle.place.id === bundle.boundary?.properties.id
          && versionMatches(bundle.boundaryVersion, grant.boundaryVersion)
          && isPointInBoundary(input.location, bundle.boundary));
        matching.sort((left, right) => {
          const leftIsland = left.place.category === "island" ? 1 : 0;
          const rightIsland = right.place.category === "island" ? 1 : 0;
          if (leftIsland !== rightIsland) return leftIsland - rightIsland;
          const sizeDifference = boundaryArea(left.boundary!) - boundaryArea(right.boundary!);
          if (Math.abs(sizeDifference) > 1e-12) return sizeDifference;
          return left.place.id < right.place.id ? -1 : left.place.id > right.place.id ? 1 : 0;
        });
        const selected = matching[0];
        if (!selected?.boundary || selected.boundaryVersion === null) return { status: "none" };

        const id = uuid();
        const recommendationExpiresAt = new Date(Math.min(
          Date.parse(grant.expiresAt),
          input.location.capturedAtEpochMs + OFFLINE_CLAIM_LOCATION_MAX_AGE_MS,
        )).toISOString();
        const recommendation: LocalRecommendation = {
          id,
          ownerId: owner.accountId,
          requestId: uuid(),
          grantId: grant.id,
          placeId: selected.place.id,
          location: { ...input.location },
          boundaryVersion: selected.boundaryVersion,
          createdAt: new Date(recommendationNow).toISOString(),
        };
        const key = storageKey("recommendations", owner.accountId);
        const saved = await read<LocalRecommendation>(key, owner.accountId);
        const unexpired = saved.filter((item) => now - Date.parse(item.createdAt) <= OFFLINE_CLAIM_LOCATION_MAX_AGE_MS);
        unexpired.push(recommendation);
        await write(key, owner.accountId, unexpired.slice(-MAX_SAVED_RECOMMENDATIONS));
        assertCurrent(lane, generation);
        return {
          status: "recommended",
          recommendationToken: `${RECOMMENDATION_PREFIX}${id}`,
          expiresAt: recommendationExpiresAt,
          candidate: { placeId: selected.place.id, matchKind: "exact", distanceMeters: 0 },
        };
      });
    },

    isOfflineToken(token: string) {
      return isOfflineClaimRecommendationToken(token);
    },

    async createLocal(ownerInput: OfflineClaimOwner, input: { recommendationToken: string; expectedPlaceId: string; photoExpected?: boolean }): Promise<ClaimConfirmation> {
      const owner = requireOwner(ownerInput);
      if (!input.recommendationToken.startsWith(RECOMMENDATION_PREFIX)) throw new Error("This is not an offline visit recommendation.");
      const id = input.recommendationToken.slice(RECOMMENDATION_PREFIX.length);
      return enqueue(owner.accountId, async (lane, generation) => {
        const queueKey = storageKey("queue", owner.accountId);
        const queue = await read<StoredQueueItem>(queueKey, owner.accountId);
        const previous = queue.find((item) => item.recommendationId === id && item.ownerId === owner.accountId);
        if (previous) {
          if (previous.placeId !== input.expectedPlaceId) throw new Error("This recommendation is for a different place.");
          if (previous.state === "rejected") throw new Error(previous.lastError ?? "This offline visit needs attention before it can sync.");
          if (input.photoExpected) await retainExpectedPhoto(owner, previous, queue, lane, generation);
          return pendingConfirmation(previous);
        }

        const recommendationKey = storageKey("recommendations", owner.accountId);
        const recommendations = await read<LocalRecommendation>(recommendationKey, owner.accountId);
        const recommendation = recommendations.find((item) => item.id === id && item.ownerId === owner.accountId);
        if (!recommendation) throw new Error("This offline recommendation expired. Refresh your location and try again.");
        if (recommendation.placeId !== input.expectedPlaceId) throw new Error("This recommendation is for a different place.");
        const now = currentTime();
        validateLocation(recommendation.location, now);

        const grants = await read<StoredGrant>(storageKey("grants", owner.accountId), owner.accountId);
        const grant = findGrant(grants, recommendation.grantId, owner.accountId);
        if (!grant || Date.parse(grant.expiresAt) <= now) throw new Error("Your offline visit grant expired. Reconnect before trying again.");
        if (!versionMatches(grant.boundaryVersion, recommendation.boundaryVersion)) throw new Error("The saved boundary changed. Reconnect and check your location again.");

        const bundle = await cache().get(recommendation.placeId);
        assertCurrent(lane, generation);
        if (!bundle || bundle.place.id !== recommendation.placeId || bundle.boundary?.properties.id !== recommendation.placeId
          || !versionMatches(bundle.boundaryVersion, grant.boundaryVersion)
          || !versionMatches(bundle.boundaryVersion, recommendation.boundaryVersion)
          || !isPointInBoundary(recommendation.location, bundle.boundary)) {
          throw new Error("The saved boundary no longer matches this location. Reconnect and check your location again.");
        }

        const existingForPlace = queue.find((item) => item.ownerId === owner.accountId
          && item.placeId === input.expectedPlaceId
          && item.state !== "rejected");
        if (existingForPlace) {
          if (input.photoExpected) await retainExpectedPhoto(owner, existingForPlace, queue, lane, generation);
          recommendations.splice(recommendations.indexOf(recommendation), 1);
          await write(recommendationKey, owner.accountId, recommendations);
          assertCurrent(lane, generation);
          return pendingConfirmation(existingForPlace);
        }

        const queued: StoredQueueItem = {
          requestId: recommendation.requestId,
          recommendationId: recommendation.id,
          ownerId: owner.accountId,
          grantId: recommendation.grantId,
          placeId: recommendation.placeId,
          location: recommendation.location,
          boundaryVersion: recommendation.boundaryVersion,
          createdAt: recommendation.createdAt,
          state: "pending",
          photoState: input.photoExpected ? "missing" : "none",
          attemptCount: 0,
          pendingConfirmation: undefined as unknown as ClaimConfirmation,
        };
        const retryPhotos = photoStore();
        let savedPhoto: Awaited<ReturnType<PhotoRetryStore["load"]>> = null;
        if (retryPhotos) {
          try {
            savedPhoto = await retryPhotos.load(`account:${owner.accountId}`, queued.placeId);
          } catch (error) {
            throw new Error(`Could not check the saved photo before queuing this visit: ${messageFor(error)}`);
          }
        }
        if (input.photoExpected && !savedPhoto) {
          throw new Error("The accepted visit photo is not saved for retry yet. Save the photo again before queuing this visit.");
        }
        if (savedPhoto) queued.photoState = photoIsDurable() ? "pending" : "volatile";
        queued.pendingConfirmation = localConfirmation(recommendation, now);
        queue.push(queued);
        await storeQueue(lane, generation, owner.accountId, queue);
        recommendations.splice(recommendations.indexOf(recommendation), 1);
        await write(recommendationKey, owner.accountId, recommendations);
        assertCurrent(lane, generation);
        return pendingConfirmation(queued);
      });
    },

    async pending(ownerInput: OfflineClaimOwner): Promise<number> {
      const owner = requireOwner(ownerInput);
      return enqueue(owner.accountId, async () => (await read<StoredQueueItem>(storageKey("queue", owner.accountId), owner.accountId))
        .filter((item) => item.ownerId === owner.accountId && item.state === "pending").length);
    },

    async list(ownerInput: OfflineClaimOwner): Promise<OfflineClaimQueueItem[]> {
      const owner = requireOwner(ownerInput);
      return enqueue(owner.accountId, async () => (await read<StoredQueueItem>(storageKey("queue", owner.accountId), owner.accountId))
        .filter((item) => item.ownerId === owner.accountId)
        .map(({ requestId, placeId, state, photoState, createdAt, lastError, attemptCount }) => ({
          requestId,
          placeId,
          state: state === "confirmed" ? "photo-retry" : state,
          photoState,
          createdAt,
          lastError,
          attemptCount,
        })));
    },

    async drain(ownerInput: OfflineClaimOwner): Promise<OfflineClaimDrainResult> {
      const owner = requireOwner(ownerInput);
      const lane = laneFor(owner.accountId);
      if (lane.drainPromise) return lane.drainPromise;
      const result = enqueue(owner.accountId, async (currentLane, generation) => {
        const queueKey = storageKey("queue", owner.accountId);
        const queue = await read<StoredQueueItem>(queueKey, owner.accountId);
        const grants = await read<StoredGrant>(storageKey("grants", owner.accountId), owner.accountId);
        const confirmed: ClaimConfirmation[] = [];
        const photos: OfflineClaimPhotoOutcome[] = [];

        for (const item of queue.slice()) {
          assertCurrent(currentLane, generation);
          if (item.ownerId !== owner.accountId || item.state === "rejected") continue;

          if (item.state === "confirmed") {
            const grant = findGrant(grants, item.grantId, owner.accountId);
            if (!grant) {
              item.lastError = "The offline visit grant for this saved confirmation is unavailable. Reconnect before retrying.";
              await storeQueue(currentLane, generation, owner.accountId, queue);
              continue;
            }
            const controller = newController(currentLane);
            item.attemptCount += 1;
            try {
              const receipt = await createOfflineClaimRequest(options.apiBaseUrl, { kind: "account", token: owner.token }, {
                requestId: item.requestId,
                grantToken: grant.grantToken,
                expectedPlaceId: item.placeId,
                location: item.location,
              }, controller.signal);
              assertCurrent(currentLane, generation);
              if (!isServerConfirmed(receipt, item.placeId)) {
                throw new ApiError("The server did not confirm this saved visit receipt.", 502);
              }
              item.serverConfirmation = receipt;
              item.lastError = undefined;
              await storeQueue(currentLane, generation, owner.accountId, queue);
            } catch (error) {
              assertCurrent(currentLane, generation);
              item.lastError = messageFor(error);
              if (shouldReject(error)) item.state = "rejected";
              await storeQueue(currentLane, generation, owner.accountId, queue);
              continue;
            } finally {
              currentLane.controllers.delete(controller);
            }
            const photo = await syncPhoto(owner, item, currentLane, generation, queue);
            photos.push(photo);
            if (isServerConfirmed(item.serverConfirmation, item.placeId)) confirmed.push(item.serverConfirmation);
            continue;
          }

          const grant = findGrant(grants, item.grantId, owner.accountId);
          if (!grant) {
            item.state = "rejected";
            item.lastError = "The offline visit grant for this saved visit is unavailable. Reconnect and check in again.";
            await storeQueue(currentLane, generation, owner.accountId, queue);
            continue;
          }

          const controller = newController(currentLane);
          item.attemptCount += 1;
          try {
            const confirmation = await createOfflineClaimRequest(options.apiBaseUrl, { kind: "account", token: owner.token }, {
              requestId: item.requestId,
              grantToken: grant.grantToken,
              expectedPlaceId: item.placeId,
              location: item.location,
            }, controller.signal);
            assertCurrent(currentLane, generation);
            if (confirmation.placeId !== item.placeId || confirmation.pendingSync) {
              throw new ApiError("The server returned a confirmation for a different visit.", 502);
            }
            item.state = "confirmed";
            item.serverConfirmation = confirmation;
            item.lastError = undefined;
            await storeQueue(currentLane, generation, owner.accountId, queue);
            const photo = await syncPhoto(owner, item, currentLane, generation, queue);
            photos.push(photo);
            confirmed.push(item.serverConfirmation ?? confirmation);
          } catch (error) {
            assertCurrent(currentLane, generation);
            item.state = shouldReject(error) ? "rejected" : "pending";
            item.lastError = messageFor(error);
            await storeQueue(currentLane, generation, owner.accountId, queue);
          } finally {
            currentLane.controllers.delete(controller);
          }
        }
        return { confirmed, photos };
      });
      lane.drainPromise = result.finally(() => { lane.drainPromise = undefined; });
      return lane.drainPromise;
    },

    async discardRejected(ownerInput: OfflineClaimOwner): Promise<number> {
      const owner = requireOwner(ownerInput);
      return enqueue(owner.accountId, async (lane, generation) => {
        const queueKey = storageKey("queue", owner.accountId);
        const queue = await read<StoredQueueItem>(queueKey, owner.accountId);
        const retained = queue.filter((item) => item.ownerId !== owner.accountId || item.state !== "rejected");
        const discardedCount = queue.length - retained.length;
        if (discardedCount > 0) await storeQueue(lane, generation, owner.accountId, retained);
        return discardedCount;
      });
    },

    async cancelPlace(ownerInput: OfflineClaimOwner, placeId: string): Promise<number> {
      const owner = requireOwner(ownerInput);
      if (!placeId) throw new Error("A place is required to cancel saved offline visits.");
      return enqueue(owner.accountId, async (lane, generation) => {
        const queueKey = storageKey("queue", owner.accountId);
        const queue = await read<StoredQueueItem>(queueKey, owner.accountId);
        const cancelled = queue.filter((item) => item.ownerId === owner.accountId && item.placeId === placeId);
        if (cancelled.length === 0) return 0;
        const retained = queue.filter((item) => item.ownerId !== owner.accountId || item.placeId !== placeId);
        if (retained.length > 0) {
          await storeQueue(lane, generation, owner.accountId, retained);
        } else {
          assertCurrent(lane, generation);
          const target = await storage();
          await target.removeItem(queueKey);
          assertCurrent(lane, generation);
        }
        return cancelled.length;
      });
    },

    async cancelPhotoRetry(ownerInput: OfflineClaimOwner, placeId: string): Promise<void> {
      const owner = requireOwner(ownerInput);
      if (!placeId) throw new Error("A place is required to remove its saved visit photo.");
      await enqueue(owner.accountId, async (lane, generation) => {
        const queueKey = storageKey("queue", owner.accountId);
        const queue = await read<StoredQueueItem>(queueKey, owner.accountId);
        let changed = false;
        for (const item of queue) {
          if (item.ownerId === owner.accountId && item.placeId === placeId && item.photoState !== "none") {
            item.photoState = "none";
            changed = true;
          }
        }
        if (changed) await storeQueue(lane, generation, owner.accountId, queue);
        const photos = photoStore();
        if (photos) {
          assertCurrent(lane, generation);
          await photos.remove(`account:${owner.accountId}`, placeId);
          assertCurrent(lane, generation);
        }
      });
    },

    async clearOwner(accountId: string): Promise<void> {
      if (!accountId) return;
      const lane = laneFor(accountId);
      if (lane.clearPromise) return lane.clearPromise;
      lane.generation += 1;
      lane.clearing = true;
      for (const controller of lane.controllers) controller.abort();
      const clearing = (async () => {
        await lane.tail;
        const target = await storage();
        await Promise.all([
          target.removeItem(storageKey("grants", accountId)),
          target.removeItem(storageKey("recommendations", accountId)),
          target.removeItem(storageKey("queue", accountId)),
        ]);
      })();
      lane.clearPromise = clearing.finally(() => {
        lane.clearing = false;
        lane.drainPromise = undefined;
        lane.clearPromise = undefined;
      });
      return lane.clearPromise;
    },
  };
}

export type OfflineClaimsService = ReturnType<typeof createOfflineClaimsService>;
