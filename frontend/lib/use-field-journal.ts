"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  ACCOUNT_TOKEN_KEY,
  ApiError,
  authenticate as authenticateAccount,
  changePassword as changeAccountPassword,
  completeGoogleAuthorization,
  confirmEmailVerification as confirmAccountEmailVerification,
  importGuestProgress,
  loadAccount,
  logout as logoutAccount,
  requestEmailVerification as requestAccountEmailVerification,
  resetAccountProgress,
  type Account,
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
import { getPlatformStorage, type KeyValueStore } from "./platform-storage";
import { createCollectionKey, type Place } from "./places";
import { VisitOutbox } from "./visit-outbox";

type Identity =
  | { kind: "guest"; collectionKey: string }
  | { kind: "account"; token: string; account: Account | null };

type CataloguePayload = {
  places: Place[];
  visitedIds: string[];
  completedTrailIds?: string[];
  visits?: Visit[];
  coverageNote: string;
};

type AccountSnapshot = {
  account: Account;
  visitedIds: string[];
  completedTrailIds: string[];
  visitTimestamps?: Record<string, string>;
  visits?: Visit[];
};

export type FieldJournal = {
  places: Place[];
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
  toggleVisit: (placeOrId: Pick<Place, "id"> | string) => Promise<void>;
  toggleTrail: (trailId: string) => Promise<void>;
  retrySync: () => Promise<void>;
  authenticate: (mode: "login" | "register", email: string, password: string) => Promise<void>;
  authenticateWithGoogle: (code: string, state: string, codeVerifier: string) => Promise<void>;
  changePassword: (currentPassword: string, newPassword: string) => Promise<void>;
  requestEmailVerification: () => Promise<void>;
  confirmEmailVerification: (verificationToken: string) => Promise<void>;
  logout: () => Promise<void>;
  importGuest: () => Promise<void>;
  resetProgress: () => Promise<void>;
  recommendClaim: (input: ClaimRecommendationInput) => Promise<ClaimRecommendation>;
  createClaim: (input: { recommendationToken: string; expectedPlaceId: string }) => Promise<ClaimConfirmation>;
  uploadVisitPhoto: (placeId: string, file: File) => Promise<void>;
  loadVisitPhoto: (placeId: string) => Promise<Blob>;
  removeVisitPhoto: (placeId: string) => Promise<void>;
};

function hasEntries(outbox: VisitOutbox) {
  return outbox.hasPending();
}

function timestampsFor(visits: Visit[] | undefined): Record<string, string> {
  return Object.fromEntries((visits ?? []).map((visit) => [visit.placeId, visit.visitedAt]));
}

function metadataFor(visits: Visit[] | undefined, visitedIds: Iterable<string> = [], timestamps: Record<string, string> = {}): Record<string, Visit> {
  const metadata = Object.fromEntries((visits ?? []).map((visit) => [visit.placeId, visit]));
  for (const placeId of visitedIds) {
    if (!metadata[placeId] && timestamps[placeId]) metadata[placeId] = { placeId, visitedAt: timestamps[placeId] };
  }
  return metadata;
}

function claimOwner(identity: Identity): ClaimOwner {
  return identity.kind === "account"
    ? { kind: "account", token: identity.token }
    : { kind: "guest", collectionKey: identity.collectionKey };
}

