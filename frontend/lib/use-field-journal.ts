"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  ACCOUNT_TOKEN_KEY,
  ApiError,
  authenticate as authenticateAccount,
  completeGoogleAuthorization,
  confirmEmailVerification as confirmAccountEmailVerification,
  deleteAccount as deleteAccountRequest,
  importGuestProgress,
  loadAccount,
  logout as logoutAccount,
  requestEmailVerification as requestAccountEmailVerification,
  resetAccountProgress,
  type Account,
  type AccountDeletionResponse,
  type AccountSession,
  type Visit,
} from "./account";
import {
  IdentityEpoch,
  JOURNAL_STORAGE,
  accountPendingKey,
  importedGuestKey,
  readStored,
  removeStored,
  toggledSet,
  writeRawStored,
  writeStored,
  type PendingSnapshot,
} from "./field-journal-state";
import {
  createClaimRequest,
  loadVisitPhotoRequest,
  recommendClaimRequest,
  removeVisitPhotoRequest,
  uploadVisitPhotoRequest,
  type ClaimConfirmation,
  type ClaimOwner,
  type ClaimRecommendation,
  type ClaimRecommendationInput,
} from "./claims-client";
import { clearRestoredCameraPhoto } from "./capacitor-native-capabilities";
import { clearPhotoRetryOwner, currentNativeAppState, NATIVE_APP_STATE_EVENT } from "./native-capabilities";
import { clearUnresolvedClaim, clearUnresolvedClaims, hasUnresolvedClaim } from "./claim-recovery";
import { getPlatformStorage, type KeyValueStore } from "./platform-storage";
import { createCollectionKey, type Place } from "./places";
import type { Achievement } from "./achievements";
import {
  createOfflineClaimsService,
  type OfflineClaimOwner,
  type OfflineClaimQueueItem,
} from "./offline-claims";
import { VisitOutbox } from "./visit-outbox";

type Identity =
  | { kind: "guest"; collectionKey: string }
  | { kind: "account"; token: string; account: Account | null };

type CategoryTotals = Record<Place["category"], number>;
type CatalogueBadge = Achievement & { requiredPlaces?: Array<{ id: string; name: string }> };

type CataloguePayload = {
  total: number;
  categoryTotals: CategoryTotals;
  visitedCategoryTotals: CategoryTotals;
  visitedIds: string[];
  completedTrailIds?: string[];
  visits?: Visit[];
  coverageNote: string;
  visitClaims?: { supported: boolean; enforcement: "compatible" | "required"; offlineSupported?: boolean };
  badges: CatalogueBadge[];
};

type CatalogueMetadataSnapshot = Pick<CataloguePayload, "total" | "categoryTotals" | "visitedCategoryTotals" | "coverageNote" | "badges">;
type CatalogueContext = { ownerKey: string; headers: Record<string, string> };

export type VisitClaimMode = "unknown" | "legacy" | "compatible" | "required";

type AccountSnapshot = {
  account: Account;
  visitedIds: string[];
  completedTrailIds: string[];
  visitTimestamps?: Record<string, string>;
  visits?: Visit[];
};

type AccountDeletionIntent = {
  accountId: string;
  requestId: string;
  confirmed?: boolean;
  photoCleanupPending?: boolean;
};

export type AccountDeletionResult = AccountDeletionResponse & {
  /** Local device cleanup may need a later retry after server deletion succeeds. */
  localCleanupPending?: boolean;
};

type SwitchToGuestOptions = {
  clearRestoredCamera?: boolean;
  bestEffort?: boolean;
};

type AccountCleanupOptions = {
  clearAccountSnapshot?: boolean;
  clearCurrentAccountOutbox?: boolean;
  clearRestoredCamera?: boolean;
};

export type FieldJournal = {
  places: Place[];
  total: number;
  categoryTotals: CategoryTotals;
  visitedCategoryTotals: CategoryTotals;
  badges: CatalogueBadge[];
  catalogueOwnerKey: string;
  catalogueHeaders: Record<string, string>;
  visited: Set<string>;
  completedTrails: Set<string>;
  visitTimestamps: Record<string, string>;
  visitMetadata: Record<string, Visit>;
  coverageNote: string;
  account: Account | null;
  authenticated: boolean;
  loading: boolean;
  loadError: string;
  syncMessage: string;
  storageUnavailable: boolean;
  guestProgressAvailable: boolean;
  transitionBusy: boolean;
  /** Advances only when a progress reset has committed, independent of display copy. */
  progressRevision: number;
  pendingClaims: number;
  rejectedClaimCount: number;
  offlineClaimsAvailable: boolean;
  offlineClaimRecoveryCount: number;
  offlineClaimRecoveryMessage: string;
  visitClaimMode: VisitClaimMode;
  toggleVisit: (placeOrId: Pick<Place, "id"> | string) => Promise<void>;
  toggleTrail: (trailId: string) => Promise<void>;
  retryCatalogue: () => Promise<boolean>;
  retrySync: () => Promise<void>;
  retryPendingClaims: () => Promise<void>;
  discardRejectedClaims: () => Promise<number>;
  authenticate: (mode: "login" | "register", email: string, password: string) => Promise<void>;
  authenticateWithGoogle: (code: string, state: string, codeVerifier: string) => Promise<void>;
  requestEmailVerification: () => Promise<void>;
  confirmEmailVerification: (verificationToken: string) => Promise<void>;
  logout: () => Promise<void>;
  importGuest: () => Promise<void>;
  resetProgress: () => Promise<void>;
  deleteAccount: () => Promise<AccountDeletionResult>;
  recommendClaim?: (input: ClaimRecommendationInput) => Promise<ClaimRecommendation>;
  createClaim?: (input: { recommendationToken: string; expectedPlaceId: string; photoExpected?: boolean }) => Promise<ClaimConfirmation>;
  reconcileClaim?: (placeId: string) => Promise<ClaimConfirmation | null>;
  uploadVisitPhoto?: (placeId: string, file: File) => Promise<void>;
  loadVisitPhoto?: (placeId: string) => Promise<Blob>;
  removeVisitPhoto?: (placeId: string) => Promise<void>;
  authenticatedRequest: (path: string, init?: RequestInit) => Promise<Response>;
};

function hasEntries(outbox: VisitOutbox) {
  return outbox.hasPending();
}

function visitClaimModeFor(payload: CataloguePayload): VisitClaimMode {
  const capability = payload.visitClaims;
  if (capability === undefined) {
    // An API from the immediately previous release has no capability field
    // and only understands the legacy authenticated PUT contract.
    return "legacy";
  }
  if (capability?.supported === true && (
    capability.enforcement === "compatible" || capability.enforcement === "required"
  )) return capability.enforcement;
  // A present but unrecognized capability is not an old API. Fail closed so
  // a future or malformed contract cannot silently reopen arbitrary writes.
  return "unknown";
}

function timestampsFor(visits: Visit[] | undefined): Record<string, string> {
  return Object.fromEntries((visits ?? []).map((visit) => [visit.placeId, visit.visitedAt]));
}

/** Compact legacy rows only; current online catalogue data is viewport or search scoped. */
function compactPlaceIndex({ id, name, category, latitude, longitude, region, sourceName, sourceId }: Place): Place {
  return {
    id, name, category, latitude, longitude, region, sourceName, sourceId,
    description: "", sourceUrl: "",
  };
}

/** Compact and cap a legacy index before it is kept in journal state or storage. */
export function catalogueIndex(places: Place[]): Place[] {
  return places.slice(0, LEGACY_CATALOGUE_CACHE_LIMIT).map(compactPlaceIndex);
}

const LEGACY_CATALOGUE_CACHE_LIMIT = 100;
const EMPTY_CATEGORY_TOTALS: CategoryTotals = { national: 0, provincial: 0, regional: 0, island: 0 };
const CATALOGUE_STATE_STORAGE_PREFIX = "parkdex:catalogue-state:v1:";
const PLACE_CATEGORIES = ["national", "provincial", "regional", "island"] as const;

function normalizeCategoryTotals(value: unknown): CategoryTotals {
  if (typeof value !== "object" || value === null) return { ...EMPTY_CATEGORY_TOTALS };
  const candidate = value as Partial<CategoryTotals>;
  return Object.fromEntries(PLACE_CATEGORIES.map((category) => [
    category,
    Number.isFinite(candidate[category]) ? candidate[category] : 0,
  ])) as CategoryTotals;
}

function stableOwnerHash(value: string) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function catalogueContextFor(identity: Identity): CatalogueContext {
  if (identity.kind === "guest") {
    return {
      ownerKey: `guest:${stableOwnerHash(identity.collectionKey)}`,
      headers: { "X-Collection-Key": identity.collectionKey },
    };
  }
  const ownerKey = identity.account?.id
    ? `account:${identity.account.id}`
    : `account:pending-${stableOwnerHash(identity.token)}`;
  return { ownerKey, headers: { Authorization: `Bearer ${identity.token}` } };
}

function catalogueStateStorageKey(identity: Identity) {
  return `${CATALOGUE_STATE_STORAGE_PREFIX}${catalogueContextFor(identity).ownerKey}`;
}

function parseCatalogueMetadataSnapshot(value: unknown): CatalogueMetadataSnapshot | null {
  if (typeof value !== "object" || value === null) return null;
  const snapshot = value as Partial<CatalogueMetadataSnapshot>;
  const categoryTotals = snapshot.categoryTotals;
  if (!Number.isFinite(snapshot.total)
    || !categoryTotals
    || !PLACE_CATEGORIES.every((category) => Number.isFinite(categoryTotals[category]))
    || typeof snapshot.coverageNote !== "string"
    || !Array.isArray(snapshot.badges)) return null;
  return {
    total: snapshot.total as number,
    categoryTotals: normalizeCategoryTotals(categoryTotals),
    visitedCategoryTotals: normalizeCategoryTotals(snapshot.visitedCategoryTotals),
    coverageNote: snapshot.coverageNote,
    badges: snapshot.badges,
  };
}

function legacyPlaceSample(places: Place[], visited: ReadonlySet<string>, timestamps: Record<string, string>) {
  const compact = places.map(compactPlaceIndex);
  const visitedPlaces = compact.filter((place) => visited.has(place.id))
    .sort((left, right) => (Date.parse(timestamps[right.id] ?? "") || 0) - (Date.parse(timestamps[left.id] ?? "") || 0)
      || left.id.localeCompare(right.id));
  const national = compact.filter((place) => place.category === "national" && !visited.has(place.id));
  const islands = compact.filter((place) => place.category === "island" && !visited.has(place.id))
    .sort((left, right) => stableOwnerHash(left.id).localeCompare(stableOwnerHash(right.id)));
  const islandPriority = islands.slice(0, Math.ceil(islands.length / 3));
  const prioritized = new Set([...visitedPlaces, ...national, ...islandPriority].map((place) => place.id));
  const remaining = compact.filter((place) => !prioritized.has(place.id))
    .sort((left, right) => stableOwnerHash(left.id).localeCompare(stableOwnerHash(right.id)));
  return [...visitedPlaces, ...national, ...islandPriority, ...remaining]
    .filter((place, index, all) => all.findIndex((candidate) => candidate.id === place.id) === index)
    .slice(0, LEGACY_CATALOGUE_CACHE_LIMIT);
}

function metadataFor(visits: Visit[] | undefined, visitedIds?: Iterable<string>, timestamps: Record<string, string> = {}): Record<string, Visit> {
  const visited = visitedIds ? new Set(visitedIds) : undefined;
  const metadata = Object.fromEntries((visits ?? [])
    .filter((visit) => !visited || visited.has(visit.placeId))
    .map((visit) => [visit.placeId, visit]));
  for (const placeId of visited ?? []) {
    if (!metadata[placeId] && timestamps[placeId]) metadata[placeId] = { placeId, visitedAt: timestamps[placeId] };
  }
  return metadata;
}

function createAccountDeletionRequestId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") crypto.getRandomValues(bytes);
  else for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function claimOwner(identity: Identity): ClaimOwner {
  if (identity.kind !== "account") throw new Error("Sign in to save visits and private photos.");
  return { kind: "account", token: identity.token };
}

function offlineClaimOwner(identity: Identity): OfflineClaimOwner | null {
  if (identity.kind !== "account" || !identity.account?.id) return null;
  return { kind: "account", token: identity.token, accountId: identity.account.id };
}

function browserIsOnline() {
  return typeof navigator === "undefined" || navigator.onLine !== false;
}

function isClaimTransportFailure(error: unknown) {
  if (error instanceof ApiError) return error.status === 408 || error.status >= 500;
  if (error instanceof Error && ["AbortError", "NetworkError"].includes(error.name)) return true;
  return error instanceof TypeError;
}

function browserIsForeground() {
  return (typeof document === "undefined" || document.visibilityState !== "hidden") && currentNativeAppState();
}

function sameOwner(left: Identity, right: Identity) {
  return left.kind === right.kind && (left.kind === "account"
    ? left.token === (right.kind === "account" ? right.token : "")
      && (!left.account || !(right.kind === "account" && right.account) || left.account.id === right.account.id)
    : left.collectionKey === (right.kind === "guest" ? right.collectionKey : ""));
}

type VisitMutation = { revision: number; visit: Visit | null };

class VisitMutationJournal {
  private revision = 0;
  private readonly entries = new Map<string, VisitMutation>();

  checkpoint() { return this.revision; }

  record(placeId: string, visit: Visit | null) {
    this.revision += 1;
    this.entries.set(placeId, { revision: this.revision, visit });
  }

