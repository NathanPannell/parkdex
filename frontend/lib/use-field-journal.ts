"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  ACCOUNT_TOKEN_KEY,
  ApiError,
  authenticate as authenticateAccount,
  importGuestProgress,
  loadAccount,
  logout as logoutAccount,
  type Account,
  type Visit,
} from "./account";
import {
  IdentityEpoch,
  JOURNAL_STORAGE,
  accountPendingKey,
  getBrowserStorage,
  importedGuestKey,
  readStored,
  removeStored,
  toggledSet,
  writeRawStored,
  writeStored,
  type PendingSnapshot,
} from "./field-journal-state";
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
};

export type FieldJournal = {
  places: Place[];
  visited: Set<string>;
  completedTrails: Set<string>;
  visitTimestamps: Record<string, string>;
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
  logout: () => Promise<void>;
  importGuest: () => Promise<void>;
};

function hasEntries(outbox: VisitOutbox) {
  return outbox.hasPending();
}

const BLOCKED_STORAGE = {
  getItem: () => null,
  setItem: () => { throw new Error("Browser storage unavailable"); },
  removeItem: () => { throw new Error("Browser storage unavailable"); },
};

function timestampsFor(visits: Visit[] | undefined): Record<string, string> {
  return Object.fromEntries((visits ?? []).map((visit) => [visit.placeId, visit.visitedAt]));
}

async function responseError(response: Response, fallback: string): Promise<ApiError> {
  let message = fallback;
  try { message = (await response.json() as { detail?: string }).detail ?? fallback; } catch { /* fallback */ }
  return new ApiError(message, response.status);
}

