"use client";

import { networkErrorMessage } from "./network-error";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { readStored, removeStored, writeStored } from "./field-journal-state";
import type { Place, PlaceCatalogueSummary } from "./places";
import { GroupOutbox } from "./group-outbox";
import { addGroupPlace, createGroup, deleteGroup, GroupsApiError, listGroups, normalizeGroups, removeGroupPlace, updateGroup, type AuthenticatedRequest, type Group } from "./groups";
import { getPlatformStorage, type KeyValueStore } from "./platform-storage";

export type GroupSyncStatus = "idle" | "syncing" | "offline" | "error";

const GROUPS_FETCH_RETRY_INITIAL_DELAY_MS = 1_000;
const GROUPS_FETCH_RETRY_MAX_DELAY_MS = 30_000;
const GROUP_RESET_PREPARATION_TIMEOUT_MS = 15_000;

/** Versioned account-scoped keys keep cached private data separate from guest data. */
export function accountGroupsCacheKey(accountId: string) {
  return `every-park:account-groups:${encodeURIComponent(accountId)}:v1`;
}

export function accountGroupsOutboxKey(accountId: string) {
  return `every-park:account-group-memberships:${encodeURIComponent(accountId)}:v1`;
}

export function accountGroupsResetKey(accountId: string) {
  return `every-park:account-groups-reset:${encodeURIComponent(accountId)}:v1`;
}

type GroupResetBarrier = { phase: "prepared" | "committed" };

type GroupState = {
  groups: Group[];
  selectedGroupId: string | null;
  loading: boolean;
  retrying: boolean;
  error: string;
  busy: boolean;
  /** True when the browser/API is currently unable to reach the groups service. */
  offline: boolean;
  syncStatus: GroupSyncStatus;
  syncMessage: string;
  /** Number of distinct group/place desired states still awaiting acknowledgement. */
  pendingMemberships: number;
  resetPreparationPending: boolean;
  resetCancellationAllowed: boolean;
  resetCleanupRequired: boolean;
  selectGroup: (id: string | null) => void;
  retry: () => Promise<void>;
  prepareForReset: () => Promise<void>;
  cancelResetPreparation: () => Promise<void>;
  refreshAfterReset: () => Promise<void>;
  create: (name: string, placeIds: string[]) => Promise<Group | null>;
  rename: (id: string, name: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  addPlace: (groupId: string, placeId: string) => Promise<void>;
  removePlace: (groupId: string, placeId: string) => Promise<void>;
};

function messageFor(error: unknown) {
  return networkErrorMessage(error, "load your collections");
}

function browserIsOffline() {
  return typeof navigator !== "undefined" && navigator.onLine === false;
}

function isOfflineFailure(error: unknown) {
  // A failed fetch is normally a TypeError. navigator.onLine also covers
  // mocked/native WebView network transitions where fetch may reject with a
  // platform-specific error type.
  return browserIsOffline() || error instanceof TypeError;
}

function isPermanentlyInvalidMembership(error: unknown) {
  // These responses describe an intent that cannot become valid by retrying:
  // the group is gone, or the place/group payload is invalid. Authentication,
  // conflicts, throttling, request timeouts, and server failures stay queued.
  return error instanceof GroupsApiError && [400, 404, 410, 422].includes(error.status);
}

function isMissingGroup(error: unknown) {
  return error instanceof GroupsApiError && [404, 410].includes(error.status);
}

function isGroupResetBarrier(value: unknown): value is GroupResetBarrier {
  return Boolean(value && typeof value === "object" && "phase" in value && (value.phase === "prepared" || value.phase === "committed"));
}

function withTimeout<T>(promise: Promise<T>, milliseconds: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(message)), milliseconds);
    promise.then(
      (value) => { window.clearTimeout(timer); resolve(value); },
      (error: unknown) => { window.clearTimeout(timer); reject(error); },
    );
  });
}

function compactGroup(group: Group) {
  const placeIds = [...new Set((group.placeIds ?? group.places.map((place) => place.id)).filter((id): id is string => typeof id === "string"))];
  return {
    id: group.id,
    name: group.name,
    ...(group.isWishlist ? { isWishlist: true } : {}),
    placeIds,
    places: group.places.map(compactPlace),
    ...(group.createdAt ? { createdAt: group.createdAt } : {}),
    ...(group.updatedAt ? { updatedAt: group.updatedAt } : {}),
  };
}

function compactPlace(place: Place): PlaceCatalogueSummary {
  const summary = { ...place };
  delete summary.visitorDetails;
  return summary;
}

function compactGroups(groups: Group[]) {
  return groups.map(compactGroup);
}

function placeIdsFor(group: Group) {
  return [...new Set((group.placeIds ?? group.places.map((place) => place.id)).filter((id): id is string => typeof id === "string"))];
}

function withMembership(group: Group, placeId: string, included: boolean): Group {
  const placeIds = placeIdsFor(group);
  const nextIds = included
    ? [...new Set([...placeIds, placeId])]
    : placeIds.filter((id) => id !== placeId);
  return { ...group, placeIds: nextIds };
}

function withMembershipInGroups(groups: Group[], groupId: string, placeId: string, included: boolean) {
  return groups.map((group) => group.id === groupId ? withMembership(group, placeId, included) : group);
}