  reset() {
    this.revision = 0;
    this.entries.clear();
  }

  isRemoved(placeId: string) {
    return this.entries.get(placeId)?.visit === null;
  }

  rebase(
    visited: Set<string>,
    timestamps: Record<string, string>,
    metadata: Record<string, Visit>,
    checkpoint: number,
  ) {
    const nextVisited = new Set(visited);
    const nextTimestamps = { ...timestamps };
    const nextMetadata = { ...metadata };
    for (const [placeId, mutation] of this.entries) {
      if (mutation.revision <= checkpoint) continue;
      if (!mutation.visit) {
        nextVisited.delete(placeId);
        delete nextTimestamps[placeId];
        delete nextMetadata[placeId];
        continue;
      }
      nextVisited.add(placeId);
      nextTimestamps[placeId] = mutation.visit.visitedAt;
      nextMetadata[placeId] = mutation.visit;
    }
    return { visited: nextVisited, timestamps: nextTimestamps, metadata: nextMetadata };
  }
}

async function responseError(response: Response, fallback: string): Promise<ApiError> {
  let message = fallback;
  let code: string | undefined;
  try {
    const payload = await response.json() as { code?: string; detail?: string | { code?: string; message?: string } };
    code = payload.code ?? (typeof payload.detail === "object" ? payload.detail.code : undefined);
    message = typeof payload.detail === "string" ? payload.detail : payload.detail?.message ?? fallback;
    if (!code && message === "location_claim_required") code = message;
  } catch { /* fallback */ }
  return new ApiError(message, response.status, code);
}

function retryableCatalogueFailure(error: unknown) {
  return !(error instanceof ApiError && error.status >= 400 && error.status < 500 && ![408, 429].includes(error.status));
}

function isLocationClaimRequired(error: unknown): error is ApiError {
  return error instanceof ApiError && error.status === 409 && error.code === "location_claim_required";
}