export function useFieldJournal({ apiBaseUrl }: { apiBaseUrl: string }): FieldJournal {
  const [places, setPlaces] = useState<Place[]>([]);
  const [visited, setVisited] = useState<Set<string>>(new Set());
  const [completedTrails, setCompletedTrails] = useState<Set<string>>(new Set());
  const [visitTimestamps, setVisitTimestamps] = useState<Record<string, string>>({});
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
  const guestVisitOutboxRef = useRef(new VisitOutbox());
  const guestTrailOutboxRef = useRef(new VisitOutbox());
  const accountVisitOutboxRef = useRef(new VisitOutbox());
  const accountTrailOutboxRef = useRef(new VisitOutbox());
  const accountOutboxOwnerRef = useRef("");

  const noteStorageFailure = useCallback((success: boolean) => {
    if (!success) setStorageUnavailable(true);
    return success;
  }, []);

  const storage = useCallback(() => {
    return getBrowserStorage() ?? BLOCKED_STORAGE;
  }, []);

  const updateProgress = useCallback((nextVisited: Set<string>, nextTrails: Set<string>, nextVisitTimestamps = visitTimestampsRef.current) => {
    visitedRef.current = nextVisited;
    trailsRef.current = nextTrails;
    visitTimestampsRef.current = nextVisitTimestamps;
    setVisited(nextVisited);
    setCompletedTrails(nextTrails);
    setVisitTimestamps(nextVisitTimestamps);
  }, []);

  const persistGuest = useCallback(() => {
    const target = storage();
    if (identityRef.current.kind === "guest") {
      noteStorageFailure(writeStored(target, JOURNAL_STORAGE.guestVisited, [...visitedRef.current]));
      noteStorageFailure(writeStored(target, JOURNAL_STORAGE.guestVisitTimestamps, visitTimestampsRef.current));
      noteStorageFailure(writeStored(target, JOURNAL_STORAGE.guestTrails, [...trailsRef.current]));
    }
    noteStorageFailure(writeStored(target, JOURNAL_STORAGE.guestVisitPending, guestVisitOutboxRef.current.snapshot()));
    noteStorageFailure(writeStored(target, JOURNAL_STORAGE.guestTrailPending, guestTrailOutboxRef.current.snapshot()));
  }, [noteStorageFailure, storage]);

  const persistAccount = useCallback(() => {
    const identity = identityRef.current;
    if (identity.kind !== "account" || !identity.account) return;
    const target = storage();
    noteStorageFailure(writeStored(target, JOURNAL_STORAGE.accountSnapshot, {
      account: identity.account,
      visitedIds: [...visitedRef.current],
      completedTrailIds: [...trailsRef.current],
      visitTimestamps: visitTimestampsRef.current,
    } satisfies AccountSnapshot));
    noteStorageFailure(writeStored(target, accountPendingKey(identity.account.id, "visits"), accountVisitOutboxRef.current.snapshot()));
    noteStorageFailure(writeStored(target, accountPendingKey(identity.account.id, "trails"), accountTrailOutboxRef.current.snapshot()));
  }, [noteStorageFailure, storage]);

  const persistAccountOutboxes = useCallback((accountId: string) => {
    const target = storage();
    noteStorageFailure(writeStored(target, accountPendingKey(accountId, "visits"), accountVisitOutboxRef.current.snapshot()));
    noteStorageFailure(writeStored(target, accountPendingKey(accountId, "trails"), accountTrailOutboxRef.current.snapshot()));
  }, [noteStorageFailure, storage]);

  const hydrateAccountOutboxes = useCallback((accountId: string) => {
    if (accountOutboxOwnerRef.current === accountId) return;
    accountVisitOutboxRef.current = new VisitOutbox();
    accountTrailOutboxRef.current = new VisitOutbox();
    const target = storage();
    accountVisitOutboxRef.current.hydrate(readStored<PendingSnapshot>(target, accountPendingKey(accountId, "visits"), {}));
    accountTrailOutboxRef.current.hydrate(readStored<PendingSnapshot>(target, accountPendingKey(accountId, "trails"), {}));
    accountOutboxOwnerRef.current = accountId;
  }, [storage]);

  const guestHasProgress = useCallback(() => {
    const target = storage();
    return readStored<string[]>(target, JOURNAL_STORAGE.guestVisited, []).length > 0
      || readStored<string[]>(target, JOURNAL_STORAGE.guestTrails, []).length > 0
      || hasEntries(guestVisitOutboxRef.current)
      || hasEntries(guestTrailOutboxRef.current);
  }, [storage]);

  const guestWasImportedBy = useCallback((accountId: string) => {
    const target = storage();
    const currentRevision = readStored<number>(target, JOURNAL_STORAGE.guestRevision, 0);
    return readStored<number>(target, importedGuestKey(accountId), -1) === currentRevision;
  }, [storage]);

  const switchToGuest = useCallback((message = "") => {
    epochRef.current.advance();
    const target = storage();
    noteStorageFailure(removeStored(target, ACCOUNT_TOKEN_KEY));
    noteStorageFailure(removeStored(target, JOURNAL_STORAGE.accountSnapshot));
    const collectionKey = identityRef.current.kind === "guest"
      ? identityRef.current.collectionKey
      : readStored<string>(target, JOURNAL_STORAGE.collectionKey, "");
    identityRef.current = { kind: "guest", collectionKey };
    setAuthenticated(false);
    setAccount(null);
    const guestVisited = guestVisitOutboxRef.current.applyTo(readStored<string[]>(target, JOURNAL_STORAGE.guestVisited, []));
    const guestTrails = guestTrailOutboxRef.current.applyTo(readStored<string[]>(target, JOURNAL_STORAGE.guestTrails, []));
    updateProgress(guestVisited, guestTrails, readStored<Record<string, string>>(target, JOURNAL_STORAGE.guestVisitTimestamps, {}));
    setGuestProgressAvailable(guestHasProgress());
    if (message) setSyncMessage(message);
  }, [guestHasProgress, noteStorageFailure, storage, updateProgress]);

  const expireAccount = useCallback((capturedEpoch: number) => {
    if (!epochRef.current.isCurrent(capturedEpoch) || identityRef.current.kind !== "account") return;
    switchToGuest("Your session expired. Sign in again to continue syncing your account.");
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
    if (enabled && result.visitedAt) nextTimestamps[id] = result.visitedAt;
    if (!enabled) delete nextTimestamps[id];
    updateProgress(new Set(visitedRef.current), new Set(trailsRef.current), nextTimestamps);
  }, [apiBaseUrl, expireAccount, updateProgress]);

  const persistOutbox = useCallback((identity: Identity) => {
    if (identity.kind === "guest") {
      persistGuest();
    } else if (identity.account) {
      if (identityRef.current.kind === "account" && identityRef.current.account?.id === identity.account.id) persistAccount();
      else persistAccountOutboxes(identity.account.id);
    }
  }, [persistAccount, persistAccountOutboxes, persistGuest]);

  const drainIdentity = useCallback(async (identity: Identity, capturedEpoch: number) => {
    const visitBox = identity.kind === "guest" ? guestVisitOutboxRef.current : accountVisitOutboxRef.current;
    const trailBox = identity.kind === "guest" ? guestTrailOutboxRef.current : accountTrailOutboxRef.current;
    try {
      const results = await Promise.allSettled([
        visitBox.drainAll((id, enabled) => putProgress("visits", id, enabled, identity, capturedEpoch)),
        trailBox.drainAll((id, enabled) => putProgress("trails", id, enabled, identity, capturedEpoch)),
      ]);
      if (results.some((result) => result.status === "rejected")) throw new Error("Some checkoffs did not sync.");
    } finally {
      persistOutbox(identity);
    }
  }, [persistOutbox, putProgress]);

  const retrySync = useCallback(async () => {
    if (transitionRef.current) return;
    const identity = identityRef.current;
    if (identity.kind === "guest" && !identity.collectionKey) return;
    const visitBox = identity.kind === "guest" ? guestVisitOutboxRef.current : accountVisitOutboxRef.current;
    const trailBox = identity.kind === "guest" ? guestTrailOutboxRef.current : accountTrailOutboxRef.current;
    if (!visitBox.hasPending() && !trailBox.hasPending()) return;
    setSyncMessage("Syncing your latest checkoffs…");
    const capturedEpoch = epochRef.current.capture();
    try {
      await drainIdentity(identity, capturedEpoch);
      if (epochRef.current.isCurrent(capturedEpoch)) setSyncMessage("");
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 401)) {
        setSyncMessage(identity.kind === "account"
          ? "Your account checkoffs are saved on this device and waiting to sync."
          : "Your guest checkoffs are saved on this device and waiting to sync.");
      }
    }
  }, [drainIdentity]);

  useEffect(() => {
    let active = true;
    const epoch = epochRef.current;
    const target = storage();
    guestVisitOutboxRef.current = new VisitOutbox();
    guestTrailOutboxRef.current = new VisitOutbox();
    guestVisitOutboxRef.current.hydrate(readStored<PendingSnapshot>(target, JOURNAL_STORAGE.guestVisitPending, {}));
    guestTrailOutboxRef.current.hydrate(readStored<PendingSnapshot>(target, JOURNAL_STORAGE.guestTrailPending, {}));

    let collectionKey = readStored<string>(target, JOURNAL_STORAGE.collectionKey, "");
    let initialStorageAvailable = target !== BLOCKED_STORAGE;
    if (!collectionKey) {
      collectionKey = createCollectionKey();
      initialStorageAvailable = writeRawStored(target, JOURNAL_STORAGE.collectionKey, collectionKey);
    }
    const guestVisited = guestVisitOutboxRef.current.applyTo(readStored<string[]>(target, JOURNAL_STORAGE.guestVisited, []));
    const guestTrails = guestTrailOutboxRef.current.applyTo(readStored<string[]>(target, JOURNAL_STORAGE.guestTrails, []));
    const guestVisitTimestamps = readStored<Record<string, string>>(target, JOURNAL_STORAGE.guestVisitTimestamps, {});
    const cachedPlaces = readStored<Place[]>(target, JOURNAL_STORAGE.places, []);

    let savedToken = "";
    try { savedToken = target.getItem(ACCOUNT_TOKEN_KEY) ?? ""; } catch { initialStorageAvailable = false; }
    const cachedAccount = readStored<AccountSnapshot | null>(target, JOURNAL_STORAGE.accountSnapshot, null);
    let initialVisited = guestVisited;
    let initialTrails = guestTrails;
    let initialVisitTimestamps = guestVisitTimestamps;
    if (savedToken) {
      identityRef.current = { kind: "account", token: savedToken, account: cachedAccount?.account ?? null };
      if (cachedAccount) {
        hydrateAccountOutboxes(cachedAccount.account.id);
        initialVisited = accountVisitOutboxRef.current.applyTo(cachedAccount.visitedIds);
        initialTrails = accountTrailOutboxRef.current.applyTo(cachedAccount.completedTrailIds);
        initialVisitTimestamps = cachedAccount.visitTimestamps ?? {};
      } else {
        initialVisited = new Set();
        initialTrails = new Set();
        initialVisitTimestamps = {};
      }
    } else {
      identityRef.current = { kind: "guest", collectionKey };
    }

    void (async () => {
      if (cachedPlaces.length) setPlaces(cachedPlaces);
      setAuthenticated(Boolean(savedToken));
      setAccount(savedToken ? cachedAccount?.account ?? null : null);
      updateProgress(initialVisited, initialTrails, initialVisitTimestamps);
      setGuestProgressAvailable(guestHasProgress() && (!cachedAccount || !guestWasImportedBy(cachedAccount.account.id)));
      if (!initialStorageAvailable) setStorageUnavailable(true);
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
          hydrateAccountOutboxes(session.account.id);
          identityRef.current = { kind: "account", token: savedToken, account: session.account };
          setAccount(session.account);
          setGuestProgressAvailable(guestHasProgress() && !guestWasImportedBy(session.account.id));
          updateProgress(
            accountVisitOutboxRef.current.applyTo(session.visitedIds),
            accountTrailOutboxRef.current.applyTo(session.completedTrailIds),
            timestampsFor(session.visits),
          );
          persistAccount();
        } catch (error) {
          if (!active || !epochRef.current.isCurrent(accountEpoch)) return;
          if (error instanceof ApiError && error.status === 401) {
            savedToken = "";
            switchToGuest("Your session expired. Sign in again to continue syncing your account.");
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
        updateProgress(nextVisited, nextTrails, timestampsFor(payload.visits));
        noteStorageFailure(writeStored(target, JOURNAL_STORAGE.places, payload.places));
        if (identity.kind === "guest") persistGuest(); else persistAccount();
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
    })();

    return () => { active = false; epoch.advance(); };
  }, [apiBaseUrl, expireAccount, guestHasProgress, guestWasImportedBy, hydrateAccountOutboxes, noteStorageFailure, persistAccount, persistGuest, storage, switchToGuest, updateProgress]);

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
    const outbox = kind === "visits"
      ? identity.kind === "guest" ? guestVisitOutboxRef.current : accountVisitOutboxRef.current
      : identity.kind === "guest" ? guestTrailOutboxRef.current : accountTrailOutboxRef.current;
    outbox.setDesired(id, enabled);
    if (identity.kind === "guest") {
      const target = storage();
      const revision = readStored<number>(target, JOURNAL_STORAGE.guestRevision, 0) + 1;
      noteStorageFailure(writeStored(target, JOURNAL_STORAGE.guestRevision, revision));
      setGuestProgressAvailable(true);
    }
    persistOutbox(identity);
    setSyncMessage("");
    const capturedEpoch = epochRef.current.capture();
    try {
      await outbox.drain(id, (pendingId, pendingValue) => putProgress(kind, pendingId, pendingValue, identity, capturedEpoch));
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 401)) {
        setSyncMessage(identity.kind === "account"
          ? "Your account checkoff is saved on this device and waiting to sync."
          : "Your guest checkoff is saved on this device and waiting to sync.");
      }
    } finally {
      persistOutbox(identity);
    }
  }, [noteStorageFailure, persistOutbox, putProgress, storage, updateProgress]);

  const toggleVisit = useCallback((placeOrId: Pick<Place, "id"> | string) => {
    return toggle("visits", typeof placeOrId === "string" ? placeOrId : placeOrId.id);
  }, [toggle]);

  const toggleTrail = useCallback((trailId: string) => toggle("trails", trailId), [toggle]);

  const authenticate = useCallback(async (mode: "login" | "register", email: string, password: string) => {
    if (transitionRef.current) return;
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
      hydrateAccountOutboxes(session.account.id);
      const identity: Identity = { kind: "account", token: session.token, account: session.account };
      identityRef.current = identity;
      noteStorageFailure(writeRawStored(storage(), ACCOUNT_TOKEN_KEY, session.token));
      setAuthenticated(true);
      setAccount(session.account);
      updateProgress(
        accountVisitOutboxRef.current.applyTo(session.visitedIds),
        accountTrailOutboxRef.current.applyTo(session.completedTrailIds),
        timestampsFor(session.visits),
      );
      persistAccount();
      setGuestProgressAvailable(guestHasProgress() && !guestWasImportedBy(session.account.id));
      setSyncMessage("");
      try {
        await drainIdentity(identity, capturedEpoch);
      } catch (error) {
        if (!(error instanceof ApiError && error.status === 401)) {
          setSyncMessage("Your account checkoffs are saved on this device and waiting to sync.");
        }
      }
    } finally {
      transitionRef.current = false;
      setTransitionBusy(false);
    }
  }, [apiBaseUrl, drainIdentity, guestHasProgress, guestWasImportedBy, hydrateAccountOutboxes, noteStorageFailure, persistAccount, storage, updateProgress]);

  const logout = useCallback(async () => {
    if (transitionRef.current || identityRef.current.kind !== "account") return;
    transitionRef.current = true;
    setTransitionBusy(true);
    const identity = identityRef.current;
    epochRef.current.advance();
    try {
      await logoutAccount(apiBaseUrl, identity.token);
      switchToGuest();
      setSyncMessage("");
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        switchToGuest("Your session had already expired. You are signed out.");
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
    const collectionKey = readStored<string>(target, JOURNAL_STORAGE.collectionKey, "");
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
      updateProgress(new Set(result.visitedIds), new Set(result.completedTrailIds), timestampsFor(result.visits));
      persistAccount();
      const revision = readStored<number>(target, JOURNAL_STORAGE.guestRevision, 0);
      if (accountIdentity.account) noteStorageFailure(writeStored(target, importedGuestKey(accountIdentity.account.id), revision));
      setGuestProgressAvailable(false);
      setSyncMessage(`Added ${result.importedVisitCount} guest places and ${result.importedTrailCount} trail checkoffs.`);
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

  return {
    places,
    visited,
    completedTrails,
    visitTimestamps,
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
    logout,
    importGuest,
  };
}