function sameOwner(left: Identity, right: Identity) {
  return left.kind === right.kind && (left.kind === "account"
    ? left.account?.id === (right.kind === "account" ? right.account?.id : undefined) && left.token === (right.kind === "account" ? right.token : "")
    : left.collectionKey === (right.kind === "guest" ? right.collectionKey : ""));
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

export function useFieldJournal({ apiBaseUrl }: { apiBaseUrl: string }): FieldJournal {
  const [places, setPlaces] = useState<Place[]>([]);
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

  const epochRef = useRef(new IdentityEpoch());
  const transitionRef = useRef(false);
  const identityRef = useRef<Identity>({ kind: "guest", collectionKey: "" });
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
  const [hydrationReady] = useState(() => {
    let resolve: () => void = () => {};
    const promise = new Promise<void>((ready) => { resolve = ready; });
    return { promise, resolve };
  });

  const noteStorageFailure = useCallback((success: boolean) => {
    if (!success) setStorageUnavailable(true);
    return success;
  }, []);

  const storage = useCallback(() => {
    if (!storageRef.current) throw new Error("Storage is not ready.");
    return storageRef.current;
  }, []);

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

  const switchToGuest = useCallback(async (message = "") => {
    epochRef.current.advance();
    const target = storage();
    noteStorageFailure(await removeStored(target, ACCOUNT_TOKEN_KEY));
    noteStorageFailure(await removeStored(target, JOURNAL_STORAGE.accountSnapshot));
    const collectionKey = identityRef.current.kind === "guest"
      ? identityRef.current.collectionKey
      : await readStored<string>(target, JOURNAL_STORAGE.collectionKey, "");
    identityRef.current = { kind: "guest", collectionKey };
    setAuthenticated(false);
    setAccount(null);
    const guestVisited = guestVisitOutboxRef.current.applyTo(await readStored<string[]>(target, JOURNAL_STORAGE.guestVisited, []));
    const guestTrails = guestTrailOutboxRef.current.applyTo(await readStored<string[]>(target, JOURNAL_STORAGE.guestTrails, []));
    updateProgress(
      guestVisited,
      guestTrails,
      await readStored<Record<string, string>>(target, JOURNAL_STORAGE.guestVisitTimestamps, {}),
      await readStored<Record<string, Visit>>(target, JOURNAL_STORAGE.guestVisitMetadata, {}),
    );
    setGuestProgressAvailable(await guestHasProgress());
    if (message) setSyncMessage(message);
  }, [guestHasProgress, noteStorageFailure, storage, updateProgress]);

  const expireAccount = useCallback((capturedEpoch: number) => {
    if (!epochRef.current.isCurrent(capturedEpoch) || identityRef.current.kind !== "account") return;
    void switchToGuest("Your session expired. Sign in again to continue syncing your account.");
  }, [switchToGuest]);

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
    }
    if (!enabled) {
      delete nextTimestamps[id];
      delete nextMetadata[id];
    }
    updateProgress(new Set(visitedRef.current), new Set(trailsRef.current), nextTimestamps, nextMetadata);
  }, [apiBaseUrl, expireAccount, updateProgress]);

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

  const drainIdentity = useCallback(async (identity: Identity, capturedEpoch: number) => {
    const visitBox = identity.kind === "guest" ? guestVisitOutboxRef.current : accountVisitOutboxRef.current;
    const trailBox = identity.kind === "guest" ? guestTrailOutboxRef.current : accountTrailOutboxRef.current;
    try {
      await persistOutbox(identity, visitBox.snapshot(), trailBox.snapshot());
      if (identity.kind === "guest") await persistGuest(); else await persistAccount();
      const results = await Promise.allSettled([
        visitBox.drainAll((id, enabled) => putProgress("visits", id, enabled, identity, capturedEpoch)),
        trailBox.drainAll((id, enabled) => putProgress("trails", id, enabled, identity, capturedEpoch)),
      ]);
      if (results.some((result) => result.status === "rejected")) throw new Error("Some checkoffs did not sync.");
    } finally {
      await persistOutbox(identity, visitBox.snapshot(), trailBox.snapshot());
    }
  }, [persistAccount, persistGuest, persistOutbox, putProgress]);

  const retrySync = useCallback(async () => {
    if (transitionRef.current) return;
    const identity = identityRef.current;
    if (identity.kind === "guest" && !identity.collectionKey) return;
    const visitBox = identity.kind === "guest" ? guestVisitOutboxRef.current : accountVisitOutboxRef.current;
    const trailBox = identity.kind === "guest" ? guestTrailOutboxRef.current : accountTrailOutboxRef.current;
    const hasPendingCheckoffs = visitBox.hasPending() || trailBox.hasPending();
    if (!hasPendingCheckoffs && !guestRevisionPendingRef.current) return;
    setSyncMessage("Syncing your latest checkoffs…");
    const capturedEpoch = epochRef.current.capture();
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
  }, [drainIdentity, storage]);

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
      const guestVisitMetadata = Object.keys(storedGuestMetadata).length
        ? storedGuestMetadata
        : metadataFor(undefined, guestVisited, guestVisitTimestamps);
      const cachedPlaces = await readStored<Place[]>(target, JOURNAL_STORAGE.places, []);

      let savedToken = await target.getItem(ACCOUNT_TOKEN_KEY) ?? "";
      const cachedAccount = await readStored<AccountSnapshot | null>(target, JOURNAL_STORAGE.accountSnapshot, null);
      let initialVisited = guestVisited;
      let initialTrails = guestTrails;
      let initialVisitTimestamps = guestVisitTimestamps;
      let initialVisitMetadata = guestVisitMetadata;
      if (savedToken) {
        identityRef.current = { kind: "account", token: savedToken, account: cachedAccount?.account ?? null };
        if (cachedAccount) {
          await hydrateAccountOutboxes(cachedAccount.account.id);
          initialVisited = accountVisitOutboxRef.current.applyTo(cachedAccount.visitedIds);
          initialTrails = accountTrailOutboxRef.current.applyTo(cachedAccount.completedTrailIds);
          initialVisitTimestamps = cachedAccount.visitTimestamps ?? {};
          initialVisitMetadata = metadataFor(cachedAccount.visits, cachedAccount.visitedIds, initialVisitTimestamps);
        } else {
          initialVisited = new Set();
          initialTrails = new Set();
          initialVisitTimestamps = {};
          initialVisitMetadata = {};
        }
      } else {
        identityRef.current = { kind: "guest", collectionKey };
      }

      if (cachedPlaces.length) setPlaces(cachedPlaces);
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
        try {
          const session = await loadAccount(apiBaseUrl, savedToken);
          if (!active || !epochRef.current.isCurrent(accountEpoch)) return;
          await hydrateAccountOutboxes(session.account.id);
          identityRef.current = { kind: "account", token: savedToken, account: session.account };
          setAccount(session.account);
          setGuestProgressAvailable(await guestHasProgress() && !await guestWasImportedBy(session.account.id));
          updateProgress(
            accountVisitOutboxRef.current.applyTo(session.visitedIds),
            accountTrailOutboxRef.current.applyTo(session.completedTrailIds),
            timestampsFor(session.visits),
            metadataFor(session.visits, session.visitedIds, timestampsFor(session.visits)),
          );
          await persistAccount();
        } catch (error) {
          if (!active || !epochRef.current.isCurrent(accountEpoch)) return;
          if (error instanceof ApiError && error.status === 401) {
            savedToken = "";
            await switchToGuest("Your session expired. Sign in again to continue syncing your account.");
          } else {
            setLoadError(cachedPlaces.length ? "Showing your saved account journal offline." : "Your account is offline. We’ll reconnect without switching collections.");
          }
        }
      }

      const identity = identityRef.current;
      const catalogueEpoch = epochRef.current.capture();
      const visitBox = identity.kind === "guest" ? guestVisitOutboxRef.current : accountVisitOutboxRef.current;
      const trailBox = identity.kind === "guest" ? guestTrailOutboxRef.current : accountTrailOutboxRef.current;
      const visitCheckpoint = visitBox.checkpoint();
      const trailCheckpoint = trailBox.checkpoint();
      const headers: Record<string, string> = identity.kind === "account"
        ? { Authorization: `Bearer ${identity.token}` }
        : { "X-Collection-Key": identity.collectionKey };
      try {
        const response = await fetch(`${apiBaseUrl}/api/places`, { cache: "no-store", headers });
        if (!response.ok) throw await responseError(response, "Could not load the field guide.");
        const payload = await response.json() as CataloguePayload;
        if (!active || !epochRef.current.isCurrent(catalogueEpoch)) return;
        const nextVisited = visitBox.applyTo(payload.visitedIds, visitCheckpoint);
        const nextTrails = trailBox.applyTo(payload.completedTrailIds ?? [], trailCheckpoint);
        setPlaces(payload.places);
        setCoverageNote(payload.coverageNote);
        const payloadTimestamps = timestampsFor(payload.visits);
        updateProgress(nextVisited, nextTrails, payloadTimestamps, metadataFor(payload.visits, payload.visitedIds, payloadTimestamps));
        noteStorageFailure(await writeStored(target, JOURNAL_STORAGE.places, payload.places));
        if (identity.kind === "guest") await persistGuest(); else await persistAccount();
        setLoadError("");
      } catch (error) {
        if (!active || !epochRef.current.isCurrent(catalogueEpoch)) return;
        if (identity.kind === "account" && error instanceof ApiError && error.status === 401) {
          expireAccount(catalogueEpoch);
        } else {
          setLoadError(cachedPlaces.length ? "Showing your saved field guide offline." : error instanceof Error ? error.message : "Could not load the field guide.");
        }
      } finally {
        if (active) setLoading(false);
      }
    })().catch(() => {
      if (!active) return;
      setStorageUnavailable(true);
      setLoadError("Secure device storage is unavailable. Restart the app to try again.");
      setLoading(false);
      hydrationReady.resolve();
    });

    return () => { active = false; epoch.advance(); };
  }, [apiBaseUrl, expireAccount, guestHasProgress, guestWasImportedBy, hydrateAccountOutboxes, hydrationReady, noteStorageFailure, persistAccount, persistGuest, storage, switchToGuest, updateProgress]);

  useEffect(() => {
    if (loading) return;
    const timer = window.setTimeout(() => void retrySync(), 0);
    return () => window.clearTimeout(timer);
  }, [loading, retrySync]);

  useEffect(() => {
    const resume = () => void retrySync();
    window.addEventListener("online", resume);
    return () => window.removeEventListener("online", resume);
  }, [retrySync]);

  const toggle = useCallback(async (kind: "visits" | "trails", id: string) => {
    if (transitionRef.current) return;
    const identity = identityRef.current;
    if (identity.kind === "guest" && !identity.collectionKey) return;
    const current = kind === "visits" ? visitedRef.current : trailsRef.current;
    const { next, enabled } = toggledSet(current, id);
    if (kind === "visits") updateProgress(next, new Set(trailsRef.current));
    else updateProgress(new Set(visitedRef.current), next);
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
      await outbox.drain(id, (pendingId, pendingValue) => putProgress(kind, pendingId, pendingValue, identity, capturedEpoch));
    } catch (error) {
      if (kind === "visits" && enabled && error instanceof ApiError && error.status === 409 && error.code === "location_claim_required") {
        outbox.discard(id, true);
        if (epochRef.current.isCurrent(capturedEpoch) && sameOwner(identityRef.current, identity) && visitedRef.current.has(id)) {
          const nextVisited = new Set(visitedRef.current);
          nextVisited.delete(id);
          updateProgress(nextVisited, new Set(trailsRef.current));
        }
        setSyncMessage("This park now requires a location claim. Use “Claim this park” while you’re there.");
      } else if (!(error instanceof ApiError && error.status === 401)) {
        setSyncMessage(identity.kind === "account"
          ? "Your account checkoff is saved on this device and waiting to sync."
          : "Your guest checkoff is saved on this device and waiting to sync.");
      }
    } finally {
      try { await persistOutbox(identity, visitBox.snapshot(), trailBox.snapshot()); }
      catch { setSyncMessage("Private device storage could not save this checkoff. Try again before leaving this page."); }
    }
  }, [noteStorageFailure, persistAccount, persistGuest, persistOutbox, putProgress, storage, updateProgress]);

  const toggleVisit = useCallback((placeOrId: Pick<Place, "id"> | string) => {
    return toggle("visits", typeof placeOrId === "string" ? placeOrId : placeOrId.id);
  }, [toggle]);

  const toggleTrail = useCallback((trailId: string) => toggle("trails", trailId), [toggle]);

  const adoptAccountSession = useCallback(async (session: AccountSession, capturedEpoch: number) => {
    await hydrateAccountOutboxes(session.account.id);
    const identity: Identity = { kind: "account", token: session.token, account: session.account };
    identityRef.current = identity;
    noteStorageFailure(await writeRawStored(storage(), ACCOUNT_TOKEN_KEY, session.token));
    setAuthenticated(true);
    setAccount(session.account);
    updateProgress(
      accountVisitOutboxRef.current.applyTo(session.visitedIds),
      accountTrailOutboxRef.current.applyTo(session.completedTrailIds),
      timestampsFor(session.visits),
      metadataFor(session.visits, session.visitedIds, timestampsFor(session.visits)),
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
  }, [drainIdentity, guestHasProgress, guestWasImportedBy, hydrateAccountOutboxes, noteStorageFailure, persistAccount, storage, updateProgress]);

  const authenticate = useCallback(async (mode: "login" | "register", email: string, password: string) => {
    if (transitionRef.current) return;
    await hydrationReady.promise;
    storage();
    transitionRef.current = true;
    setTransitionBusy(true);
    const capturedEpoch = epochRef.current.advance();
    try {
      let session;
      try {
        session = await authenticateAccount(apiBaseUrl, mode, email, password);
      } catch (error) {
        setSyncMessage(error instanceof Error ? error.message : "Could not sign in.");
        throw error;
      }
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
    identityRef.current = { ...currentIdentity, account: refreshed.account };
    setAccount(refreshed.account);
    await persistAccount();
  }, [apiBaseUrl, expireAccount, persistAccount]);

  const changePassword = useCallback(async (currentPassword: string, newPassword: string) => {
    const identity = identityRef.current;
    if (transitionRef.current) throw new Error("Another account change is still in progress.");
    if (identity.kind !== "account") throw new Error("Sign in before changing your password.");
    transitionRef.current = true;
    setTransitionBusy(true);
    try {
      await changeAccountPassword(apiBaseUrl, identity.token, currentPassword, newPassword);
      await switchToGuest("Password changed. Sign in again on this device.");
    } finally {
      transitionRef.current = false;
      setTransitionBusy(false);
    }
  }, [apiBaseUrl, switchToGuest]);

  const logout = useCallback(async () => {
    if (transitionRef.current || identityRef.current.kind !== "account") return;
    transitionRef.current = true;
    setTransitionBusy(true);
    const identity = identityRef.current;
    epochRef.current.advance();
    try {
      await logoutAccount(apiBaseUrl, identity.token);
      await switchToGuest();
      setSyncMessage("");
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        await switchToGuest("Your session had already expired. You are signed out.");
      } else {
        setSyncMessage("Could not sign out while offline. Your account is still active on this device.");
      }
    } finally {
      transitionRef.current = false;
      setTransitionBusy(false);
    }
  }, [apiBaseUrl, switchToGuest]);

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
      updateProgress(new Set(result.visitedIds), new Set(result.completedTrailIds), importedTimestamps, metadataFor(result.visits, result.visitedIds, importedTimestamps));
      await persistAccount();
      const revision = await readStored<number>(target, JOURNAL_STORAGE.guestRevision, 0);
      if (accountIdentity.account) noteStorageFailure(await writeStored(target, importedGuestKey(accountIdentity.account.id), revision));
      setGuestProgressAvailable(false);
      setSyncMessage(`Added ${result.importedVisitCount} guest ${result.importedVisitCount === 1 ? "place" : "places"}.`);
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
  }, [apiBaseUrl, drainIdentity, expireAccount, noteStorageFailure, persistAccount, storage, updateProgress]);

  const currentClaimIdentity = useCallback(() => {
    if (!apiBaseUrl) throw new Error("Claims are unavailable while the field guide is offline.");
    storage();
    const identity = identityRef.current;
    if (identity.kind === "guest" && !identity.collectionKey) throw new Error("Your journal is still getting ready.");
    return identity;
  }, [apiBaseUrl, storage]);

  const handleOwnerError = useCallback((error: unknown, identity: Identity, capturedEpoch: number) => {
    if (identity.kind === "account" && error instanceof ApiError && error.status === 401) expireAccount(capturedEpoch);
  }, [expireAccount]);

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
      const recommendation = await recommendClaimRequest(apiBaseUrl, claimOwner(identity), input);
      if (!epochRef.current.isCurrent(capturedEpoch) || !sameOwner(identityRef.current, identity)) {
        throw new Error("Your journal changed while checking this location. Try again.");
      }
      return recommendation;
    } catch (error) {
      handleOwnerError(error, identity, capturedEpoch);
      throw error;
    }
  }, [apiBaseUrl, currentClaimIdentity, handleOwnerError]);

  const createClaim = useCallback(async (input: { recommendationToken: string; expectedPlaceId: string }) => {
    const identity = currentClaimIdentity();
    const capturedEpoch = epochRef.current.capture();
    try {
      const confirmation = await createClaimRequest(apiBaseUrl, claimOwner(identity), input);
      if (!epochRef.current.isCurrent(capturedEpoch) || !sameOwner(identityRef.current, identity)) return confirmation;
      const nextVisited = new Set(visitedRef.current).add(confirmation.placeId);
      const nextTimestamps = { ...visitTimestampsRef.current, [confirmation.placeId]: confirmation.visitedAt };
      const nextMetadata = {
        ...visitMetadataRef.current,
        [confirmation.placeId]: { placeId: confirmation.placeId, visitedAt: confirmation.visitedAt, claim: confirmation.claim },
      };
      updateProgress(nextVisited, new Set(trailsRef.current), nextTimestamps, nextMetadata);
      await persistCurrentOwner(identity);
      return confirmation;
    } catch (error) {
      handleOwnerError(error, identity, capturedEpoch);
      throw error;
    }
  }, [apiBaseUrl, currentClaimIdentity, handleOwnerError, persistCurrentOwner, updateProgress]);

  const updatePhotoFlag = useCallback(async (identity: Identity, capturedEpoch: number, placeId: string, hasPhoto: boolean) => {
    if (!epochRef.current.isCurrent(capturedEpoch) || !sameOwner(identityRef.current, identity)) return;
    const current = visitMetadataRef.current[placeId];
    if (!current?.claim) return;
    const nextMetadata = {
      ...visitMetadataRef.current,
      [placeId]: { ...current, claim: { ...current.claim, hasPhoto } },
    };
    updateProgress(new Set(visitedRef.current), new Set(trailsRef.current), { ...visitTimestampsRef.current }, nextMetadata);
    await persistCurrentOwner(identity);
  }, [persistCurrentOwner, updateProgress]);

  const uploadVisitPhoto = useCallback(async (placeId: string, file: File) => {
    const identity = currentClaimIdentity();
    const capturedEpoch = epochRef.current.capture();
    try {
      await uploadVisitPhotoRequest(apiBaseUrl, claimOwner(identity), placeId, file);
      await recordGuestOwnerChange(identity);
      await updatePhotoFlag(identity, capturedEpoch, placeId, true);
    } catch (error) {
      handleOwnerError(error, identity, capturedEpoch);
      throw error;
    }
  }, [apiBaseUrl, currentClaimIdentity, handleOwnerError, recordGuestOwnerChange, updatePhotoFlag]);

  const loadVisitPhoto = useCallback(async (placeId: string) => {
    const identity = currentClaimIdentity();
    const capturedEpoch = epochRef.current.capture();
    try {
      const photo = await loadVisitPhotoRequest(apiBaseUrl, claimOwner(identity), placeId);
      if (!epochRef.current.isCurrent(capturedEpoch) || !sameOwner(identityRef.current, identity)) {
        throw new Error("Your journal changed while loading this photo.");
      }
      return photo;
    } catch (error) {
      handleOwnerError(error, identity, capturedEpoch);
      throw error;
    }
  }, [apiBaseUrl, currentClaimIdentity, handleOwnerError]);

  const removeVisitPhoto = useCallback(async (placeId: string) => {
    const identity = currentClaimIdentity();
    const capturedEpoch = epochRef.current.capture();
    try {
      await removeVisitPhotoRequest(apiBaseUrl, claimOwner(identity), placeId);
      await recordGuestOwnerChange(identity);
      await updatePhotoFlag(identity, capturedEpoch, placeId, false);
    } catch (error) {
      handleOwnerError(error, identity, capturedEpoch);
      throw error;
    }
  }, [apiBaseUrl, currentClaimIdentity, handleOwnerError, recordGuestOwnerChange, updatePhotoFlag]);

  const resetProgress = useCallback(async () => {
    const identity = identityRef.current;
    if (transitionRef.current) throw new Error("Another account change is still in progress.");
    if (identity.kind !== "account" || !identity.account) throw new Error("Sign in before resetting progress.");
    transitionRef.current = true;
    setTransitionBusy(true);
    const capturedEpoch = epochRef.current.advance();
    const visitPending = accountVisitOutboxRef.current.snapshot();
    const trailPending = accountTrailOutboxRef.current.snapshot();
    try {
      await Promise.all([
        accountVisitOutboxRef.current.clearAndWait(),
        accountTrailOutboxRef.current.clearAndWait(),
      ]);
      await persistAccountOutboxes(identity.account.id);
      await resetAccountProgress(apiBaseUrl, identity.token);
      if (!epochRef.current.isCurrent(capturedEpoch)) return;
      updateProgress(new Set(), new Set(), {}, {});
      await persistAccount();
      setSyncMessage("Your progress has been reset.");
    } catch (error) {
      accountVisitOutboxRef.current.hydrate(visitPending);
      accountTrailOutboxRef.current.hydrate(trailPending);
      await persistAccountOutboxes(identity.account.id);
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
  }, [apiBaseUrl, expireAccount, persistAccount, persistAccountOutboxes, updateProgress]);

  useEffect(() => {
    if (syncMessage !== "Your progress has been reset.") return;
    const timeout = window.setTimeout(() => setSyncMessage(""), 4000);
    return () => window.clearTimeout(timeout);
  }, [syncMessage]);

  return {
    places,
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
    toggleVisit,
    toggleTrail,
    retrySync,
    authenticate,
    authenticateWithGoogle,
    changePassword,
    requestEmailVerification,
    confirmEmailVerification,
    logout,
    importGuest,
    resetProgress,
    recommendClaim,
    createClaim,
    uploadVisitPhoto,
    loadVisitPhoto,
    removeVisitPhoto,
  };
}