export function useFieldJournal({ apiBaseUrl }: { apiBaseUrl: string }): FieldJournal {
  const [places, setPlaces] = useState<Place[]>([]);
  const [total, setTotal] = useState(0);
  const [categoryTotals, setCategoryTotals] = useState<CategoryTotals>(EMPTY_CATEGORY_TOTALS);
  const [visitedCategoryTotals, setVisitedCategoryTotals] = useState<CategoryTotals>(EMPTY_CATEGORY_TOTALS);
  const [badges, setBadges] = useState<CatalogueBadge[]>([]);
  const [catalogueContext, setCatalogueContext] = useState<CatalogueContext>({ ownerKey: "", headers: {} });
  const [visited, setVisited] = useState<Set<string>>(new Set());
  const [completedTrails, setCompletedTrails] = useState<Set<string>>(new Set());
  const [visitTimestamps, setVisitTimestamps] = useState<Record<string, string>>({});
  const [visitMetadata, setVisitMetadata] = useState<Record<string, Visit>>({});
  const [coverageNote, setCoverageNote] = useState("");
  const [account, setAccount] = useState<Account | null>(null);
  const [authenticated, setAuthenticated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [syncMessage, setSyncMessage] = useState("");
  const [storageUnavailable, setStorageUnavailable] = useState(false);
  const [guestProgressAvailable, setGuestProgressAvailable] = useState(false);
  const [transitionBusy, setTransitionBusy] = useState(false);
  const [progressRevision, setProgressRevision] = useState(0);
  const [pendingClaims, setPendingClaims] = useState(0);
  const [rejectedClaimCount, setRejectedClaimCount] = useState(0);
  const [offlineClaimsAvailable, setOfflineClaimsAvailable] = useState(false);
  const [offlineClaimRecoveryCount, setOfflineClaimRecoveryCount] = useState(0);
  const [offlineClaimRecoveryMessage, setOfflineClaimRecoveryMessage] = useState("");
  const [visitClaimMode, setVisitClaimMode] = useState<VisitClaimMode>("unknown");

  const epochRef = useRef(new IdentityEpoch());
  const transitionRef = useRef(false);
  const identityRef = useRef<Identity>({ kind: "guest", collectionKey: "" });
  const catalogueContextRef = useRef<CatalogueContext>({ ownerKey: "", headers: {} });
  const mountedRef = useRef(true);
  const placesRef = useRef(places);
  const catalogueReadyRef = useRef(false);
  const catalogueNeedsRecoveryRef = useRef(false);
  const catalogueStateSequenceRef = useRef(0);
  const catalogueBackgroundRequestRef = useRef<{ epoch: number; promise: Promise<boolean> } | null>(null);
  const refreshCatalogueAfterProgressChangeRef = useRef<(identity: Identity) => void>(() => {});
  const visitedRef = useRef(visited);
  const trailsRef = useRef(completedTrails);
  const visitTimestampsRef = useRef(visitTimestamps);
  const visitMetadataRef = useRef(visitMetadata);
  const storageRef = useRef<KeyValueStore | null>(null);
  const guestVisitOutboxRef = useRef(new VisitOutbox());
  const guestTrailOutboxRef = useRef(new VisitOutbox());
  const guestRevisionPendingRef = useRef(false);
  const guestRevisionMutationRef = useRef(Promise.resolve());
  const accountVisitOutboxRef = useRef(new VisitOutbox());
  const accountTrailOutboxRef = useRef(new VisitOutbox());
  const accountOutboxOwnerRef = useRef("");
  const accountDeletionIntentRef = useRef<AccountDeletionIntent | null>(null);
  const accountDeletionBootReplayRef = useRef(false);
  const visitMutationsRef = useRef(new VisitMutationJournal());
  const offlineClaimsService = useMemo(() => createOfflineClaimsService({
    apiBaseUrl,
    uploadPhoto: (owner, placeId, file) => uploadVisitPhotoRequest(apiBaseUrl, owner, placeId, file),
  }), [apiBaseUrl]);
  const offlineClaimsTaskRef = useRef<{ accountId: string; promise: Promise<void> } | null>(null);
  const pendingProgressResetCleanupRef = useRef("");
  const pendingLogoutCleanupRef = useRef("");
  const [hydrationReady] = useState(() => {
    let resolve: () => void = () => {};
    const promise = new Promise<void>((ready) => { resolve = ready; });
    return { promise, resolve };
  });

  const publishIdentity = useCallback((identity: Identity) => {
    identityRef.current = identity;
    const nextContext = catalogueContextFor(identity);
    const currentContext = catalogueContextRef.current;
    const currentHeaderKeys = Object.keys(currentContext.headers);
    if (currentContext.ownerKey === nextContext.ownerKey
      && currentHeaderKeys.length === Object.keys(nextContext.headers).length
      && currentHeaderKeys.every((key) => currentContext.headers[key] === nextContext.headers[key])) return;
    if (catalogueContextRef.current.ownerKey !== nextContext.ownerKey) {
      setTotal(0);
      setCategoryTotals(EMPTY_CATEGORY_TOTALS);
      setVisitedCategoryTotals(EMPTY_CATEGORY_TOTALS);
      setBadges([]);
      setCoverageNote("");
    }
    catalogueContextRef.current = nextContext;
    setCatalogueContext(nextContext);
  }, []);

  const noteStorageFailure = useCallback((success: boolean) => {
    if (!success) setStorageUnavailable(true);
    return success;
  }, []);

  const storage = useCallback(() => {
    if (!storageRef.current) throw new Error("Storage is not ready.");
    return storageRef.current;
  }, []);

  const hydrateCatalogueMetadata = useCallback(async (identity: Identity) => {
    let snapshot: CatalogueMetadataSnapshot | null;
    try {
      snapshot = parseCatalogueMetadataSnapshot(await readStored<unknown>(
        storage(),
        catalogueStateStorageKey(identity),
        null,
      ));
    } catch {
      return;
    }
    if (!snapshot || !sameOwner(identityRef.current, identity)) return;
    setTotal(snapshot.total);
    setCategoryTotals(snapshot.categoryTotals);
    setVisitedCategoryTotals(snapshot.visitedCategoryTotals);
    setBadges(snapshot.badges);
    setCoverageNote(snapshot.coverageNote);
  }, [storage]);

  const updateProgress = useCallback((nextVisited: Set<string>, nextTrails: Set<string>, nextVisitTimestamps = visitTimestampsRef.current, nextVisitMetadata = visitMetadataRef.current) => {
    visitedRef.current = nextVisited;
    trailsRef.current = nextTrails;
    visitTimestampsRef.current = nextVisitTimestamps;
    visitMetadataRef.current = nextVisitMetadata;
    setVisited(nextVisited);
    setCompletedTrails(nextTrails);
    setVisitTimestamps(nextVisitTimestamps);
    setVisitMetadata(nextVisitMetadata);
  }, []);

  const updatePlaces = useCallback((nextPlaces: Place[]) => {
    placesRef.current = nextPlaces;
    setPlaces(nextPlaces);
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const persistGuest = useCallback(async () => {
    const target = storage();
    if (identityRef.current.kind === "guest") {
      noteStorageFailure(await writeStored(target, JOURNAL_STORAGE.guestVisited, [...visitedRef.current]));
      noteStorageFailure(await writeStored(target, JOURNAL_STORAGE.guestVisitTimestamps, visitTimestampsRef.current));
      noteStorageFailure(await writeStored(target, JOURNAL_STORAGE.guestVisitMetadata, visitMetadataRef.current));
      noteStorageFailure(await writeStored(target, JOURNAL_STORAGE.guestTrails, [...trailsRef.current]));
    }
    noteStorageFailure(await writeStored(target, JOURNAL_STORAGE.guestVisitPending, guestVisitOutboxRef.current.snapshot()));
    noteStorageFailure(await writeStored(target, JOURNAL_STORAGE.guestTrailPending, guestTrailOutboxRef.current.snapshot()));
  }, [noteStorageFailure, storage]);

  const persistAccount = useCallback(async () => {
    const identity = identityRef.current;
    if (identity.kind !== "account" || !identity.account) return;
    const target = storage();
    noteStorageFailure(await writeStored(target, JOURNAL_STORAGE.accountSnapshot, {
      account: identity.account,
      visitedIds: [...visitedRef.current],
      completedTrailIds: [...trailsRef.current],
      visitTimestamps: visitTimestampsRef.current,
      visits: Object.values(visitMetadataRef.current),
    } satisfies AccountSnapshot));
    noteStorageFailure(await writeStored(target, accountPendingKey(identity.account.id, "visits"), accountVisitOutboxRef.current.snapshot()));
    noteStorageFailure(await writeStored(target, accountPendingKey(identity.account.id, "trails"), accountTrailOutboxRef.current.snapshot()));
  }, [noteStorageFailure, storage]);

  const persistAccountOutboxes = useCallback(async (accountId: string) => {
    const target = storage();
    noteStorageFailure(await writeStored(target, accountPendingKey(accountId, "visits"), accountVisitOutboxRef.current.snapshot()));
    noteStorageFailure(await writeStored(target, accountPendingKey(accountId, "trails"), accountTrailOutboxRef.current.snapshot()));
  }, [noteStorageFailure, storage]);

  const clearStoredGuestVisit = useCallback(async (placeId: string) => {
    const target = storage();
    const storedVisited = new Set(await readStored<string[]>(target, JOURNAL_STORAGE.guestVisited, []));
    const storedTimestamps = await readStored<Record<string, string>>(target, JOURNAL_STORAGE.guestVisitTimestamps, {});
    const storedMetadata = await readStored<Record<string, Visit>>(target, JOURNAL_STORAGE.guestVisitMetadata, {});
    storedVisited.delete(placeId);
    delete storedTimestamps[placeId];
    delete storedMetadata[placeId];
    const [visitedWritten, timestampsWritten, metadataWritten] = await Promise.all([
      writeStored(target, JOURNAL_STORAGE.guestVisited, [...storedVisited]),
      writeStored(target, JOURNAL_STORAGE.guestVisitTimestamps, storedTimestamps),
      writeStored(target, JOURNAL_STORAGE.guestVisitMetadata, storedMetadata),
    ]);
    noteStorageFailure(visitedWritten && timestampsWritten && metadataWritten);
    if (!visitedWritten || !timestampsWritten || !metadataWritten) {
      throw new Error("Could not durably roll back the guest visit.");
    }
  }, [noteStorageFailure, storage]);

  const reconcileLocationClaimRequired = useCallback(async (
    identity: Identity,
    visitBox: VisitOutbox,
    placeId: string,
    attemptRevision: number,
  ) => {
    if (sameOwner(identityRef.current, identity)) {
      const nextVisited = new Set(visitedRef.current);
      const nextTimestamps = { ...visitTimestampsRef.current };
      const nextMetadata = { ...visitMetadataRef.current };
      nextVisited.delete(placeId);
      delete nextTimestamps[placeId];
      delete nextMetadata[placeId];
      visitMutationsRef.current.record(placeId, null);
      updateProgress(nextVisited, new Set(trailsRef.current), nextTimestamps, nextMetadata);
      if (identity.kind === "guest") await persistGuest(); else await persistAccount();
      refreshCatalogueAfterProgressChangeRef.current(identity);
    } else if (identity.kind === "guest") {
      // Guest import drains the guest outbox while the account remains the
      // active identity, so persist its rollback from the stored guest state
      // instead of the account's in-memory refs.
      await clearStoredGuestVisit(placeId);
    }
    // Only discard after the local rollback has been persisted. If storage is
    // temporarily unavailable, retaining the entry lets the next drain retry
    // the rollback rather than losing the user's durable intent.
    visitBox.discardRevision(placeId, attemptRevision);
  }, [clearStoredGuestVisit, persistAccount, persistGuest, updateProgress]);

  const hydrateAccountOutboxes = useCallback(async (accountId: string) => {
    if (accountOutboxOwnerRef.current === accountId) return;
    accountVisitOutboxRef.current = new VisitOutbox();
    accountTrailOutboxRef.current = new VisitOutbox();
    const target = storage();
    accountVisitOutboxRef.current.hydrate(await readStored<PendingSnapshot>(target, accountPendingKey(accountId, "visits"), {}));
    accountTrailOutboxRef.current.hydrate(await readStored<PendingSnapshot>(target, accountPendingKey(accountId, "trails"), {}));
    accountOutboxOwnerRef.current = accountId;
  }, [storage]);

  const guestHasProgress = useCallback(async () => {
    const target = storage();
    return (await readStored<string[]>(target, JOURNAL_STORAGE.guestVisited, [])).length > 0
      || (await readStored<string[]>(target, JOURNAL_STORAGE.guestTrails, [])).length > 0
      || hasEntries(guestVisitOutboxRef.current)
      || hasEntries(guestTrailOutboxRef.current);
  }, [storage]);

  const guestWasImportedBy = useCallback(async (accountId: string) => {
    const target = storage();
    const currentRevision = await readStored<number>(target, JOURNAL_STORAGE.guestRevision, 0);
    return await readStored<number>(target, importedGuestKey(accountId), -1) === currentRevision;
  }, [storage]);

  const switchToGuest = useCallback(async (message = "", options: SwitchToGuestOptions = {}) => {
    const bestEffort = options.bestEffort === true;
    let cleanupSucceeded = true;
    epochRef.current.advance();
    visitMutationsRef.current.reset();
    if (options.clearRestoredCamera !== false) {
      try {
        await clearRestoredCameraPhoto();
      } catch (error) {
        cleanupSucceeded = false;
        if (!bestEffort) throw error;
        noteStorageFailure(false);
      }
    }
    const target = storage();
    const remove = async (key: string) => {
      const success = await removeStored(target, key);
      noteStorageFailure(success);
      if (!success) {
        cleanupSucceeded = false;
      }
    };
    await remove(ACCOUNT_TOKEN_KEY);
    await remove(JOURNAL_STORAGE.accountSnapshot);
    const collectionKey = identityRef.current.kind === "guest"
      ? identityRef.current.collectionKey
      : await readStored<string>(target, JOURNAL_STORAGE.collectionKey, "");
    publishIdentity({ kind: "guest", collectionKey });
    await hydrateCatalogueMetadata(identityRef.current);
    setAuthenticated(false);
    setAccount(null);
    const guestVisited = guestVisitOutboxRef.current.applyTo(await readStored<string[]>(target, JOURNAL_STORAGE.guestVisited, []));
    const guestTrails = guestTrailOutboxRef.current.applyTo(await readStored<string[]>(target, JOURNAL_STORAGE.guestTrails, []));
    const guestVisitTimestamps = await readStored<Record<string, string>>(target, JOURNAL_STORAGE.guestVisitTimestamps, {});
    const storedGuestMetadata = await readStored<Record<string, Visit>>(target, JOURNAL_STORAGE.guestVisitMetadata, {});
    updateProgress(
      guestVisited,
      guestTrails,
      guestVisitTimestamps,
      metadataFor(Object.values(storedGuestMetadata), guestVisited, guestVisitTimestamps),
    );
    setPendingClaims(0);
    setRejectedClaimCount(0);
    setOfflineClaimRecoveryCount(0);
    setOfflineClaimRecoveryMessage("");
    setGuestProgressAvailable(await guestHasProgress());
    if (message) setSyncMessage(message);
    return cleanupSucceeded;
  }, [guestHasProgress, hydrateCatalogueMetadata, noteStorageFailure, publishIdentity, storage, updateProgress]);

  const accountDeletionIntent = useCallback(async (accountId: string): Promise<AccountDeletionIntent> => {
    const target = storage();
    const stored = await readStored<AccountDeletionIntent | null>(target, JOURNAL_STORAGE.accountDeletion, null);
    if (stored?.accountId && stored.accountId !== accountId) {
      throw new Error("Another account deletion is still waiting for local cleanup.");
    }
    const intent = stored?.accountId === accountId && stored.requestId
      ? stored
      : { accountId, requestId: createAccountDeletionRequestId() };
    if (!await writeStored(target, JOURNAL_STORAGE.accountDeletion, intent)) {
      throw new Error("Private device storage could not save the deletion retry.");
    }
    accountDeletionIntentRef.current = intent;
    return intent;
  }, [storage]);

  const clearDeletedAccountLocalState = useCallback(async (accountId: string, options: AccountCleanupOptions = {}) => {
    const target = storage();
    const failures: Error[] = [];
    const attempt = async (label: string, operation: () => boolean | void | Promise<boolean | void>) => {
      try {
        const result = await operation();
        if (result === false) failures.push(new Error(label));
      } catch (error) {
        failures.push(error instanceof Error ? error : new Error(label));
      }
    };

    // Wait for any in-flight account retry before replacing its durable entry.
    // A confirmed marker for account A can be encountered while account B is
    // already cached, so never clear B's in-memory outbox or mutation journal.
    if (options.clearCurrentAccountOutbox !== false) {
      await attempt("Could not cancel pending account visit retries.", () => accountVisitOutboxRef.current.clearAndWait());
      await attempt("Could not cancel pending account trail retries.", () => accountTrailOutboxRef.current.clearAndWait());
    }
    await attempt("Could not clear pending account visit retries.", () => writeStored(target, accountPendingKey(accountId, "visits"), {}));
    await attempt("Could not clear pending account trail retries.", () => writeStored(target, accountPendingKey(accountId, "trails"), {}));
    if (options.clearAccountSnapshot !== false) {
      await attempt("Could not clear the cached account journal.", () => removeStored(target, JOURNAL_STORAGE.accountSnapshot));
    }
    await attempt("Could not clear the imported guest marker.", () => removeStored(target, importedGuestKey(accountId)));
    await attempt("Could not clear saved offline visits.", () => offlineClaimsService.clearOwner(accountId));
    let recoveryStateCleared = false;
    try {
      const ownerKey = `account:${accountId}`;
      if (await hasUnresolvedClaim(ownerKey)) await clearUnresolvedClaims(ownerKey);
      recoveryStateCleared = true;
    } catch (error) {
      failures.push(error instanceof Error ? error : new Error("Could not clear unresolved visit recovery state."));
    }
    if (recoveryStateCleared) await attempt("Private photo storage is busy.", () => clearPhotoRetryOwner(`account:${accountId}`));
    if (options.clearRestoredCamera !== false) {
      await attempt("Recovered camera storage is busy.", () => clearRestoredCameraPhoto());
    }

    if (options.clearCurrentAccountOutbox !== false) {
      accountVisitOutboxRef.current = new VisitOutbox();
      accountTrailOutboxRef.current = new VisitOutbox();
      accountOutboxOwnerRef.current = "";
      visitMutationsRef.current.reset();
    }
    if (failures.length) {
      noteStorageFailure(false);
      throw failures[0];
    }
  }, [noteStorageFailure, offlineClaimsService, storage]);

  const expireAccount = useCallback((capturedEpoch: number) => {
    if (!epochRef.current.isCurrent(capturedEpoch) || identityRef.current.kind !== "account") return;
    const pendingDeletion = accountDeletionIntentRef.current;
    if (pendingDeletion
      && (!identityRef.current.account || identityRef.current.account.id === pendingDeletion.accountId)) {
      setSyncMessage("The server did not confirm account deletion. Retry with the same request to resolve it.");
      return;
    }
    void switchToGuest("Your session expired. Sign in again to continue syncing your account.");
  }, [switchToGuest]);

  const authenticatedRequest = useCallback(async (path: string, init: RequestInit = {}) => {
    const identity = identityRef.current;
    if (identity.kind !== "account") throw new Error("Sign in to manage collections.");
    const capturedEpoch = epochRef.current.capture();
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${identity.token}`);
    const response = await fetch(`${apiBaseUrl}${path}`, { ...init, headers });
    if (response.status === 401) expireAccount(capturedEpoch);
    return response;
  }, [apiBaseUrl, expireAccount]);

  const putProgress = useCallback(async (
    kind: "visits" | "trails",
    id: string,
    enabled: boolean,
    identity: Identity,
    capturedEpoch: number,
  ) => {
    if (!apiBaseUrl) throw new Error("Sync is unavailable while the field guide is offline.");
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (identity.kind === "account") headers.Authorization = `Bearer ${identity.token}`;
    else headers["X-Collection-Key"] = identity.collectionKey;
    const response = await fetch(`${apiBaseUrl}/api/${kind}/${encodeURIComponent(id)}`, {
      method: "PUT",
      headers,
      body: JSON.stringify(kind === "visits" ? { visited: enabled } : { completed: enabled }),
    });
    if (!response.ok) {
      const error = await responseError(response, "Could not sync this checkoff.");
      if (identity.kind === "account" && error.status === 401) expireAccount(capturedEpoch);
      throw error;
    }
    if (kind !== "visits" || !epochRef.current.isCurrent(capturedEpoch) || visitedRef.current.has(id) !== enabled) return;
    const result = await response.json() as { visitedAt?: string | null };
    const nextTimestamps = { ...visitTimestampsRef.current };
    const nextMetadata = { ...visitMetadataRef.current };
    if (enabled && result.visitedAt) {
      nextTimestamps[id] = result.visitedAt;
      nextMetadata[id] = { placeId: id, visitedAt: result.visitedAt };
      visitMutationsRef.current.record(id, nextMetadata[id]);
    }
    if (!enabled) {
      delete nextTimestamps[id];
      delete nextMetadata[id];
      visitMutationsRef.current.record(id, null);
    }
    updateProgress(new Set(visitedRef.current), new Set(trailsRef.current), nextTimestamps, nextMetadata);
  }, [apiBaseUrl, expireAccount, updateProgress]);

  const drainVisit = useCallback(async (
    visitBox: VisitOutbox,
    id: string,
    enabled: boolean,
    identity: Identity,
    capturedEpoch: number,
    attemptRevision: number,
  ) => {
    try {
      await putProgress("visits", id, enabled, identity, capturedEpoch);
    } catch (error) {
      if (!enabled || !isLocationClaimRequired(error)) throw error;
      await reconcileLocationClaimRequired(identity, visitBox, id, attemptRevision);
    }
  }, [putProgress, reconcileLocationClaimRequired]);

  const persistOutbox = useCallback(async (identity: Identity, visitSnapshot: PendingSnapshot, trailSnapshot: PendingSnapshot) => {
    const target = storage();
    let visitWritten = false;
    let trailWritten = false;
    if (identity.kind === "guest") {
      visitWritten = await writeStored(target, JOURNAL_STORAGE.guestVisitPending, visitSnapshot);
      trailWritten = await writeStored(target, JOURNAL_STORAGE.guestTrailPending, trailSnapshot);
    } else if (identity.account) {
      visitWritten = await writeStored(target, accountPendingKey(identity.account.id, "visits"), visitSnapshot);
      trailWritten = await writeStored(target, accountPendingKey(identity.account.id, "trails"), trailSnapshot);
    }
    noteStorageFailure(visitWritten && trailWritten);
    if (!visitWritten || !trailWritten) throw new Error("Could not durably save the pending checkoff.");
  }, [noteStorageFailure, storage]);

  const cancelPendingAccountVisitUndos = useCallback(async (identity: Identity, capturedEpoch: number) => {
    if (identity.kind !== "account" || !identity.account) return;
    const owner = offlineClaimOwner(identity);
    if (!owner) return;
    const visitBox = accountVisitOutboxRef.current;
    const pendingUndos = Object.entries(visitBox.snapshot())
      .filter(([, pending]) => !pending.visited)
      .map(([placeId]) => placeId);
    if (pendingUndos.length === 0) return;

    // The false outbox intent must survive a crash before cancelling the
    // matching offline claim, so retry can finish the cancellation first.
    await persistOutbox(identity, visitBox.snapshot(), accountTrailOutboxRef.current.snapshot());
    for (const placeId of pendingUndos) {
      if (!mountedRef.current || !epochRef.current.isCurrent(capturedEpoch) || !sameOwner(identityRef.current, identity)) {
        throw new Error("Your account changed before saved offline visits could be cancelled.");
      }
      await offlineClaimsService.cancelPlace(owner, placeId);
      await clearUnresolvedClaim(`account:${owner.accountId}`, placeId);
    }
  }, [offlineClaimsService, persistOutbox]);

  const drainIdentity = useCallback(async (identity: Identity, capturedEpoch: number) => {
    const visitBox = identity.kind === "guest" ? guestVisitOutboxRef.current : accountVisitOutboxRef.current;
    const trailBox = identity.kind === "guest" ? guestTrailOutboxRef.current : accountTrailOutboxRef.current;
    try {
      await persistOutbox(identity, visitBox.snapshot(), trailBox.snapshot());
      await cancelPendingAccountVisitUndos(identity, capturedEpoch);
      if (identity.kind === "guest") await persistGuest(); else await persistAccount();
      const results = await Promise.allSettled([
        visitBox.drainAll((id, enabled, revision) => drainVisit(visitBox, id, enabled, identity, capturedEpoch, revision)),
        trailBox.drainAll((id, enabled) => putProgress("trails", id, enabled, identity, capturedEpoch)),
      ]);
      if (results.some((result) => result.status === "rejected")) throw new Error("Some checkoffs did not sync.");
    } finally {
      await persistOutbox(identity, visitBox.snapshot(), trailBox.snapshot());
    }
  }, [cancelPendingAccountVisitUndos, drainVisit, persistAccount, persistGuest, persistOutbox, putProgress]);

  const refreshOfflineClaimState = useCallback(async (identity: Identity, capturedEpoch: number): Promise<OfflineClaimQueueItem[]> => {
    const owner = offlineClaimOwner(identity);
    if (!owner) return [];
    const service = offlineClaimsService;
    try {
      const items = await service.list(owner);
      if (!mountedRef.current || !epochRef.current.isCurrent(capturedEpoch) || !sameOwner(identityRef.current, identity)) return [];
      const queued = items.filter((item) => item.state === "pending");
      const rejected = items.filter((item) => item.state === "rejected");
      const recovery = items.filter((item) => item.state !== "pending");
      setPendingClaims(queued.length);
      setRejectedClaimCount(rejected.length);
      setOfflineClaimRecoveryCount(recovery.length);
      setOfflineClaimRecoveryMessage(recovery.find((item) => item.lastError)?.lastError
        ?? (recovery.length ? "Some saved offline visits need attention before they can finish syncing." : ""));
      return items;
    } catch (error) {
      if (mountedRef.current && epochRef.current.isCurrent(capturedEpoch) && sameOwner(identityRef.current, identity)) {
        setOfflineClaimRecoveryMessage(error instanceof Error
          ? error.message
          : "Could not read saved offline visits from this device.");
      }
      throw error;
    }
  }, [offlineClaimsService]);

  const syncOfflineClaims = useCallback(async (identity: Identity, capturedEpoch: number, provision = true) => {
    const owner = offlineClaimOwner(identity);
    if (!owner) return;
    const existing = offlineClaimsTaskRef.current;
    if (existing?.accountId === owner.accountId) return existing.promise;
      const service = offlineClaimsService;
      const isCurrent = () => mountedRef.current
        && epochRef.current.isCurrent(capturedEpoch)
        && sameOwner(identityRef.current, identity);
    const operation = (async () => {
      let queueBeforeDrain: OfflineClaimQueueItem[] = [];
      try {
        await cancelPendingAccountVisitUndos(identity, capturedEpoch);
        queueBeforeDrain = await refreshOfflineClaimState(identity, capturedEpoch);
        if (!isCurrent() || !apiBaseUrl || !browserIsOnline() || !browserIsForeground()) return;
        const mutationCheckpoint = visitMutationsRef.current.checkpoint();
        const result = await service.drain(owner);
        if (!isCurrent()) return;
        const confirmedByPlace = new Map<string, Visit>();
        const pendingUndos = new Set(Object.entries(accountVisitOutboxRef.current.snapshot())
          .filter(([, pending]) => !pending.visited)
          .map(([placeId]) => placeId));
        for (const confirmation of result.confirmed) {
          if (confirmation.pendingSync || confirmation.visited !== true || !confirmation.placeId
            || pendingUndos.has(confirmation.placeId) || visitMutationsRef.current.isRemoved(confirmation.placeId)) continue;
          confirmedByPlace.set(confirmation.placeId, {
            placeId: confirmation.placeId,
            visitedAt: confirmation.visitedAt,
            claim: confirmation.claim,
          });
        }
        const uploadedPlaceIds = new Set(result.photos.filter((photo) => photo.status === "uploaded").map((photo) => photo.placeId));
        if (confirmedByPlace.size || uploadedPlaceIds.size) {
          const nextVisited = new Set(visitedRef.current);
          const nextTimestamps = { ...visitTimestampsRef.current };
          const nextMetadata = { ...visitMetadataRef.current };
          for (const [placeId, visit] of confirmedByPlace) {
            nextVisited.add(placeId);
            nextTimestamps[placeId] = visit.visitedAt;
            nextMetadata[placeId] = visit;
          }
          const rebased = visitMutationsRef.current.rebase(
            nextVisited,
            nextTimestamps,
            nextMetadata,
            mutationCheckpoint,
          );
          for (const [placeId, visit] of confirmedByPlace) {
            if (!rebased.visited.has(placeId)) continue;
            rebased.timestamps[placeId] = visit.visitedAt;
            rebased.metadata[placeId] = visit;
          }
          for (const placeId of uploadedPlaceIds) {
            const current = rebased.metadata[placeId];
            if (!rebased.visited.has(placeId) || !current?.claim) continue;
            const visit: Visit = { ...current, claim: { ...current.claim, hasPhoto: true } };
            rebased.metadata[placeId] = visit;
            confirmedByPlace.set(placeId, visit);
          }
          for (const placeId of confirmedByPlace.keys()) {
            if (rebased.visited.has(placeId) && rebased.metadata[placeId]) {
              visitMutationsRef.current.record(placeId, rebased.metadata[placeId]);
            }
          }
          updateProgress(rebased.visited, new Set(trailsRef.current), rebased.timestamps, rebased.metadata);
          await persistAccount();
          if (!isCurrent()) return;
          refreshCatalogueAfterProgressChangeRef.current(identity);
        }
        const queueAfterDrain = await refreshOfflineClaimState(identity, capturedEpoch);
        if (provision && offlineClaimsAvailable) {
          try {
            await service.ensureGrant(owner);
          } catch (error) {
            if (isCurrent() && error instanceof ApiError && error.status === 401) expireAccount(capturedEpoch);
            else if (isCurrent() && queueAfterDrain.every((item) => item.state === "pending")) {
              setOfflineClaimRecoveryMessage("Offline visit saving could not be prepared. Stay online and retry before leaving coverage.");
            }
            if (queueBeforeDrain.length === 0 && queueAfterDrain.length === 0) throw error;
          }
        }
      } catch (error) {
        if (isCurrent() && error instanceof ApiError && error.status === 401) expireAccount(capturedEpoch);
        else if (isCurrent()) setOfflineClaimRecoveryMessage(error instanceof Error
          ? error.message
          : "Offline visits are saved on this device and waiting to sync.");
        throw error;
      }
    })();
    const task = { accountId: owner.accountId, promise: operation };
    offlineClaimsTaskRef.current = task;
    try {
      await operation;
    } finally {
      if (offlineClaimsTaskRef.current === task) offlineClaimsTaskRef.current = null;
    }
  }, [apiBaseUrl, cancelPendingAccountVisitUndos, expireAccount, offlineClaimsAvailable, offlineClaimsService, persistAccount, refreshOfflineClaimState, updateProgress]);

  const finishProgressResetCleanup = useCallback(async (accountId: string) => {
    await offlineClaimsService.clearOwner(accountId);
    const ownerKey = `account:${accountId}`;
    if (await hasUnresolvedClaim(ownerKey)) await clearUnresolvedClaims(ownerKey);
    const cleanup = await Promise.allSettled([
      clearPhotoRetryOwner(`account:${accountId}`),
      clearRestoredCameraPhoto(),
    ]);
    const failed = cleanup.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
    if (!await removeStored(storage(), JOURNAL_STORAGE.accountProgressResetCleanup)) {
      throw new Error("Could not clear the progress-reset cleanup marker.");
    }
    pendingProgressResetCleanupRef.current = "";
  }, [offlineClaimsService, storage]);

  const finishLogoutCleanup = useCallback(async (accountId: string) => {
    await offlineClaimsService.clearOwner(accountId);
    if (!await removeStored(storage(), JOURNAL_STORAGE.accountLogoutCleanup)) {
      throw new Error("Could not clear the sign-out cleanup marker.");
    }
    pendingLogoutCleanupRef.current = "";
  }, [offlineClaimsService, storage]);

  const retrySync = useCallback(async () => {
    if (transitionRef.current) return;
    const identity = identityRef.current;
    let resetCleanup: { accountId: string } | null = null;
    let logoutCleanup: { accountId: string } | null = null;
    try {
      resetCleanup = await readStored<{ accountId: string } | null>(storage(), JOURNAL_STORAGE.accountProgressResetCleanup, null);
      logoutCleanup = await readStored<{ accountId: string } | null>(storage(), JOURNAL_STORAGE.accountLogoutCleanup, null);
    } catch (error) {
      setSyncMessage(error instanceof Error ? error.message : "Could not read pending account cleanup from this device.");
      return;
    }
    const resetCleanupOwner = resetCleanup?.accountId ?? pendingProgressResetCleanupRef.current;
    if (resetCleanupOwner) {
      try {
        await finishProgressResetCleanup(resetCleanupOwner);
      } catch (error) {
        setSyncMessage(error instanceof Error
          ? `Your progress is reset, but private device cleanup still needs a retry: ${error.message}`
          : "Your progress is reset, but private device cleanup still needs a retry.");
        return;
      }
    }
    const logoutCleanupOwner = logoutCleanup?.accountId ?? pendingLogoutCleanupRef.current;
    if (logoutCleanupOwner) {
      try {
        await finishLogoutCleanup(logoutCleanupOwner);
      } catch (error) {
        setSyncMessage(error instanceof Error
          ? `You are signed out, but private offline visit cleanup still needs a retry: ${error.message}`
          : "You are signed out, but private offline visit cleanup still needs a retry.");
        return;
      }
    }
    if (identity.kind === "guest" && !identity.collectionKey) return;
    const visitBox = identity.kind === "guest" ? guestVisitOutboxRef.current : accountVisitOutboxRef.current;
    const trailBox = identity.kind === "guest" ? guestTrailOutboxRef.current : accountTrailOutboxRef.current;
    const hasPendingCheckoffs = visitBox.hasPending() || trailBox.hasPending();
    const hasGuestRevision = guestRevisionPendingRef.current;
    if (!hasPendingCheckoffs && !hasGuestRevision && identity.kind !== "account") return;
    const capturedEpoch = epochRef.current.capture();
    if (hasPendingCheckoffs || hasGuestRevision) {
      setSyncMessage("Syncing your latest checkoffs…");
      try {
        if (guestRevisionPendingRef.current) {
          const target = storage();
          const revision = await readStored<number>(target, JOURNAL_STORAGE.guestRevision, 0) + 1;
          if (!await writeStored(target, JOURNAL_STORAGE.guestRevision, revision)) throw new Error("Could not save the guest revision.");
          guestRevisionPendingRef.current = false;
          setGuestProgressAvailable(true);
        }
        if (hasPendingCheckoffs) await drainIdentity(identity, capturedEpoch);
        if (epochRef.current.isCurrent(capturedEpoch)) setSyncMessage("");
      } catch (error) {
        if (!(error instanceof ApiError && error.status === 401)) {
          setSyncMessage(guestRevisionPendingRef.current
            ? "Your guest photo change is saved and waiting for private storage before account import."
            : identity.kind === "account"
            ? "Your account checkoffs are saved on this device and waiting to sync."
            : "Your guest checkoffs are saved on this device and waiting to sync.");
        }
      }
    }
    if (identity.kind === "account") await syncOfflineClaims(identity, capturedEpoch).catch(() => undefined);
  }, [drainIdentity, finishLogoutCleanup, finishProgressResetCleanup, storage, syncOfflineClaims]);

  const retryPendingClaims = useCallback(async () => {
    const identity = identityRef.current;
    if (identity.kind !== "account" || !identity.account) throw new Error("Sign in to retry offline visits.");
    if (transitionRef.current) throw new Error("Another account change is still in progress.");
    const capturedEpoch = epochRef.current.capture();
    try {
      await syncOfflineClaims(identity, capturedEpoch, true);
    } catch {
      // Inspect durable state below. A per-item rejection or a failed grant
      // refresh can be reported as a completed drain by the service.
    }
    if (!mountedRef.current || !epochRef.current.isCurrent(capturedEpoch) || !sameOwner(identityRef.current, identity)) {
      throw new Error("Your account changed before offline visits finished syncing. Refresh your journal and try again.");
    }
    const remaining = await refreshOfflineClaimState(identity, capturedEpoch);
    if (!mountedRef.current || !epochRef.current.isCurrent(capturedEpoch) || !sameOwner(identityRef.current, identity)) {
      throw new Error("Your account changed before offline visits finished syncing. Refresh your journal and try again.");
    }
    if (remaining.length) {
      const recovery = remaining.find((item) => item.state !== "pending");
      const message = recovery?.lastError
        ?? (recovery
          ? "Some saved offline visits need attention before they can finish syncing."
          : !browserIsOnline()
            ? "Saved offline visits are waiting for a connection. Retry when you are back online."
            : "Saved offline visits are still waiting for server confirmation. Retry syncing in a moment.");
      if (recovery && mountedRef.current && epochRef.current.isCurrent(capturedEpoch)) setOfflineClaimRecoveryMessage(message);
      throw new Error(message);
    }
  }, [refreshOfflineClaimState, syncOfflineClaims]);

  const discardRejectedClaims = useCallback(async () => {
    const identity = identityRef.current;
    if (identity.kind !== "account" || !identity.account) throw new Error("Sign in to manage saved offline visits.");
    if (transitionRef.current) throw new Error("Another account change is still in progress.");
    const owner = offlineClaimOwner(identity);
    if (!owner) throw new Error("Sign in to manage saved offline visits.");
    const capturedEpoch = epochRef.current.capture();
    const removed = await offlineClaimsService.discardRejected(owner);
    if (!mountedRef.current || !epochRef.current.isCurrent(capturedEpoch) || !sameOwner(identityRef.current, identity)) {
      throw new Error("Your account changed before rejected offline visits were cleared.");
    }
    await refreshOfflineClaimState(identity, capturedEpoch);
    if (!mountedRef.current || !epochRef.current.isCurrent(capturedEpoch) || !sameOwner(identityRef.current, identity)) {
      throw new Error("Your account changed before rejected offline visits were cleared.");
    }
    return removed;
  }, [offlineClaimsService, refreshOfflineClaimState]);

  const refreshCatalogue = useCallback(async (
    isActive: () => boolean = () => mountedRef.current,
    refreshProgress = true,
  ) => {
    const identity = identityRef.current;
    if (!apiBaseUrl || (identity.kind === "guest" && !identity.collectionKey)) return false;
    const catalogueEpoch = epochRef.current.capture();
    const requestSequence = ++catalogueStateSequenceRef.current;
    const visitBox = identity.kind === "guest" ? guestVisitOutboxRef.current : accountVisitOutboxRef.current;
    const trailBox = identity.kind === "guest" ? guestTrailOutboxRef.current : accountTrailOutboxRef.current;
    const visitCheckpoint = visitBox.checkpoint();
    const trailCheckpoint = trailBox.checkpoint();
    const visitMutationCheckpoint = visitMutationsRef.current.checkpoint();
    const headers = catalogueContextFor(identity).headers;
    try {
      const response = await fetch(`${apiBaseUrl}/api/catalogue/state`, { cache: "no-store", headers });
      if (!response.ok) throw await responseError(response, "Could not load the field guide.");
      const payload = await response.json() as CataloguePayload;
      if (!isActive() || !epochRef.current.isCurrent(catalogueEpoch)
        || requestSequence !== catalogueStateSequenceRef.current
        || !sameOwner(identityRef.current, identity)) return false;
      const nextCategoryTotals = normalizeCategoryTotals(payload.categoryTotals);
      const nextVisitedCategoryTotals = normalizeCategoryTotals(payload.visitedCategoryTotals);
      const metadataSnapshot: CatalogueMetadataSnapshot = {
        total: Number.isFinite(payload.total) ? payload.total : 0,
        categoryTotals: nextCategoryTotals,
        visitedCategoryTotals: nextVisitedCategoryTotals,
        coverageNote: typeof payload.coverageNote === "string" ? payload.coverageNote : "",
        badges: Array.isArray(payload.badges) ? payload.badges : [],
      };
      setTotal(metadataSnapshot.total);
      setCategoryTotals(nextCategoryTotals);
      setVisitedCategoryTotals(nextVisitedCategoryTotals);
      setBadges(metadataSnapshot.badges);
      setCoverageNote(metadataSnapshot.coverageNote);
      setVisitClaimMode(visitClaimModeFor(payload));
      setOfflineClaimsAvailable(payload.visitClaims?.offlineSupported === true);
      noteStorageFailure(await writeStored(storage(), "parkdex:claim-capability:v1", {
        apiBaseUrl, mode: visitClaimModeFor(payload), offlineSupported: payload.visitClaims?.offlineSupported === true,
      }));
      noteStorageFailure(await writeStored(storage(), catalogueStateStorageKey(identity), metadataSnapshot));
      if (refreshProgress) {
        const snapshotVisited = visitBox.applyTo(payload.visitedIds, visitCheckpoint);
        const nextTrails = trailBox.applyTo(payload.completedTrailIds ?? [], trailCheckpoint);
        const payloadTimestamps = timestampsFor(payload.visits);
        const rebasedVisits = visitMutationsRef.current.rebase(
          snapshotVisited,
          payloadTimestamps,
          metadataFor(payload.visits, snapshotVisited, payloadTimestamps),
          visitMutationCheckpoint,
        );
        updateProgress(rebasedVisits.visited, nextTrails, rebasedVisits.timestamps, rebasedVisits.metadata);
        if (identity.kind === "guest") await persistGuest(); else await persistAccount();
      }
      if (isActive() && epochRef.current.isCurrent(catalogueEpoch) && sameOwner(identityRef.current, identity)) {
        catalogueReadyRef.current = true;
        catalogueNeedsRecoveryRef.current = false;
        setLoadError("");
      }
      return true;
    } catch (error) {
      if (!isActive() || !epochRef.current.isCurrent(catalogueEpoch) || !sameOwner(identityRef.current, identity)) return false;
      if (identity.kind === "account" && error instanceof ApiError && error.status === 401) {
        catalogueNeedsRecoveryRef.current = false;
        expireAccount(catalogueEpoch);
        return false;
      }
      catalogueNeedsRecoveryRef.current = retryableCatalogueFailure(error);
      throw error;
    }
  }, [apiBaseUrl, expireAccount, noteStorageFailure, persistAccount, persistGuest, storage, updateProgress]);

  const runBackgroundCatalogueRecovery = useCallback((isActive: () => boolean = () => mountedRef.current) => {
    const requestEpoch = epochRef.current.capture();
    const existing = catalogueBackgroundRequestRef.current;
    if (existing?.epoch === requestEpoch) return existing.promise;
    const promise = refreshCatalogue(isActive).finally(() => {
      if (catalogueBackgroundRequestRef.current?.promise === promise) catalogueBackgroundRequestRef.current = null;
    });
    catalogueBackgroundRequestRef.current = { epoch: requestEpoch, promise };
    return promise;
  }, [refreshCatalogue]);

  const retryCatalogue = useCallback(async () => {
    if (!apiBaseUrl || !mountedRef.current || transitionRef.current) return false;
    try {
      return await runBackgroundCatalogueRecovery();
    } catch (error) {
      if (mountedRef.current) {
        setLoadError(placesRef.current.length
          ? "Showing your saved field guide offline."
          : error instanceof Error ? error.message : "Could not load the field guide.");
      }
      return false;
    }
  }, [apiBaseUrl, runBackgroundCatalogueRecovery]);

  const refreshCatalogueAfterProgressChange = useCallback((identity: Identity) => {
    if (!apiBaseUrl || !browserIsOnline() || !mountedRef.current || !sameOwner(identityRef.current, identity)) return;
    void refreshCatalogue(() => mountedRef.current, false).catch((error) => {
      if (!mountedRef.current || !sameOwner(identityRef.current, identity)) return;
      setLoadError(placesRef.current.length
        ? "Showing your saved field guide offline."
        : error instanceof Error ? error.message : "Could not load the field guide.");
    });
  }, [apiBaseUrl, refreshCatalogue]);

  useEffect(() => {
    refreshCatalogueAfterProgressChangeRef.current = refreshCatalogueAfterProgressChange;
  }, [refreshCatalogueAfterProgressChange]);

  useEffect(() => {
    let active = true;
    const epoch = epochRef.current;
    void (async () => {
      let target: KeyValueStore;
      try {
        target = await getPlatformStorage();
      } catch {
        if (!active) return;
        setStorageUnavailable(true);
        setLoadError("Secure device storage is unavailable. Restart the app to try again.");
        setLoading(false);
        hydrationReady.resolve();
        return;
      }
      if (!active) return;
      storageRef.current = target;
      const savedCapability = await readStored<{ apiBaseUrl: string; mode: VisitClaimMode; offlineSupported: boolean } | null>(target, "parkdex:claim-capability:v1", null);
      if (savedCapability?.apiBaseUrl === apiBaseUrl && savedCapability.offlineSupported
        && (savedCapability.mode === "compatible" || savedCapability.mode === "required")) {
        setVisitClaimMode(savedCapability.mode);
        setOfflineClaimsAvailable(true);
      }
      guestVisitOutboxRef.current = new VisitOutbox();
      guestTrailOutboxRef.current = new VisitOutbox();
      guestVisitOutboxRef.current.hydrate(await readStored<PendingSnapshot>(target, JOURNAL_STORAGE.guestVisitPending, {}));
      guestTrailOutboxRef.current.hydrate(await readStored<PendingSnapshot>(target, JOURNAL_STORAGE.guestTrailPending, {}));

      let collectionKey = await readStored<string>(target, JOURNAL_STORAGE.collectionKey, "");
      if (!collectionKey) {
        collectionKey = createCollectionKey();
        if (!await writeRawStored(target, JOURNAL_STORAGE.collectionKey, collectionKey)) throw new Error("Could not save the guest collection credential.");
      }
      const guestVisited = guestVisitOutboxRef.current.applyTo(await readStored<string[]>(target, JOURNAL_STORAGE.guestVisited, []));
      const guestTrails = guestTrailOutboxRef.current.applyTo(await readStored<string[]>(target, JOURNAL_STORAGE.guestTrails, []));
      const guestVisitTimestamps = await readStored<Record<string, string>>(target, JOURNAL_STORAGE.guestVisitTimestamps, {});
      const storedGuestMetadata = await readStored<Record<string, Visit>>(target, JOURNAL_STORAGE.guestVisitMetadata, {});
      const guestVisitMetadata = metadataFor(Object.values(storedGuestMetadata), guestVisited, guestVisitTimestamps);
      const legacyPlacesValue = await readStored<Place[]>(target, JOURNAL_STORAGE.places, []);
      const legacyPlaces = Array.isArray(legacyPlacesValue) ? legacyPlacesValue : [];

      let savedToken = await target.getItem(ACCOUNT_TOKEN_KEY) ?? "";
      const cachedAccount = await readStored<AccountSnapshot | null>(target, JOURNAL_STORAGE.accountSnapshot, null);
      const pendingDeletion = await readStored<AccountDeletionIntent | null>(target, JOURNAL_STORAGE.accountDeletion, null);
      accountDeletionIntentRef.current = pendingDeletion;
      const ownsPendingDeletionSession = Boolean(pendingDeletion?.confirmed
        && (!cachedAccount || cachedAccount.account.id === pendingDeletion.accountId));
      if (pendingDeletion?.confirmed) {
        try {
          await clearDeletedAccountLocalState(pendingDeletion.accountId, {
            clearAccountSnapshot: ownsPendingDeletionSession,
            clearCurrentAccountOutbox: ownsPendingDeletionSession,
            clearRestoredCamera: ownsPendingDeletionSession,
          });
          if (ownsPendingDeletionSession) {
            noteStorageFailure(await removeStored(target, ACCOUNT_TOKEN_KEY));
            savedToken = "";
          }
          const markerRemoved = await removeStored(target, JOURNAL_STORAGE.accountDeletion);
          noteStorageFailure(markerRemoved);
          if (markerRemoved) accountDeletionIntentRef.current = null;
        } catch {
          // Keep the confirmed marker so the next launch can retry cleanup;
          // invalidate this owner's cached session when it is still active.
          if (ownsPendingDeletionSession) savedToken = "";
        }
      }
      let bootDeletionOutcomeUnresolved = false;
      if (apiBaseUrl && savedToken && cachedAccount?.account.id === pendingDeletion?.accountId
        && pendingDeletion && !pendingDeletion.confirmed && !accountDeletionBootReplayRef.current) {
        accountDeletionBootReplayRef.current = true;
        try {
          const deletion = await deleteAccountRequest(apiBaseUrl, savedToken, pendingDeletion.requestId);
          const confirmedIntent: AccountDeletionIntent = {
            ...pendingDeletion,
            confirmed: true,
            photoCleanupPending: deletion.photoCleanupPending,
          };
          if (!await writeStored(target, JOURNAL_STORAGE.accountDeletion, confirmedIntent)) {
            noteStorageFailure(false);
            bootDeletionOutcomeUnresolved = true;
          } else {
            accountDeletionIntentRef.current = confirmedIntent;
            let cleanupPending = false;
            try {
              await clearDeletedAccountLocalState(pendingDeletion.accountId);
            } catch {
              cleanupPending = true;
            }
            noteStorageFailure(await removeStored(target, ACCOUNT_TOKEN_KEY));
            savedToken = "";
            if (!cleanupPending) {
              const markerRemoved = await removeStored(target, JOURNAL_STORAGE.accountDeletion);
              noteStorageFailure(markerRemoved);
              if (markerRemoved) accountDeletionIntentRef.current = null;
            }
          }
        } catch {
          bootDeletionOutcomeUnresolved = true;
        }
      }
      let initialVisited = guestVisited;
      let initialTrails = guestTrails;
      let initialVisitTimestamps = guestVisitTimestamps;
      let initialVisitMetadata = guestVisitMetadata;
      if (savedToken) {
        publishIdentity({ kind: "account", token: savedToken, account: cachedAccount?.account ?? null });
        if (cachedAccount) {
          await hydrateAccountOutboxes(cachedAccount.account.id);
          initialVisited = accountVisitOutboxRef.current.applyTo(cachedAccount.visitedIds);
          initialTrails = accountTrailOutboxRef.current.applyTo(cachedAccount.completedTrailIds);
          initialVisitTimestamps = cachedAccount.visitTimestamps ?? {};
          initialVisitMetadata = metadataFor(cachedAccount.visits, initialVisited, initialVisitTimestamps);
        } else {
          initialVisited = new Set();
          initialTrails = new Set();
          initialVisitTimestamps = {};
          initialVisitMetadata = {};
        }
      } else {
        publishIdentity({ kind: "guest", collectionKey });
      }

      const cachedPlaces = legacyPlaceSample(legacyPlaces, initialVisited, initialVisitTimestamps);
      // Preserve the legacy storage key for older app code, but migrate its
      // unbounded catalogue value to a small, compact offline fallback.
      noteStorageFailure(await writeStored(target, JOURNAL_STORAGE.places, cachedPlaces));
      if (cachedPlaces.length) updatePlaces(cachedPlaces);
      await hydrateCatalogueMetadata(identityRef.current);
      setAuthenticated(Boolean(savedToken));
      setAccount(savedToken ? cachedAccount?.account ?? null : null);
      updateProgress(initialVisited, initialTrails, initialVisitTimestamps, initialVisitMetadata);
      setGuestProgressAvailable(await guestHasProgress() && (!cachedAccount || !await guestWasImportedBy(cachedAccount.account.id)));
      hydrationReady.resolve();
      if (!apiBaseUrl) {
        setLoadError(cachedPlaces.length ? "Showing your saved field guide offline." : "The field guide API is not configured.");
        setLoading(false);
        return;
      }

      if (savedToken) {
        const accountEpoch = epochRef.current.capture();
        const accountVisitMutationCheckpoint = visitMutationsRef.current.checkpoint();
        try {
          const session = await loadAccount(apiBaseUrl, savedToken);
          if (!active || !epochRef.current.isCurrent(accountEpoch)) return;
           await hydrateAccountOutboxes(session.account.id);
           publishIdentity({ kind: "account", token: savedToken, account: session.account });
           setAccount(session.account);
           setGuestProgressAvailable(await guestHasProgress() && !await guestWasImportedBy(session.account.id));
           const sessionTimestamps = timestampsFor(session.visits);
           const sessionVisited = accountVisitOutboxRef.current.applyTo(session.visitedIds);
           const rebasedVisits = visitMutationsRef.current.rebase(
             sessionVisited,
             sessionTimestamps,
             metadataFor(session.visits, sessionVisited, sessionTimestamps),
             accountVisitMutationCheckpoint,
           );
          updateProgress(
            rebasedVisits.visited,
            accountTrailOutboxRef.current.applyTo(session.completedTrailIds),
            rebasedVisits.timestamps,
            rebasedVisits.metadata,
          );
          await persistAccount();
        } catch (error) {
          if (!active || !epochRef.current.isCurrent(accountEpoch)) return;
          const deletionOutcomeUnresolved = Boolean(pendingDeletion
            && (!cachedAccount || cachedAccount.account.id === pendingDeletion.accountId));
          if (error instanceof ApiError && error.status === 401 && !deletionOutcomeUnresolved) {
            savedToken = "";
            await switchToGuest("Your session expired. Sign in again to continue syncing your account.");
          } else if (deletionOutcomeUnresolved) {
            setLoadError("Your account deletion outcome is unresolved. Reopen account deletion to retry it safely.");
          } else {
            setLoadError(cachedPlaces.length ? "Showing your saved account journal offline." : "Your account is offline. We’ll reconnect without switching collections.");
          }
        }
      }

      try {
        await refreshCatalogue(() => active);
      } catch {
        if (!active) return;
        setLoadError(cachedPlaces.length ? "Showing your saved field guide offline." : "Could not load the field guide. Check your connection and try again.");
      } finally {
        if (active) {
          if (bootDeletionOutcomeUnresolved) {
            setLoadError("Your account deletion outcome is unresolved. Reopen account deletion to retry it safely.");
          }
          setLoading(false);
        }
      }
    })().catch(() => {
      if (!active) return;
      setStorageUnavailable(true);
      setLoadError("Secure device storage is unavailable. Restart the app to try again.");
      setLoading(false);
      hydrationReady.resolve();
    });

    return () => { active = false; epoch.advance(); };
  }, [apiBaseUrl, clearDeletedAccountLocalState, guestHasProgress, guestWasImportedBy, hydrateAccountOutboxes, hydrateCatalogueMetadata, hydrationReady, noteStorageFailure, persistAccount, publishIdentity, refreshCatalogue, storage, switchToGuest, updatePlaces, updateProgress]);

  useEffect(() => {
    if (loading) return;
    let active = true;
    queueMicrotask(() => { if (active) void retrySync(); });
    return () => { active = false; };
  }, [account?.id, authenticated, loading, retrySync]);

  useEffect(() => {
    const resume = () => {
      if (browserIsForeground()) void retrySync();
    };
    window.addEventListener("online", resume);
    document.addEventListener("visibilitychange", resume);
    window.addEventListener(NATIVE_APP_STATE_EVENT, resume);
    return () => {
      window.removeEventListener("online", resume);
      document.removeEventListener("visibilitychange", resume);
      window.removeEventListener(NATIVE_APP_STATE_EVENT, resume);
    };
  }, [retrySync]);

  useEffect(() => {
    if (loading) return;
    const recover = () => {
      if (!browserIsForeground()) return;
      if (catalogueReadyRef.current && !catalogueNeedsRecoveryRef.current) return;
      void runBackgroundCatalogueRecovery().catch((error) => {
        if (!mountedRef.current) return;
        setLoadError(placesRef.current.length ? "Showing your saved field guide offline." : error instanceof Error ? error.message : "Could not load the field guide.");
      });
    };
    window.addEventListener("online", recover);
    document.addEventListener("visibilitychange", recover);
    window.addEventListener(NATIVE_APP_STATE_EVENT, recover);
    return () => {
      window.removeEventListener("online", recover);
      document.removeEventListener("visibilitychange", recover);
      window.removeEventListener(NATIVE_APP_STATE_EVENT, recover);
    };
  }, [loading, runBackgroundCatalogueRecovery]);

  const toggle = useCallback(async (kind: "visits" | "trails", id: string) => {
    if (transitionRef.current) return;
    const identity = identityRef.current;
    if (identity.kind === "guest" && !identity.collectionKey) return;
    const current = kind === "visits" ? visitedRef.current : trailsRef.current;
    const { next, enabled } = toggledSet(current, id);
    if (kind === "visits") {
      const nextTimestamps = { ...visitTimestampsRef.current };
      const nextMetadata = { ...visitMetadataRef.current };
      if (!enabled) {
        // A local removal must hide claim/photo details immediately and make
        // that cleanup durable before an offline restart can render a stale
        // claimed postcard.
        delete nextTimestamps[id];
        delete nextMetadata[id];
        visitMutationsRef.current.record(id, null);
      }
      updateProgress(next, new Set(trailsRef.current), nextTimestamps, nextMetadata);
    } else updateProgress(new Set(visitedRef.current), next);
    const visitBox = identity.kind === "guest" ? guestVisitOutboxRef.current : accountVisitOutboxRef.current;
    const trailBox = identity.kind === "guest" ? guestTrailOutboxRef.current : accountTrailOutboxRef.current;
    const outbox = kind === "visits" ? visitBox : trailBox;
    outbox.setDesired(id, enabled);
    try {
      if (identity.kind === "guest") {
        guestRevisionPendingRef.current = true;
        const target = storage();
        const revision = await readStored<number>(target, JOURNAL_STORAGE.guestRevision, 0) + 1;
        if (!noteStorageFailure(await writeStored(target, JOURNAL_STORAGE.guestRevision, revision))) throw new Error("Could not save the guest revision.");
        guestRevisionPendingRef.current = false;
        setGuestProgressAvailable(true);
      }
      await persistOutbox(identity, visitBox.snapshot(), trailBox.snapshot());
      if (identity.kind === "guest") await persistGuest(); else await persistAccount();
    } catch {
      noteStorageFailure(false);
      setSyncMessage("Private device storage could not save this checkoff. Try again before leaving this page.");
      return;
    }
    setSyncMessage("");
    const capturedEpoch = epochRef.current.capture();
    try {
      if (kind === "visits" && !enabled) await cancelPendingAccountVisitUndos(identity, capturedEpoch);
      await outbox.drain(id, (pendingId, pendingValue, revision) => kind === "visits"
        ? drainVisit(visitBox, pendingId, pendingValue, identity, capturedEpoch, revision)
        : putProgress(kind, pendingId, pendingValue, identity, capturedEpoch));
      if (kind === "visits") refreshCatalogueAfterProgressChange(identity);
    } catch (error) {
      if (kind === "visits" && enabled && isLocationClaimRequired(error)) {
        setSyncMessage("This park now requires location confirmation. Use “Confirm this visit” while you’re there.");
      } else if (!(error instanceof ApiError && error.status === 401)) {
        setSyncMessage(identity.kind === "account"
          ? "Your account checkoff is saved on this device and waiting to sync."
          : "Your guest checkoff is saved on this device and waiting to sync.");
      }
    } finally {
      try { await persistOutbox(identity, visitBox.snapshot(), trailBox.snapshot()); }
      catch { setSyncMessage("Private device storage could not save this checkoff. Try again before leaving this page."); }
    }
  }, [cancelPendingAccountVisitUndos, drainVisit, noteStorageFailure, persistAccount, persistGuest, persistOutbox, putProgress, refreshCatalogueAfterProgressChange, storage, updateProgress]);

  const toggleVisit = useCallback((placeOrId: Pick<Place, "id"> | string) => {
    return toggle("visits", typeof placeOrId === "string" ? placeOrId : placeOrId.id);
  }, [toggle]);

  const toggleTrail = useCallback((trailId: string) => toggle("trails", trailId), [toggle]);

  const adoptAccountSession = useCallback(async (session: AccountSession, capturedEpoch: number) => {
    await hydrateAccountOutboxes(session.account.id);
    const identity: Identity = { kind: "account", token: session.token, account: session.account };
    visitMutationsRef.current.reset();
    await clearRestoredCameraPhoto(`account:${session.account.id}`);
    publishIdentity(identity);
    await hydrateCatalogueMetadata(identity);
    noteStorageFailure(await writeRawStored(storage(), ACCOUNT_TOKEN_KEY, session.token));
    setAuthenticated(true);
    setAccount(session.account);
    const sessionVisited = accountVisitOutboxRef.current.applyTo(session.visitedIds);
    updateProgress(
      sessionVisited,
      accountTrailOutboxRef.current.applyTo(session.completedTrailIds),
      timestampsFor(session.visits),
      metadataFor(session.visits, sessionVisited, timestampsFor(session.visits)),
    );
    await persistAccount();
    setGuestProgressAvailable(await guestHasProgress() && !await guestWasImportedBy(session.account.id));
    setSyncMessage("");
    try {
      await drainIdentity(identity, capturedEpoch);
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 401)) {
        setSyncMessage("Your account checkoffs are saved on this device and waiting to sync.");
      }
    }
    if (!catalogueReadyRef.current || catalogueNeedsRecoveryRef.current) {
      void runBackgroundCatalogueRecovery(() => mountedRef.current && epochRef.current.isCurrent(capturedEpoch)).catch((error) => {
        if (mountedRef.current && epochRef.current.isCurrent(capturedEpoch)) {
          setLoadError(placesRef.current.length ? "Showing your saved field guide offline." : error instanceof Error ? error.message : "Could not load the field guide.");
        }
      });
    } else refreshCatalogueAfterProgressChange(identity);
  }, [drainIdentity, guestHasProgress, guestWasImportedBy, hydrateAccountOutboxes, hydrateCatalogueMetadata, noteStorageFailure, persistAccount, publishIdentity, refreshCatalogueAfterProgressChange, runBackgroundCatalogueRecovery, storage, updateProgress]);

  const authenticate = useCallback(async (mode: "login" | "register", email: string, password: string) => {
    if (transitionRef.current) return;
    await hydrationReady.promise;
    storage();
    transitionRef.current = true;
    setTransitionBusy(true);
    const capturedEpoch = epochRef.current.advance();
    try {
      // Authentication errors belong to the submitting form, not global sync status.
      const session = await authenticateAccount(apiBaseUrl, mode, email, password);
      await adoptAccountSession(session, capturedEpoch);
    } finally {
      transitionRef.current = false;
      setTransitionBusy(false);
    }
  }, [adoptAccountSession, apiBaseUrl, hydrationReady, storage]);

  const authenticateWithGoogle = useCallback(async (code: string, state: string, codeVerifier: string) => {
    if (transitionRef.current) return;
    await hydrationReady.promise;
    storage();
    transitionRef.current = true;
    setTransitionBusy(true);
    const capturedEpoch = epochRef.current.advance();
    try {
      const session = await completeGoogleAuthorization(apiBaseUrl, code, state, codeVerifier);
      await adoptAccountSession(session, capturedEpoch);
    } finally {
      transitionRef.current = false;
      setTransitionBusy(false);
    }
  }, [adoptAccountSession, apiBaseUrl, hydrationReady, storage]);

  const requestEmailVerification = useCallback(async () => {
    const identity = identityRef.current;
    if (identity.kind !== "account") throw new Error("Sign in to verify your email.");
    await requestAccountEmailVerification(apiBaseUrl, identity.token);
  }, [apiBaseUrl]);

  const confirmEmailVerification = useCallback(async (verificationToken: string) => {
    const capturedIdentity = identityRef.current;
    const capturedEpoch = epochRef.current.capture();
    await confirmAccountEmailVerification(apiBaseUrl, verificationToken);
    if (capturedIdentity.kind !== "account" || !capturedIdentity.account) return;
    let refreshed;
    try {
      refreshed = await loadAccount(apiBaseUrl, capturedIdentity.token);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) expireAccount(capturedEpoch);
      return;
    }
    const currentIdentity = identityRef.current;
    if (!epochRef.current.isCurrent(capturedEpoch) || currentIdentity.kind !== "account" || currentIdentity.account?.id !== capturedIdentity.account.id) return;
    publishIdentity({ ...currentIdentity, account: refreshed.account });
    setAccount(refreshed.account);
    await persistAccount();
  }, [apiBaseUrl, expireAccount, persistAccount, publishIdentity]);

  const logout = useCallback(async () => {
    if (transitionRef.current || identityRef.current.kind !== "account") return;
    transitionRef.current = true;
    setTransitionBusy(true);
    const identity = identityRef.current;
    const capturedEpoch = epochRef.current.capture();
    const accountId = identity.account?.id;
    let logoutCommitted = false;
    let cleanupPending = false;
    try {
      if (!accountId) {
        setSyncMessage("Could not verify the saved offline visits for this account. Stay signed in and retry signing out.");
        return;
      }
      const owner = offlineClaimOwner(identity);
      if (!owner) {
        setSyncMessage("Could not verify the saved offline visits for this account. Stay signed in and retry signing out.");
        return;
      }

      if (browserIsOnline()) {
        try { await syncOfflineClaims(identity, capturedEpoch, false); } catch { /* inspect the durable queue before deciding whether sign-out is safe */ }
      }
      if (!epochRef.current.isCurrent(capturedEpoch) || !sameOwner(identityRef.current, identity)) return;

      let queued: OfflineClaimQueueItem[];
      try {
        queued = await offlineClaimsService.list(owner);
        await refreshOfflineClaimState(identity, capturedEpoch);
      } catch (error) {
        setSyncMessage(error instanceof Error
          ? `Could not verify saved offline visits. Stay signed in and retry: ${error.message}`
          : "Could not verify saved offline visits. Stay signed in and retry before signing out.");
        return;
      }
      if (queued.length) {
        const hasRecovery = queued.some((item) => item.state !== "pending");
        setSyncMessage(hasRecovery
          ? "Saved offline visits or photos need attention. Retry syncing or reset progress before signing out."
          : `${queued.length} offline ${queued.length === 1 ? "visit is" : "visits are"} still waiting to sync. Reconnect and retry, or reset progress before signing out.`);
        return;
      }

      epochRef.current.advance();
      try {
        await logoutAccount(apiBaseUrl, identity.token);
        logoutCommitted = true;
      } catch (error) {
        if (!(error instanceof ApiError && error.status === 401)) throw error;
        logoutCommitted = true;
      }

      if (logoutCommitted) {
        pendingLogoutCleanupRef.current = accountId;
        const markerSaved = await Promise.resolve(writeStored(storage(), JOURNAL_STORAGE.accountLogoutCleanup, { accountId })).catch(() => false);
        noteStorageFailure(markerSaved);
        try {
          if (markerSaved) await finishLogoutCleanup(accountId);
          else {
            await offlineClaimsService.clearOwner(accountId);
            if (!await removeStored(storage(), JOURNAL_STORAGE.accountLogoutCleanup)) throw new Error("Could not clear the sign-out cleanup marker.");
            pendingLogoutCleanupRef.current = "";
          }
        } catch {
          cleanupPending = true;
          if (!markerSaved) {
            // Retry once in memory after the server has signed the account out.
            // A later online/foreground pass will also retry if persistence works.
            await Promise.resolve(writeStored(storage(), JOURNAL_STORAGE.accountLogoutCleanup, { accountId })).catch(() => false);
          }
        }
        await switchToGuest("", { bestEffort: true });
        setSyncMessage(cleanupPending
          ? "You are signed out, but private offline visit cleanup still needs a retry. Reopen Parkdex or try syncing again."
          : "");
      }
    } catch (error) {
      if (logoutCommitted) {
        // The server has already revoked this session. Do not present the
        // signed-in state if a later local operation fails.
        try { await switchToGuest("", { bestEffort: true }); } catch { /* the durable marker remains available for recovery */ }
        setSyncMessage("You are signed out, but private offline visit cleanup still needs a retry. Reopen Parkdex or try syncing again.");
      } else {
        setSyncMessage(error instanceof Error
          ? `Could not sign out. Your account is still active on this device: ${error.message}`
          : "Could not sign out. Your account is still active on this device.");
      }
    } finally {
      transitionRef.current = false;
      setTransitionBusy(false);
    }
  }, [apiBaseUrl, finishLogoutCleanup, noteStorageFailure, offlineClaimsService, refreshOfflineClaimState, storage, switchToGuest, syncOfflineClaims]);

  const deleteAccount = useCallback(async (): Promise<AccountDeletionResult> => {
    const identity = identityRef.current;
    if (transitionRef.current) throw new Error("Another account change is still in progress.");
    if (identity.kind !== "account" || !identity.account) throw new Error("Sign in before deleting your account.");
    transitionRef.current = true;
    setTransitionBusy(true);
    // Invalidate every claim, photo, and outbox response that started before
    // the destructive transition. The request itself is replayable through
    // the owner-bound intent persisted below.
    epochRef.current.advance();
    let serverConfirmed = false;
    try {
      const intent = await accountDeletionIntent(identity.account.id);
      let deletion: AccountDeletionResponse;
      if (intent.confirmed) {
        deletion = { deleted: true, photoCleanupPending: intent.photoCleanupPending === true };
      } else {
        deletion = await deleteAccountRequest(apiBaseUrl, identity.token, intent.requestId);
      }
      serverConfirmed = true;

      const target = storage();
      const confirmedIntent: AccountDeletionIntent = {
        ...intent,
        confirmed: true,
        photoCleanupPending: deletion.photoCleanupPending,
      };
      if (!await writeStored(target, JOURNAL_STORAGE.accountDeletion, confirmedIntent)) {
        noteStorageFailure(false);
        throw new Error("Could not save the deletion confirmation for local recovery. Retry with the same request.");
      }
      accountDeletionIntentRef.current = confirmedIntent;
      let cleanupPending = false;
      try {
        await clearDeletedAccountLocalState(identity.account.id);
      } catch (error) {
        cleanupPending = true;
        setSyncMessage(error instanceof Error
          ? `Your account was deleted, but local cleanup needs another retry: ${error.message}`
          : "Your account was deleted, but local cleanup needs another retry.");
      }

      let sessionCleared = false;
      try {
        sessionCleared = await switchToGuest("Your account was deleted.", {
          clearRestoredCamera: false,
          bestEffort: true,
        });
      } catch {
        cleanupPending = true;
      }
      if (!sessionCleared) cleanupPending = true;
      if (cleanupPending) {
        setSyncMessage("Your account was deleted. Some private device data will be cleared when storage is available.");
      } else {
        const markerRemoved = await removeStored(target, JOURNAL_STORAGE.accountDeletion);
        noteStorageFailure(markerRemoved);
        if (!markerRemoved) cleanupPending = true;
        else accountDeletionIntentRef.current = null;
      }
      return {
        deleted: true,
        photoCleanupPending: deletion.photoCleanupPending,
        ...(cleanupPending ? { localCleanupPending: true } : {}),
      };
    } catch (error) {
      if (serverConfirmed) {
        setSyncMessage("The server confirmed account deletion, but local cleanup is unresolved. Retry to finish clearing this device.");
        throw error;
      }
      // A transport error, validation error, or generic 401 leaves the
      // account and its local state intact. The stored request id remains so
      // the next explicit attempt can safely ask the server for the same
      // deletion outcome.
      setSyncMessage(error instanceof Error
        ? `The server did not confirm account deletion. Retry with the same request to resolve it. ${error.message}`
        : "The server did not confirm account deletion. Retry with the same request to resolve it.");
      throw error;
    } finally {
      transitionRef.current = false;
      setTransitionBusy(false);
    }
  }, [accountDeletionIntent, apiBaseUrl, clearDeletedAccountLocalState, noteStorageFailure, storage, switchToGuest]);

  const importGuest = useCallback(async () => {
    const accountIdentity = identityRef.current;
    if (transitionRef.current || accountIdentity.kind !== "account") return;
    const target = storage();
    const collectionKey = await readStored<string>(target, JOURNAL_STORAGE.collectionKey, "");
    if (!collectionKey) return;
    transitionRef.current = true;
    setTransitionBusy(true);
    const capturedEpoch = epochRef.current.advance();
    try {
      await drainIdentity(accountIdentity, capturedEpoch);
      const guestIdentity: Identity = { kind: "guest", collectionKey };
      await drainIdentity(guestIdentity, capturedEpoch);
      const result = await importGuestProgress(apiBaseUrl, accountIdentity.token, collectionKey);
      if (!epochRef.current.isCurrent(capturedEpoch)) return;
      const importedTimestamps = timestampsFor(result.visits);
      const importedVisited = accountVisitOutboxRef.current.applyTo(result.visitedIds);
      visitMutationsRef.current.reset();
      updateProgress(importedVisited, new Set(result.completedTrailIds), importedTimestamps, metadataFor(result.visits, importedVisited, importedTimestamps));
      await persistAccount();
      const revision = await readStored<number>(target, JOURNAL_STORAGE.guestRevision, 0);
      if (accountIdentity.account) noteStorageFailure(await writeStored(target, importedGuestKey(accountIdentity.account.id), revision));
      setGuestProgressAvailable(false);
      setSyncMessage(`Added ${result.importedVisitCount} guest ${result.importedVisitCount === 1 ? "place" : "places"}.`);
      refreshCatalogueAfterProgressChange(accountIdentity);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        expireAccount(capturedEpoch);
      } else {
        setSyncMessage("Guest progress is still safe on this device. Reconnect and try importing again.");
      }
    } finally {
      transitionRef.current = false;
      setTransitionBusy(false);
    }
  }, [apiBaseUrl, drainIdentity, expireAccount, noteStorageFailure, persistAccount, refreshCatalogueAfterProgressChange, storage, updateProgress]);

  const currentClaimIdentity = useCallback((): Extract<Identity, { kind: "account" }> => {
    if (!apiBaseUrl) throw new Error("Visit saving is unavailable while the field guide is offline.");
    if (transitionRef.current) throw new Error("Another account change is still in progress.");
    storage();
    const identity = identityRef.current;
    if (identity.kind !== "account") throw new Error("Sign in to save visits and private photos.");
    return identity;
  }, [apiBaseUrl, storage]);

  const handleOwnerError = useCallback((error: unknown, identity: Identity, capturedEpoch: number) => {
    if (identity.kind === "account" && error instanceof ApiError && error.status === 401) expireAccount(capturedEpoch);
  }, [expireAccount]);

  const assertCurrentClaimOwner = useCallback((identity: Identity, capturedEpoch: number, message: string) => {
    if (!epochRef.current.isCurrent(capturedEpoch) || !sameOwner(identityRef.current, identity)) {
      throw new Error(message);
    }
  }, []);

  const recordGuestOwnerChange = useCallback(async (identity: Identity) => {
    if (identity.kind !== "guest") return;
    guestRevisionPendingRef.current = true;
    const operation = guestRevisionMutationRef.current.then(async () => {
      const target = storage();
      const revision = await readStored<number>(target, JOURNAL_STORAGE.guestRevision, 0) + 1;
      if (!await writeStored(target, JOURNAL_STORAGE.guestRevision, revision)) throw new Error("Could not save the guest revision.");
    });
    guestRevisionMutationRef.current = operation.catch(() => undefined);
    try {
      await operation;
      guestRevisionPendingRef.current = false;
      setGuestProgressAvailable(true);
    } catch {
      noteStorageFailure(false);
      setSyncMessage("Your guest photo change is saved and waiting for private storage before account import.");
    }
  }, [noteStorageFailure, storage]);

  const persistCurrentOwner = useCallback(async (identity: Identity) => {
    if (identity.kind === "guest") await persistGuest();
    else await persistAccount();
  }, [persistAccount, persistGuest]);

  const recommendClaim = useCallback(async (input: ClaimRecommendationInput) => {
    const identity = currentClaimIdentity();
    const capturedEpoch = epochRef.current.capture();
    try {
      const owner = offlineClaimOwner(identity);
      if (!browserIsOnline()) {
        if (!offlineClaimsAvailable || !owner) throw new Error("Offline visit saving is not available for this API. Reconnect to check in.");
        const recommendation = await offlineClaimsService.recommendLocal(owner, { ...input, excludedPlaceIds: new Set(visitedRef.current) });
        assertCurrentClaimOwner(identity, capturedEpoch, "Your journal changed while checking this location. Try again.");
        return recommendation;
      }
      const recommendation = await recommendClaimRequest(apiBaseUrl, claimOwner(identity), input);
      assertCurrentClaimOwner(identity, capturedEpoch, "Your journal changed while checking this location. Try again.");
      return recommendation;
    } catch (error) {
      const owner = offlineClaimOwner(identity);
      if (offlineClaimsAvailable && owner && isClaimTransportFailure(error)) {
        try {
          const recommendation = await offlineClaimsService.recommendLocal(owner, { ...input, excludedPlaceIds: new Set(visitedRef.current) });
          assertCurrentClaimOwner(identity, capturedEpoch, "Your journal changed while checking this location. Try again.");
          return recommendation;
        } catch (offlineError) {
          handleOwnerError(offlineError, identity, capturedEpoch);
          throw offlineError;
        }
      }
      handleOwnerError(error, identity, capturedEpoch);
      throw error;
    }
  }, [apiBaseUrl, assertCurrentClaimOwner, currentClaimIdentity, handleOwnerError, offlineClaimsAvailable, offlineClaimsService]);

  const createClaim = useCallback(async (input: { recommendationToken: string; expectedPlaceId: string; photoExpected?: boolean }) => {
    const identity = currentClaimIdentity();
    const capturedEpoch = epochRef.current.capture();
    try {
      const owner = offlineClaimOwner(identity);
      const service = offlineClaimsService;
      if (service.isOfflineToken(input.recommendationToken)) {
        if (!owner) throw new Error("Sign in to save visits and private photos.");
        const confirmation = await service.createLocal(owner, input);
        assertCurrentClaimOwner(identity, capturedEpoch, "Your journal changed before this visit finished. Refresh your journal before trying again.");
        await refreshOfflineClaimState(identity, capturedEpoch).catch(() => undefined);
        if (browserIsOnline()) void syncOfflineClaims(identity, capturedEpoch, false).catch(() => undefined);
        return confirmation;
      }
      const confirmation = await createClaimRequest(apiBaseUrl, claimOwner(identity), input);
      assertCurrentClaimOwner(identity, capturedEpoch, "Your journal changed before this visit finished. Refresh your journal before trying again.");
      if (confirmation.pendingSync) return confirmation;
      const nextVisited = new Set(visitedRef.current).add(confirmation.placeId);
      const nextTimestamps = { ...visitTimestampsRef.current, [confirmation.placeId]: confirmation.visitedAt };
      const claimedVisit: Visit = { placeId: confirmation.placeId, visitedAt: confirmation.visitedAt, claim: confirmation.claim };
      const nextMetadata = {
        ...visitMetadataRef.current,
        [confirmation.placeId]: claimedVisit,
      };
      visitMutationsRef.current.record(confirmation.placeId, claimedVisit);
      updateProgress(nextVisited, new Set(trailsRef.current), nextTimestamps, nextMetadata);
      await persistCurrentOwner(identity);
      refreshCatalogueAfterProgressChange(identity);
      return confirmation;
    } catch (error) {
      handleOwnerError(error, identity, capturedEpoch);
      throw error;
    }
  }, [apiBaseUrl, assertCurrentClaimOwner, currentClaimIdentity, handleOwnerError, offlineClaimsService, persistCurrentOwner, refreshCatalogueAfterProgressChange, refreshOfflineClaimState, syncOfflineClaims, updateProgress]);

  const reconcileClaim = useCallback(async (placeId: string): Promise<ClaimConfirmation | null> => {
    const identity = currentClaimIdentity();
    const capturedEpoch = epochRef.current.capture();
    const mutationCheckpoint = visitMutationsRef.current.checkpoint();
    try {
      const session = await loadAccount(apiBaseUrl, identity.token);
      assertCurrentClaimOwner(identity, capturedEpoch, "Your journal changed while checking this visit. Try again.");
      const sessionTimestamps = timestampsFor(session.visits);
      const sessionVisited = accountVisitOutboxRef.current.applyTo(session.visitedIds);
      const rebased = visitMutationsRef.current.rebase(
        sessionVisited,
        sessionTimestamps,
        metadataFor(session.visits, sessionVisited, sessionTimestamps),
        mutationCheckpoint,
      );
      publishIdentity({ ...identity, account: session.account });
      setAccount(session.account);
      updateProgress(
        rebased.visited,
        accountTrailOutboxRef.current.applyTo(session.completedTrailIds),
        rebased.timestamps,
        rebased.metadata,
      );
      await persistAccount();
      refreshCatalogueAfterProgressChange(identity);
      const visit = rebased.metadata[placeId];
      if (!visit?.claim) return null;
      return {
        placeId,
        visited: true,
        visitedCount: rebased.visited.size,
        visitedAt: visit.visitedAt,
        claim: visit.claim,
      };
    } catch (error) {
      handleOwnerError(error, identity, capturedEpoch);
      throw error;
    }
  }, [apiBaseUrl, assertCurrentClaimOwner, currentClaimIdentity, handleOwnerError, persistAccount, publishIdentity, refreshCatalogueAfterProgressChange, updateProgress]);

  const updatePhotoFlag = useCallback(async (identity: Identity, capturedEpoch: number, placeId: string, hasPhoto: boolean) => {
    assertCurrentClaimOwner(identity, capturedEpoch, "Your journal changed before this photo update finished. Refresh your journal before trying again.");
    const current = visitMetadataRef.current[placeId];
    if (!current?.claim) return;
    const updatedVisit: Visit = { ...current, claim: { ...current.claim, hasPhoto } };
    const nextMetadata = {
      ...visitMetadataRef.current,
      [placeId]: updatedVisit,
    };
    visitMutationsRef.current.record(placeId, updatedVisit);
    updateProgress(new Set(visitedRef.current), new Set(trailsRef.current), { ...visitTimestampsRef.current }, nextMetadata);
    await persistCurrentOwner(identity);
  }, [assertCurrentClaimOwner, persistCurrentOwner, updateProgress]);

  const uploadVisitPhoto = useCallback(async (placeId: string, file: File) => {
    const identity = currentClaimIdentity();
    const capturedEpoch = epochRef.current.capture();
    try {
      await uploadVisitPhotoRequest(apiBaseUrl, claimOwner(identity), placeId, file);
      assertCurrentClaimOwner(identity, capturedEpoch, "Your journal changed before this photo upload finished. The current account was not updated.");
      await recordGuestOwnerChange(identity);
      await updatePhotoFlag(identity, capturedEpoch, placeId, true);
    } catch (error) {
      handleOwnerError(error, identity, capturedEpoch);
      throw error;
    }
  }, [apiBaseUrl, assertCurrentClaimOwner, currentClaimIdentity, handleOwnerError, recordGuestOwnerChange, updatePhotoFlag]);

  const loadVisitPhoto = useCallback(async (placeId: string) => {
    const identity = currentClaimIdentity();
    const capturedEpoch = epochRef.current.capture();
    try {
      const photo = await loadVisitPhotoRequest(apiBaseUrl, claimOwner(identity), placeId);
      assertCurrentClaimOwner(identity, capturedEpoch, "Your journal changed while loading this photo.");
      return photo;
    } catch (error) {
      handleOwnerError(error, identity, capturedEpoch);
      throw error;
    }
  }, [apiBaseUrl, assertCurrentClaimOwner, currentClaimIdentity, handleOwnerError]);

  const removeVisitPhoto = useCallback(async (placeId: string) => {
    const identity = currentClaimIdentity();
    const capturedEpoch = epochRef.current.capture();
    try {
      const owner = offlineClaimOwner(identity);
      if (owner) {
        await offlineClaimsService.cancelPhotoRetry(owner, placeId);
        assertCurrentClaimOwner(identity, capturedEpoch, "Your journal changed before this photo removal finished. Refresh your journal before trying again.");
      }
      await removeVisitPhotoRequest(apiBaseUrl, claimOwner(identity), placeId);
      assertCurrentClaimOwner(identity, capturedEpoch, "Your journal changed before this photo removal finished. The current account was not updated.");
      await recordGuestOwnerChange(identity);
      await updatePhotoFlag(identity, capturedEpoch, placeId, false);
    } catch (error) {
      handleOwnerError(error, identity, capturedEpoch);
      throw error;
    }
  }, [apiBaseUrl, assertCurrentClaimOwner, currentClaimIdentity, handleOwnerError, offlineClaimsService, recordGuestOwnerChange, updatePhotoFlag]);

  const resetProgress = useCallback(async () => {
    const identity = identityRef.current;
    if (transitionRef.current) throw new Error("Another account change is still in progress.");
    if (identity.kind !== "account" || !identity.account) throw new Error("Sign in before resetting progress.");
    transitionRef.current = true;
    setTransitionBusy(true);
    const capturedEpoch = epochRef.current.advance();
    const visitPending = accountVisitOutboxRef.current.snapshot();
    const trailPending = accountTrailOutboxRef.current.snapshot();
    let serverConfirmed = false;
    let cleanupMarkerSaved = false;
    try {
      await Promise.all([
        accountVisitOutboxRef.current.clearAndWait(),
        accountTrailOutboxRef.current.clearAndWait(),
      ]);
      await persistAccountOutboxes(identity.account.id);
      await resetAccountProgress(apiBaseUrl, identity.token);
      serverConfirmed = true;
      pendingProgressResetCleanupRef.current = identity.account.id;
      try {
        cleanupMarkerSaved = await Promise.resolve(writeStored(storage(), JOURNAL_STORAGE.accountProgressResetCleanup, { accountId: identity.account.id }));
      } catch {
        cleanupMarkerSaved = false;
      }
      noteStorageFailure(cleanupMarkerSaved);
      if (!epochRef.current.isCurrent(capturedEpoch)) return;
      visitMutationsRef.current.reset();
      updateProgress(new Set(), new Set(), {}, {});
      await persistAccount();
      setPendingClaims(0);
      setRejectedClaimCount(0);
      setOfflineClaimRecoveryCount(0);
      setOfflineClaimRecoveryMessage("");
      setProgressRevision((revision) => revision + 1);
      refreshCatalogueAfterProgressChange(identity);
      let cleanupError: unknown = null;
      try {
        await finishProgressResetCleanup(identity.account.id);
      } catch (error) {
        if (!cleanupMarkerSaved) {
          try {
            cleanupMarkerSaved = await Promise.resolve(writeStored(storage(), JOURNAL_STORAGE.accountProgressResetCleanup, { accountId: identity.account.id }));
          } catch {
            cleanupMarkerSaved = false;
          }
          noteStorageFailure(cleanupMarkerSaved);
        }
        cleanupError = error;
      }
      setSyncMessage(cleanupError
        ? cleanupMarkerSaved
          ? "Your progress has been reset, but private device cleanup still needs a retry. Reopen Parkdex or try syncing again."
          : "Your progress has been reset, but device cleanup is unfinished and its retry marker could not be saved. Keep Parkdex open and retry syncing before closing it."
        : "Your progress has been reset.");
    } catch (error) {
      if (!serverConfirmed) {
        accountVisitOutboxRef.current.hydrate(visitPending);
        accountTrailOutboxRef.current.hydrate(trailPending);
        await persistAccountOutboxes(identity.account.id);
      } else {
        visitMutationsRef.current.reset();
        updateProgress(new Set(), new Set(), {}, {});
        setPendingClaims(0);
        setRejectedClaimCount(0);
        setOfflineClaimRecoveryCount(0);
        setOfflineClaimRecoveryMessage("");
        setProgressRevision((revision) => revision + 1);
        refreshCatalogueAfterProgressChange(identity);
        if (!cleanupMarkerSaved) {
          try {
            cleanupMarkerSaved = await Promise.resolve(writeStored(storage(), JOURNAL_STORAGE.accountProgressResetCleanup, { accountId: identity.account.id }));
          } catch {
            cleanupMarkerSaved = false;
          }
          noteStorageFailure(cleanupMarkerSaved);
        }
        setSyncMessage(cleanupMarkerSaved
          ? "Your progress has been reset, but private device cleanup still needs a retry. Reopen Parkdex or try syncing again."
          : "Your progress has been reset, but device cleanup is unfinished and its retry marker could not be saved. Keep Parkdex open and retry syncing before closing it.");
        return;
      }
      if (error instanceof ApiError && error.status === 401) {
        expireAccount(capturedEpoch);
      } else {
        setSyncMessage(error instanceof Error ? error.message : "Could not reset your progress. Please try again.");
      }
      throw error;
    } finally {
      transitionRef.current = false;
      setTransitionBusy(false);
    }
  }, [apiBaseUrl, expireAccount, finishProgressResetCleanup, noteStorageFailure, persistAccount, persistAccountOutboxes, refreshCatalogueAfterProgressChange, storage, updateProgress]);

  useEffect(() => {
    if (syncMessage !== "Your progress has been reset.") return;
    const timeout = window.setTimeout(() => setSyncMessage(""), 4000);
    return () => window.clearTimeout(timeout);
  }, [syncMessage]);

  return {
    places,
    total,
    categoryTotals,
    visitedCategoryTotals,
    badges,
    catalogueOwnerKey: catalogueContext.ownerKey,
    catalogueHeaders: catalogueContext.headers,
    visited,
    completedTrails,
    visitTimestamps,
    visitMetadata,
    coverageNote,
    account,
    authenticated,
    loading,
    loadError,
    syncMessage,
    storageUnavailable,
    guestProgressAvailable,
    transitionBusy,
    progressRevision,
    pendingClaims,
    rejectedClaimCount,
    offlineClaimsAvailable,
    offlineClaimRecoveryCount,
    offlineClaimRecoveryMessage,
    visitClaimMode,
    toggleVisit,
    toggleTrail,
    retryCatalogue,
    retrySync,
    retryPendingClaims,
    discardRejectedClaims,
    authenticate,
    authenticateWithGoogle,
    requestEmailVerification,
    confirmEmailVerification,
    logout,
    importGuest,
    resetProgress,
    deleteAccount,
    recommendClaim: visitClaimMode === "compatible" || visitClaimMode === "required" ? recommendClaim : undefined,
    createClaim: visitClaimMode === "compatible" || visitClaimMode === "required" ? createClaim : undefined,
    reconcileClaim: visitClaimMode === "compatible" || visitClaimMode === "required" ? reconcileClaim : undefined,
    uploadVisitPhoto: visitClaimMode === "compatible" || visitClaimMode === "required" ? uploadVisitPhoto : undefined,
    loadVisitPhoto: visitClaimMode === "compatible" || visitClaimMode === "required" ? loadVisitPhoto : undefined,
    removeVisitPhoto: visitClaimMode === "compatible" || visitClaimMode === "required" ? removeVisitPhoto : undefined,
    authenticatedRequest,
  };
}