export function useGroups({ apiBaseUrl, authenticated, identityKey = "", places, request }: { apiBaseUrl: string; authenticated: boolean; identityKey?: string; places: Place[]; request?: AuthenticatedRequest }): GroupState {
  const [groups, setGroups] = useState<Group[]>([]);
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [offline, setOffline] = useState(browserIsOffline);
  const [syncStatus, setSyncStatus] = useState<GroupSyncStatus>(browserIsOffline() ? "offline" : "idle");
  const [syncMessage, setSyncMessage] = useState("");
  const [pendingMemberships, setPendingMemberships] = useState(0);
  const [resetPreparationPending, setResetPreparationPending] = useState(false);
  const [resetCancellationAllowed, setResetCancellationAllowed] = useState(false);
  const [resetCleanupRequired, setResetCleanupRequired] = useState(false);
  const epochRef = useRef(0);
  const requestRef = useRef(request);
  const groupsRef = useRef<Group[]>([]);
  const groupsOwnerRef = useRef("");
  const [groupsOwner, setGroupsOwner] = useState("");
  const outboxRef = useRef(new GroupOutbox());
  const outboxOwnerRef = useRef("");
  const resetBarrierRef = useRef<GroupResetBarrier | null>(null);
  const resetOwnerRef = useRef("");
  const resetGateRef = useRef(false);
  const resetCancellationAllowedRef = useRef(false);
  const activeGroupOperationsRef = useRef(new Set<Promise<void>>());
  const storageRef = useRef<KeyValueStore | null>(null);
  const fetchRetryTimerRef = useRef<{ handle: number; resolve: () => void } | null>(null);
  useEffect(() => { requestRef.current = request; }, [request]);

  const cancelFetchRetry = useCallback(() => {
    const timer = fetchRetryTimerRef.current;
    if (!timer) return;
    fetchRetryTimerRef.current = null;
    window.clearTimeout(timer.handle);
    timer.resolve();
  }, []);

  const waitForFetchRetry = useCallback((delay: number) => new Promise<void>((resolve) => {
    const handle = window.setTimeout(() => {
      if (fetchRetryTimerRef.current?.handle === handle) fetchRetryTimerRef.current = null;
      resolve();
    }, delay);
    fetchRetryTimerRef.current = { handle, resolve };
  }), []);

  const storage = useCallback(async () => {
    if (storageRef.current) return storageRef.current;
    const target = await getPlatformStorage();
    storageRef.current = target;
    return target;
  }, []);

  const trackGroupOperation = useCallback(<T,>(operation: Promise<T>) => {
    const settled = operation.then(() => undefined, () => undefined);
    activeGroupOperationsRef.current.add(settled);
    void settled.then(() => activeGroupOperationsRef.current.delete(settled));
    return operation;
  }, []);

  const persistSnapshot = useCallback(async (accountId: string, next: Group[]) => {
    if (!accountId) return false;
    return await writeStored(await storage(), accountGroupsCacheKey(accountId), compactGroups(next));
  }, [storage]);

  const persistOutbox = useCallback(async (accountId: string, outbox: GroupOutbox) => {
    if (!accountId) return false;
    return await writeStored(await storage(), accountGroupsOutboxKey(accountId), outbox.snapshot());
  }, [storage]);

  const setCurrentGroups = useCallback((next: Group[], owner = identityKey) => {
    groupsRef.current = next;
    groupsOwnerRef.current = owner;
    setGroupsOwner(owner);
    setGroups(next);
  }, [identityKey]);

  const hydrateOutbox = useCallback(async (accountId: string, epoch = epochRef.current) => {
    if (outboxOwnerRef.current === accountId) return outboxRef.current;
    const next = new GroupOutbox();
    next.hydrate(await readStored<unknown>(await storage(), accountGroupsOutboxKey(accountId), {}));
    if (epoch !== epochRef.current) return null;
    outboxRef.current = next;
    outboxOwnerRef.current = accountId;
    setPendingMemberships(next.pendingCount());
    return next;
  }, [storage]);

  const clearCommittedResetArtifacts = useCallback(async (accountId: string) => {
    // The committed marker is the safety barrier. Remove both stale snapshots
    // independently, and remove the barrier only after both removals succeed.
    // A failed cache removal must never short-circuit outbox cleanup.
    const target = await storage();
    outboxRef.current = new GroupOutbox();
    outboxOwnerRef.current = accountId;
    setPendingMemberships(0);
    const [cacheRemoved, outboxRemoved] = await Promise.all([
      removeStored(target, accountGroupsCacheKey(accountId)),
      removeStored(target, accountGroupsOutboxKey(accountId)),
    ]);
    if (!cacheRemoved || !outboxRemoved) {
      throw new Error("Private device storage could not finish clearing the saved collections.");
    }
    if (!await removeStored(target, accountGroupsResetKey(accountId))) {
      throw new Error("Private device storage could not finish clearing the saved collections.");
    }
    if (resetOwnerRef.current === accountId) {
      resetBarrierRef.current = null;
      resetGateRef.current = false;
      setResetPreparationPending(false);
      setResetCancellationAllowed(false);
      resetCancellationAllowedRef.current = false;
      setResetCleanupRequired(false);
    }
  }, [storage]);

  const hydrate = useCallback((items: Group[]) => items.map((group) => {
    const placeIds = placeIdsFor(group);
    const groupPlaces = new Map(group.places.map((place) => [place.id, place]));
    const included = new Set<string>();
    const hydratedPlaces: Place[] = [];

    // The groups API returns its own place objects. Keep them as the source of
    // truth so sampling the global catalogue cannot erase collection members.
    for (const placeId of placeIds) {
      const place = groupPlaces.get(placeId) ?? places.find((candidate) => candidate.id === placeId);
      if (!place || included.has(place.id)) continue;
      hydratedPlaces.push(place);
      included.add(place.id);
    }
    // Retain API-provided objects even when a server response has an incomplete
    // placeIds list. The ID list remains useful for pending membership updates.
    for (const place of group.places) {
      if (included.has(place.id)) continue;
      hydratedPlaces.push(place);
      included.add(place.id);
    }

    return { ...group, placeIds, places: hydratedPlaces };
  }), [places]);

  const sendMembership = useCallback(async (
    accountId: string,
    epoch: number,
    currentRequest: AuthenticatedRequest,
    outbox: GroupOutbox,
    groupId: string,
    placeId: string,
    included: boolean,
  ) => {
    // Do not let a stale drain accidentally use the request function after an
    // account switch. Throwing retains the entry for that account's next run.
    if (epoch !== epochRef.current || accountId !== identityKey) throw new Error("Collection identity changed while syncing.");
    const result = included
      ? await addGroupPlace(currentRequest, groupId, placeId)
      : await removeGroupPlace(currentRequest, groupId, placeId);
    if (epoch !== epochRef.current || accountId !== identityKey) return;
    const rebased = outbox.applyTo([result])[0] ?? result;
    const next = groupsRef.current.some((group) => group.id === rebased.id)
      ? groupsRef.current.map((group) => group.id === rebased.id ? rebased : group)
      : [...groupsRef.current, rebased];
    setCurrentGroups(next, accountId);
    if (!await persistSnapshot(accountId, next)) {
      throw new Error("Private device storage could not save the synced collections.");
    }
  }, [identityKey, persistSnapshot, setCurrentGroups]);

  const reconcileGroups = useCallback(async (
    accountId: string,
    epoch: number,
    currentRequest: AuthenticatedRequest,
    outbox: GroupOutbox,
  ) => {
    if (epoch !== epochRef.current || accountId !== identityKey) return;
    const checkpoint = outbox.checkpoint();
    const authoritative = await listGroups(currentRequest);
    if (epoch !== epochRef.current || accountId !== identityKey) return;
    const rebased = outbox.applyTo(authoritative, checkpoint);
    setCurrentGroups(rebased, accountId);
    setSelectedGroupId((current) => current && rebased.some((group) => group.id === current) ? current : null);
    if (!await persistSnapshot(accountId, rebased) || !await persistOutbox(accountId, outbox)) {
      throw new Error("Private device storage could not save your refreshed collections.");
    }
    setPendingMemberships(outbox.pendingCount());
    setOffline(false);
    setError("");
    setSyncStatus(outbox.hasPending() ? "syncing" : "idle");
    setSyncMessage(outbox.hasPending() ? "Your newer collection changes are saved on this device and waiting to sync." : "");
  }, [identityKey, persistOutbox, persistSnapshot, setCurrentGroups]);

  const drainOutbox = useCallback(async (accountId: string, epoch: number, currentRequest = requestRef.current) => {
    if (outboxOwnerRef.current !== accountId) return;
    const outbox = outboxRef.current;
    setPendingMemberships(outbox.pendingCount());
    if (!outbox.hasPending()) {
      if (epoch === epochRef.current && accountId === identityKey) {
        setOffline(false);
        setSyncStatus("idle");
        setSyncMessage("");
      }
      return;
    }
    if (!apiBaseUrl || browserIsOffline() || !currentRequest) {
      if (epoch === epochRef.current && accountId === identityKey) {
        setOffline(true);
        setSyncStatus("offline");
        setSyncMessage("Your collection changes are saved on this device and waiting to sync.");
      }
      await persistOutbox(accountId, outbox);
      return;
    }
    if (epoch === epochRef.current && accountId === identityKey) {
      setOffline(false);
      setSyncStatus("syncing");
    }
    try {
      await outbox.drainAll(
        (groupId, placeId, included) => sendMembership(accountId, epoch, currentRequest, outbox, groupId, placeId, included),
        { discardOnError: isPermanentlyInvalidMembership },
      );
      if (!await persistOutbox(accountId, outbox)) {
        throw new Error("Private device storage could not save the collection changes.");
      }
      setPendingMemberships(outbox.pendingCount());
      if (epoch === epochRef.current && accountId === identityKey) {
        setOffline(false);
        setSyncStatus(outbox.hasPending() ? "syncing" : "idle");
        if (!outbox.hasPending()) setSyncMessage("");
      }
    } catch (caught) {
      let outboxStored = false;
      try { outboxStored = await persistOutbox(accountId, outbox); } catch { /* report below */ }
      setPendingMemberships(outbox.pendingCount());
      if (outboxStored && isPermanentlyInvalidMembership(caught)) {
        try {
          await reconcileGroups(accountId, epoch, currentRequest, outbox);
          return;
        } catch (refreshError) {
          caught = refreshError;
        }
      }
      if (epoch === epochRef.current && accountId === identityKey) {
        if (!outboxStored) {
          setSyncStatus("error");
          setError("Private device storage could not save your pending collection changes.");
          setSyncMessage("Keep Parkdex open and try again before leaving this page.");
        } else if (isOfflineFailure(caught)) {
          setOffline(true);
          setSyncStatus("offline");
          setSyncMessage("Your collection changes are saved on this device and waiting to sync.");
        } else {
          setSyncStatus("error");
          setError(messageFor(caught));
          setSyncMessage("Your collection changes are saved on this device and waiting to sync.");
        }
      }
      throw caught;
    }
  }, [apiBaseUrl, identityKey, persistOutbox, reconcileGroups, sendMembership]);

  const load = useCallback(async () => {
    const accountId = identityKey;
    const currentRequest = requestRef.current;
    if (resetOwnerRef.current && resetOwnerRef.current !== accountId) {
      resetOwnerRef.current = accountId;
      resetBarrierRef.current = null;
      resetGateRef.current = false;
      setResetPreparationPending(false);
      setResetCancellationAllowed(false);
      resetCancellationAllowedRef.current = false;
      setResetCleanupRequired(false);
    } else if (!resetOwnerRef.current) {
      resetOwnerRef.current = accountId;
    }
    if (resetGateRef.current && resetOwnerRef.current === accountId && resetBarrierRef.current?.phase === "prepared") {
      setCurrentGroups([], accountId);
      setSelectedGroupId(null);
      setPendingMemberships(0);
      setLoading(false);
      setBusy(false);
      setResetPreparationPending(true);
      setSyncStatus("error");
      setSyncMessage("A progress reset needs to be finished before collection changes can resume.");
      return;
    }
    const epoch = ++epochRef.current;
    cancelFetchRetry();
    setRetrying(false);
    if (!authenticated || !accountId) {
      setCurrentGroups([], accountId);
      setSelectedGroupId(null);
      setPendingMemberships(0);
      setLoading(false);
      setBusy(false);
      setError("");
      setSyncMessage("");
      setSyncStatus("idle");
      setOffline(browserIsOffline());
      return;
    }
    setLoading(Boolean(apiBaseUrl && !browserIsOffline() && currentRequest));

    let outbox: GroupOutbox;
    let cached: Group[];
    try {
      const target = await storage();
      const persistedBarrier = await readStored<unknown>(target, accountGroupsResetKey(accountId), null);
      if (epoch !== epochRef.current) return;
      if (isGroupResetBarrier(persistedBarrier)) {
        resetBarrierRef.current = persistedBarrier;
        resetOwnerRef.current = accountId;
        resetGateRef.current = true;
        setCurrentGroups([], accountId);
        setSelectedGroupId(null);
        setPendingMemberships(0);
        setBusy(false);
        if (persistedBarrier.phase === "prepared") {
          setResetPreparationPending(true);
          setResetCancellationAllowed(false);
          setResetCleanupRequired(false);
          setLoading(false);
          setError("");
          setSyncStatus("error");
          setSyncMessage("A progress reset needs to be finished before collection changes can resume.");
          return;
        }
        setResetPreparationPending(false);
        setResetCancellationAllowed(false);
        resetCancellationAllowedRef.current = false;
        setResetCleanupRequired(true);
        setLoading(false);
        setError("");
        setSyncStatus("syncing");
        setSyncMessage("Saved collections are being cleared after the progress reset.");
        try {
          await clearCommittedResetArtifacts(accountId);
        } catch (cleanupError) {
          if (epoch !== epochRef.current) return;
          setLoading(false);
          setError(cleanupError instanceof Error ? cleanupError.message : "Saved collection cleanup is still pending.");
          setSyncStatus("error");
          setSyncMessage("Saved collection cleanup is still pending.");
          return;
        }
      }
      const hydrated = await hydrateOutbox(accountId, epoch);
      if (!hydrated || epoch !== epochRef.current) return;
      outbox = hydrated;
      cached = normalizeGroups(await readStored<unknown>(await storage(), accountGroupsCacheKey(accountId), []));
    } catch {
      if (epoch !== epochRef.current) return;
      setCurrentGroups([], accountId);
      setPendingMemberships(0);
      setLoading(false);
      setBusy(false);
      setOffline(browserIsOffline() || !apiBaseUrl);
      setSyncStatus("error");
      setError("Private device storage could not open your saved collections.");
      setSyncMessage("Restart Parkdex and try again.");
      return;
    }
    const cachedWithPending = outbox.applyTo(cached);
    if (epoch !== epochRef.current) return;
    setCurrentGroups(cachedWithPending, accountId);
    setSelectedGroupId((current) => current && cachedWithPending.some((group) => group.id === current) ? current : null);
    const unavailable = !apiBaseUrl || browserIsOffline() || !currentRequest;
    setOffline(unavailable);
    setLoading(!unavailable);
    setError("");
    setSyncStatus(unavailable ? "offline" : "syncing");
    if (unavailable) {
      setSyncMessage(outbox.hasPending()
        ? "Your collection changes are saved on this device and waiting to sync."
        : cached.length ? "Showing your saved collections offline." : "Your collections are unavailable offline.");
      await persistOutbox(accountId, outbox);
      return;
    }

    const checkpoint = outbox.checkpoint();
    let hadFetchFailure = false;
    try {
      let next: Group[];
      let retryAttempt = 0;
      while (true) {
        try {
          next = await listGroups(currentRequest);
          break;
        } catch {
          if (epoch !== epochRef.current) return;
          if (!hadFetchFailure) {
            hadFetchFailure = true;
            setRetrying(true);
            setLoading(false);
          }
          if (browserIsOffline()) {
            setOffline(true);
            setSyncStatus("offline");
            setSyncMessage(outbox.hasPending()
              ? "Your collection changes are saved on this device and waiting to sync."
              : cached.length ? "Showing your saved collections offline." : "Your collections are unavailable offline.");
          } else if (outbox.hasPending()) {
            setOffline(false);
            setSyncStatus("syncing");
            setSyncMessage("Your collection changes are saved on this device and waiting to sync.");
          } else {
            setOffline(false);
            setSyncStatus("idle");
            setSyncMessage("");
          }
          const delay = Math.min(
            GROUPS_FETCH_RETRY_INITIAL_DELAY_MS * 2 ** retryAttempt,
            GROUPS_FETCH_RETRY_MAX_DELAY_MS,
          );
          retryAttempt += 1;
          await waitForFetchRetry(delay);
          if (epoch !== epochRef.current) return;
        }
      }
      if (epoch !== epochRef.current) return;
      const rebased = outbox.applyTo(next, checkpoint);
      setCurrentGroups(rebased, accountId);
      setSelectedGroupId((current) => current && rebased.some((group) => group.id === current) ? current : null);
      setRetrying(false);
      if (!await persistSnapshot(accountId, rebased) || !await persistOutbox(accountId, outbox)) {
        throw new Error("Private device storage could not save your collections.");
      }
      setOffline(false);
      setError("");
      await drainOutbox(accountId, epoch, currentRequest);
    } catch (caught) {
      if (epoch !== epochRef.current) return;
      const nowOffline = isOfflineFailure(caught);
      setOffline(nowOffline);
      setSyncStatus(nowOffline ? "offline" : "error");
      // Collection list requests retry above. Errors here come from persisting
      // the successful response or syncing queued changes and stay actionable.
      setError(nowOffline ? "" : messageFor(caught));
      setSyncMessage(nowOffline
        ? outbox.hasPending() ? "Your collection changes are saved on this device and waiting to sync." : cached.length ? "Showing your saved collections offline." : "Your collections are unavailable offline."
        : "");
    } finally {
      if (epoch === epochRef.current) {
        setLoading(false);
        setBusy(false);
      }
    }
  }, [apiBaseUrl, authenticated, cancelFetchRetry, clearCommittedResetArtifacts, drainOutbox, hydrateOutbox, identityKey, persistOutbox, persistSnapshot, setCurrentGroups, storage, waitForFetchRetry]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => { window.clearTimeout(timer); epochRef.current += 1; cancelFetchRetry(); setRetrying(false); };
  }, [cancelFetchRetry, load]);

  useEffect(() => {
    const becameOffline = () => {
      setOffline(true);
      setSyncStatus("offline");
      if (outboxRef.current.hasPending()) setSyncMessage("Your collection changes are saved on this device and waiting to sync.");
    };
    const cameOnline = () => {
      setOffline(false);
      void load();
    };
    window.addEventListener("offline", becameOffline);
    window.addEventListener("online", cameOnline);
    return () => {
      window.removeEventListener("offline", becameOffline);
      window.removeEventListener("online", cameOnline);
    };
  }, [load]);

  const mutate = useCallback(async (operation: (request: AuthenticatedRequest) => Promise<Group | void>) => {
    if (resetGateRef.current) throw new Error("Collection changes are paused while progress is being reset.");
    if (!apiBaseUrl || offline || browserIsOffline()) {
      setOffline(true);
      setSyncStatus("offline");
      throw new Error("Creating, renaming, or deleting collections requires an online connection.");
    }
    const currentRequest = requestRef.current;
    if (!currentRequest) throw new Error("Sign in to manage collections.");
    const epoch = epochRef.current;
    const accountId = identityKey;
    setBusy(true);
    setError("");
    try {
      const result = await operation(currentRequest);
      if (epoch !== epochRef.current || accountId !== identityKey) return undefined;
      if (result) {
        const next = groupsRef.current.some((group) => group.id === result.id)
          ? groupsRef.current.map((group) => group.id === result.id ? result : group)
          : [...groupsRef.current, result];
        setCurrentGroups(next, accountId);
        if (!await persistSnapshot(accountId, next)) {
          throw new Error("Private device storage could not save your collections.");
        }
      }
      return result;
    } catch (caught) {
      if (epoch === epochRef.current && accountId === identityKey) {
        setError(messageFor(caught));
        setSyncStatus(isOfflineFailure(caught) ? "offline" : "error");
        if (isOfflineFailure(caught)) setOffline(true);
      }
      throw caught;
    } finally {
      if (epoch === epochRef.current && accountId === identityKey) setBusy(false);
    }
  }, [apiBaseUrl, identityKey, offline, persistSnapshot, setCurrentGroups]);

  const create = useCallback((name: string, placeIds: string[]) => trackGroupOperation((async () => {
    const result = await mutate((currentRequest) => createGroup(currentRequest, name, placeIds));
    if (result) setSelectedGroupId(result.id);
    return result ?? null;
  })()), [mutate, trackGroupOperation]);

  const rename = useCallback((id: string, name: string) => trackGroupOperation((async () => {
    try {
      await mutate((currentRequest) => updateGroup(currentRequest, id, name));
    } catch (caught) {
      if (isMissingGroup(caught)) {
        const accountId = identityKey;
        const epoch = epochRef.current;
        const currentRequest = requestRef.current;
        const outbox = currentRequest ? await hydrateOutbox(accountId, epoch) : null;
        if (currentRequest && outbox) await reconcileGroups(accountId, epoch, currentRequest, outbox);
      }
      throw caught;
    }
  })()), [hydrateOutbox, identityKey, mutate, reconcileGroups, trackGroupOperation]);

  const remove = useCallback((id: string) => trackGroupOperation((async () => {
    const accountId = identityKey;
    const epoch = epochRef.current;
    try {
      await mutate((currentRequest) => deleteGroup(currentRequest, id));
    } catch (caught) {
      // Deleting a group that another device already removed is idempotent.
      // Reconcile the local snapshot, then continue clearing any local intents.
      if (!isMissingGroup(caught)) throw caught;
      const currentRequest = requestRef.current;
      const currentOutbox = currentRequest ? await hydrateOutbox(accountId, epoch) : null;
      if (currentRequest && currentOutbox) await reconcileGroups(accountId, epoch, currentRequest, currentOutbox);
    }
    if (epoch === epochRef.current && accountId === identityKey) {
      const outbox = await hydrateOutbox(accountId, epoch);
      if (!outbox) return;
      outbox.clearGroup(id);
      if (!await persistOutbox(accountId, outbox)) throw new Error("Private device storage could not clear the collection changes.");
      const next = groupsRef.current.filter((group) => group.id !== id);
      setCurrentGroups(next, accountId);
      if (!await persistSnapshot(accountId, next)) throw new Error("Private device storage could not save your collections.");
      if (selectedGroupId === id) setSelectedGroupId(null);
      setPendingMemberships(outbox.pendingCount());
    }
  })()), [hydrateOutbox, identityKey, mutate, persistOutbox, persistSnapshot, reconcileGroups, selectedGroupId, setCurrentGroups, trackGroupOperation]);

  const changeMembership = useCallback((groupId: string, placeId: string, included: boolean) => trackGroupOperation((async () => {
    if (resetGateRef.current) throw new Error("Collection changes are paused while progress is being reset.");
    const accountId = identityKey;
    const epoch = epochRef.current;
    if (!authenticated || !accountId) throw new Error("Sign in to manage collections.");
    if (groupsOwnerRef.current !== accountId || !groupsRef.current.some((group) => group.id === groupId)) {
      throw new Error("That collection is not available yet. Please try again.");
    }
    const outbox = await hydrateOutbox(accountId, epoch);
    if (!outbox || epoch !== epochRef.current || accountId !== identityKey) {
      throw new Error("Your account changed while opening saved collections. Try again.");
    }
    outbox.setDesired(groupId, placeId, included);
    const next = withMembershipInGroups(groupsRef.current, groupId, placeId, included);
    setCurrentGroups(next, accountId);
    setPendingMemberships(outbox.pendingCount());
    setError("");
    if (!await persistOutbox(accountId, outbox) || !await persistSnapshot(accountId, next)) {
      setSyncStatus("error");
      setError("Private device storage could not save this collection change.");
      setSyncMessage("Keep Parkdex open and try again before leaving this page.");
      throw new Error("Private device storage could not save this collection change.");
    }

    const currentRequest = requestRef.current;
    if (!apiBaseUrl || browserIsOffline() || !currentRequest) {
      setOffline(true);
      setSyncStatus("offline");
      setSyncMessage("Your collection changes are saved on this device and waiting to sync.");
      setBusy(false);
      return;
    }

    setBusy(true);
    setOffline(false);
    setSyncStatus("syncing");
    try {
      await outbox.drain(
        groupId,
        placeId,
        (pendingGroupId, pendingPlaceId, pendingIncluded) => sendMembership(accountId, epoch, currentRequest, outbox, pendingGroupId, pendingPlaceId, pendingIncluded),
        { discardOnError: isPermanentlyInvalidMembership },
      );
      if (!await persistOutbox(accountId, outbox)) throw new Error("Private device storage could not save the collection changes.");
      setPendingMemberships(outbox.pendingCount());
      if (epoch === epochRef.current && accountId === identityKey) {
        setSyncStatus(outbox.hasPending() ? "syncing" : "idle");
        if (!outbox.hasPending()) setSyncMessage("");
      }
    } catch (caught) {
      let outboxStored = false;
      let reconciledPermanentFailure = false;
      try { outboxStored = await persistOutbox(accountId, outbox); } catch { /* report below */ }
      setPendingMemberships(outbox.pendingCount());
      if (outboxStored && isPermanentlyInvalidMembership(caught)) {
        try {
          await reconcileGroups(accountId, epoch, currentRequest, outbox);
          reconciledPermanentFailure = true;
        } catch (refreshError) {
          caught = refreshError;
        }
      }
      if (epoch === epochRef.current && accountId === identityKey) {
        if (!outboxStored) {
          setSyncStatus("error");
          setError("Private device storage could not save your pending collection changes.");
          setSyncMessage("Keep Parkdex open and try again before leaving this page.");
        } else if (reconciledPermanentFailure) {
          setOffline(false);
          setSyncStatus(outbox.hasPending() ? "syncing" : "idle");
          setError(messageFor(caught));
          setSyncMessage(outbox.hasPending() ? "Your newer collection changes are saved on this device and waiting to sync." : "");
        } else if (isOfflineFailure(caught)) {
          setOffline(true);
          setSyncStatus("offline");
          setSyncMessage("Your collection changes are saved on this device and waiting to sync.");
        } else {
          setSyncStatus("error");
          setError(messageFor(caught));
          setSyncMessage("Your collection changes are saved on this device and waiting to sync.");
        }
      }
      if (isOfflineFailure(caught)) return;
      throw caught;
    } finally {
      if (epoch === epochRef.current && accountId === identityKey) setBusy(false);
    }
  })()), [apiBaseUrl, authenticated, hydrateOutbox, identityKey, persistOutbox, persistSnapshot, reconcileGroups, sendMembership, setCurrentGroups, trackGroupOperation]);

  const addPlace = useCallback((groupId: string, placeId: string) => changeMembership(groupId, placeId, true), [changeMembership]);
  const removePlace = useCallback((groupId: string, placeId: string) => changeMembership(groupId, placeId, false), [changeMembership]);

  const prepareForReset = useCallback(async () => {
    const accountId = identityKey;
    if (!authenticated || !accountId) throw new Error("Sign in before resetting account progress.");
    if (!apiBaseUrl || browserIsOffline()) throw new Error("Connect to the internet before resetting account progress.");
    if (!requestRef.current) throw new Error("Sign in again before resetting account progress.");
    if (resetOwnerRef.current && resetOwnerRef.current !== accountId) {
      resetBarrierRef.current = null;
      resetGateRef.current = false;
    }
    resetOwnerRef.current = accountId;
    if (resetBarrierRef.current?.phase === "committed") {
      throw new Error("The progress reset already completed. Finish saved collection cleanup before starting another reset.");
    }

    // Close the mutation gate and invalidate collection reads before touching
    // storage. No new group request may begin while the reset is prepared.
    resetGateRef.current = true;
    const epoch = ++epochRef.current;
    cancelFetchRetry();
    setRetrying(false);
    setLoading(false);
    setBusy(true);
    setError("");
    setSyncStatus("syncing");
    setSyncMessage("Preparing saved collections for the progress reset.");

    const barrier: GroupResetBarrier = { phase: "prepared" };
    resetBarrierRef.current = barrier;
    let target: KeyValueStore;
    let persisted: unknown;
    try {
      target = await storage();
      persisted = await readStored<unknown>(target, accountGroupsResetKey(accountId), null);
    } catch (caught) {
      resetBarrierRef.current = null;
      resetGateRef.current = false;
      setResetPreparationPending(false);
      setResetCancellationAllowed(false);
      resetCancellationAllowedRef.current = false;
      setBusy(false);
      setSyncStatus("error");
      setSyncMessage("Private device storage could not prepare the collection reset.");
      throw caught;
    }
    if (isGroupResetBarrier(persisted) && persisted.phase === "committed") {
      resetBarrierRef.current = persisted;
      setResetPreparationPending(false);
      setResetCancellationAllowed(false);
      resetCancellationAllowedRef.current = false;
      setResetCleanupRequired(true);
      setBusy(false);
      throw new Error("The progress reset already completed. Finish saved collection cleanup before starting another reset.");
    }
    if (!await writeStored(target, accountGroupsResetKey(accountId), barrier)) {
      resetBarrierRef.current = null;
      resetGateRef.current = false;
      setResetPreparationPending(false);
      setResetCancellationAllowed(false);
      resetCancellationAllowedRef.current = false;
      setBusy(false);
      setSyncStatus("error");
      setSyncMessage("Private device storage could not prepare the collection reset.");
      throw new Error("Private device storage could not prepare the collection reset.");
    }
    setResetPreparationPending(true);
    setResetCancellationAllowed(true);
    resetCancellationAllowedRef.current = true;
    setResetCleanupRequired(false);

    const settleBeforeReset = async () => {
      await Promise.all([...activeGroupOperationsRef.current]);
      if (resetOwnerRef.current !== accountId || epoch !== epochRef.current) {
        throw new Error("Your account changed while preparing the progress reset.");
      }
      const outbox = await hydrateOutbox(accountId, epoch);
      if (!outbox) throw new Error("Saved collections could not be prepared for reset.");
      await outbox.waitForActive();
      if (outbox.hasPending()) await drainOutbox(accountId, epoch, requestRef.current);
      await outbox.waitForActive();
      if (outbox.hasPending()) {
        throw new Error("Saved collection changes must sync before progress can be reset. Retry while online.");
      }
      if (!await persistOutbox(accountId, outbox)) {
        throw new Error("Private device storage could not confirm that saved collection changes are settled.");
      }
    };

    try {
      await withTimeout(
        settleBeforeReset(),
        GROUP_RESET_PREPARATION_TIMEOUT_MS,
        "Saved collection requests are still running. Wait for them to finish, then retry the progress reset.",
      );
      setBusy(false);
      setError("");
      setSyncStatus("idle");
      setSyncMessage("");
    } catch (caught) {
      setBusy(false);
      setError(messageFor(caught));
      setSyncStatus(isOfflineFailure(caught) ? "offline" : "error");
      setSyncMessage("Collection changes are paused until this progress reset is finished or canceled.");
      throw caught;
    }
  }, [apiBaseUrl, authenticated, cancelFetchRetry, drainOutbox, hydrateOutbox, identityKey, persistOutbox, storage]);

  const cancelResetPreparation = useCallback(async () => {
    const accountId = identityKey;
    if (!accountId || resetOwnerRef.current !== accountId || !resetGateRef.current) return;
    if (resetBarrierRef.current?.phase === "committed") {
      throw new Error("The progress reset already completed, so saved collection cleanup cannot be canceled.");
    }
    if (!resetCancellationAllowedRef.current) {
      throw new Error("This progress reset needs to be confirmed again before collection changes can resume.");
    }

    const epoch = ++epochRef.current;
    cancelFetchRetry();
    setLoading(true);
    setError("");
    setSyncStatus("syncing");
    setSyncMessage("Refreshing saved collections before resuming collection changes.");
    try {
      const currentRequest = requestRef.current;
      if (!apiBaseUrl || browserIsOffline() || !currentRequest) {
        throw new Error("Reconnect before resuming collection changes after an interrupted progress reset.");
      }
      const [target, groups] = await Promise.all([
        storage(),
        withTimeout(
          listGroups(currentRequest),
          GROUP_RESET_PREPARATION_TIMEOUT_MS,
          "Saved collections are taking too long to refresh. Retry when the connection is stable.",
        ),
      ]);
      if (resetOwnerRef.current !== accountId || epoch !== epochRef.current) {
        throw new Error("Your account changed while recovering the progress reset.");
      }
      const outbox = outboxOwnerRef.current === accountId
        ? outboxRef.current
        : await hydrateOutbox(accountId, epoch);
      if (!outbox) throw new Error("Saved collection changes could not be recovered.");
      await outbox.waitForActive();
      const freshGroups = outbox.applyTo(normalizeGroups(groups));
      const [snapshotSaved, outboxSaved] = await Promise.all([
        persistSnapshot(accountId, freshGroups),
        persistOutbox(accountId, outbox),
      ]);
      if (!snapshotSaved || !outboxSaved) {
        throw new Error("Private device storage could not save the refreshed collections.");
      }
      if (!await removeStored(target, accountGroupsResetKey(accountId))) {
        throw new Error("Private device storage could not resume collection changes.");
      }
      resetBarrierRef.current = null;
      resetGateRef.current = false;
      resetCancellationAllowedRef.current = false;
      setResetPreparationPending(false);
      setResetCancellationAllowed(false);
      setResetCleanupRequired(false);
      setCurrentGroups(freshGroups, accountId);
      setSelectedGroupId(null);
      setPendingMemberships(outbox.pendingCount());
      setLoading(false);
      setBusy(false);
      setOffline(false);
      setError("");
      setSyncStatus(outbox.hasPending() ? "syncing" : "idle");
      setSyncMessage(outbox.hasPending() ? "Your newer collection changes are saved on this device and waiting to sync." : "");
      if (outbox.hasPending()) void drainOutbox(accountId, epoch, currentRequest).catch(() => undefined);
    } catch (caught) {
      if (epoch === epochRef.current) {
        setLoading(false);
        setBusy(false);
        setError(caught instanceof Error ? caught.message : "Saved collection recovery is still pending.");
        setSyncStatus(isOfflineFailure(caught) ? "offline" : "error");
        setSyncMessage("Collection changes are paused until the reset is resolved.");
      }
      throw caught;
    }
  }, [apiBaseUrl, cancelFetchRetry, drainOutbox, hydrateOutbox, identityKey, persistOutbox, persistSnapshot, setCurrentGroups, storage]);

  const refreshAfterReset = useCallback(async () => {
    const accountId = identityKey;
    if (!accountId || resetOwnerRef.current !== accountId || !resetGateRef.current) {
      throw new Error("Saved collections must be prepared before the progress reset is completed.");
    }
    const epoch = ++epochRef.current;
    cancelFetchRetry();
    setRetrying(false);
    setLoading(true);
    setError("");
    setSyncStatus("syncing");
    setSyncMessage("Saved collections are being cleared after the progress reset.");
    setCurrentGroups([], accountId);
    setSelectedGroupId(null);
    setPendingMemberships(0);
    setBusy(false);
    setResetPreparationPending(false);
    setResetCancellationAllowed(false);
    resetCancellationAllowedRef.current = false;
    setResetCleanupRequired(true);

    const committed: GroupResetBarrier = { phase: "committed" };
    resetBarrierRef.current = committed;
    try {
      const target = await storage();
      // If this write fails, the already persisted prepared barrier still
      // prevents old membership intents from replaying after a reload.
      if (!await writeStored(target, accountGroupsResetKey(accountId), committed)) {
        throw new Error("Private device storage could not record the completed progress reset.");
      }
      const outbox = outboxOwnerRef.current === accountId ? outboxRef.current : new GroupOutbox();
      await outbox.clearAndWait();
      await clearCommittedResetArtifacts(accountId);
    } catch (caught) {
      if (epoch === epochRef.current) {
        setLoading(false);
        setError(caught instanceof Error ? caught.message : "Saved collection cleanup is still pending.");
        setSyncStatus("error");
        setSyncMessage("Saved collection cleanup is still pending.");
      }
      throw caught;
    }
    await load();
  }, [cancelFetchRetry, clearCommittedResetArtifacts, identityKey, load, setCurrentGroups, storage]);

  const hydratedGroups = useMemo(() => hydrate(groups), [groups, hydrate]);
  // Until the new identity's effect has hydrated its cache/server response,
  // never expose the previous account's private groups for even one render.
  const visibleGroups = useMemo(() => groupsOwner === identityKey ? hydratedGroups : [], [groupsOwner, hydratedGroups, identityKey]);
  const visibleSelectedGroupId = visibleGroups.some((group) => group.id === selectedGroupId) ? selectedGroupId : null;

  return useMemo(() => ({
    groups: visibleGroups,
    selectedGroupId: visibleSelectedGroupId,
    loading,
    retrying,
    error,
    busy,
    offline,
    syncStatus,
    syncMessage,
    pendingMemberships,
    resetPreparationPending,
    resetCancellationAllowed,
    resetCleanupRequired,
    selectGroup: setSelectedGroupId,
    retry: load,
    prepareForReset,
    cancelResetPreparation,
    refreshAfterReset,
    create,
    rename,
    remove,
    addPlace,
    removePlace,
  }), [addPlace, busy, cancelResetPreparation, create, error, load, loading, offline, pendingMemberships, prepareForReset, refreshAfterReset, remove, removePlace, rename, resetCancellationAllowed, resetCleanupRequired, resetPreparationPending, retrying, syncMessage, syncStatus, visibleGroups, visibleSelectedGroupId]);
}
