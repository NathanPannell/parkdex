"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { readStored, removeStored, writeStored } from "./field-journal-state";
import type { Place } from "./places";
import { GroupOutbox } from "./group-outbox";
import { addGroupPlace, createGroup, deleteGroup, GroupsApiError, listGroups, normalizeGroups, removeGroupPlace, updateGroup, type AuthenticatedRequest, type Group } from "./groups";
import { getPlatformStorage, type KeyValueStore } from "./platform-storage";

export type GroupSyncStatus = "idle" | "syncing" | "offline" | "error";

/** Versioned account-scoped keys keep cached private data separate from guest data. */
export function accountGroupsCacheKey(accountId: string) {
  return `every-park:account-groups:${encodeURIComponent(accountId)}:v1`;
}

export function accountGroupsOutboxKey(accountId: string) {
  return `every-park:account-group-memberships:${encodeURIComponent(accountId)}:v1`;
}

type GroupState = {
  groups: Group[];
  selectedGroupId: string | null;
  loading: boolean;
  error: string;
  busy: boolean;
  /** True when the browser/API is currently unable to reach the groups service. */
  offline: boolean;
  syncStatus: GroupSyncStatus;
  syncMessage: string;
  /** Number of distinct group/place desired states still awaiting acknowledgement. */
  pendingMemberships: number;
  selectGroup: (id: string | null) => void;
  retry: () => Promise<void>;
  refreshAfterReset: () => Promise<void>;
  create: (name: string, placeIds: string[]) => Promise<Group | null>;
  rename: (id: string, name: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  addPlace: (groupId: string, placeId: string) => Promise<void>;
  removePlace: (groupId: string, placeId: string) => Promise<void>;
};

function messageFor(error: unknown) {
  return error instanceof Error ? error.message : "Groups are unavailable right now. Please try again.";
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

function compactGroup(group: Group) {
  const placeIds = [...new Set((group.placeIds ?? group.places.map((place) => place.id)).filter((id): id is string => typeof id === "string"))];
  return {
    id: group.id,
    name: group.name,
    ...(group.isWishlist ? { isWishlist: true } : {}),
    placeIds,
    ...(group.createdAt ? { createdAt: group.createdAt } : {}),
    ...(group.updatedAt ? { updatedAt: group.updatedAt } : {}),
  };
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
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [offline, setOffline] = useState(browserIsOffline);
  const [syncStatus, setSyncStatus] = useState<GroupSyncStatus>(browserIsOffline() ? "offline" : "idle");
  const [syncMessage, setSyncMessage] = useState("");
  const [pendingMemberships, setPendingMemberships] = useState(0);
  const epochRef = useRef(0);
  const requestRef = useRef(request);
  const groupsRef = useRef<Group[]>([]);
  const groupsOwnerRef = useRef("");
  const [groupsOwner, setGroupsOwner] = useState("");
  const outboxRef = useRef(new GroupOutbox());
  const outboxOwnerRef = useRef("");
  const storageRef = useRef<KeyValueStore | null>(null);
  useEffect(() => { requestRef.current = request; }, [request]);

  const storage = useCallback(async () => {
    if (storageRef.current) return storageRef.current;
    const target = await getPlatformStorage();
    storageRef.current = target;
    return target;
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

  const hydrate = useCallback((items: Group[]) => items.map((group) => ({
    ...group,
    places: placeIdsFor(group).map((id) => places.find((place) => place.id === id)).filter((place): place is Place => Boolean(place)),
  })), [places]);

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
    if (epoch !== epochRef.current || accountId !== identityKey) throw new Error("Group identity changed while syncing.");
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
      throw new Error("Private device storage could not save the synced groups.");
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
      throw new Error("Private device storage could not save your refreshed groups.");
    }
    setPendingMemberships(outbox.pendingCount());
    setOffline(false);
    setError("");
    setSyncStatus(outbox.hasPending() ? "syncing" : "idle");
    setSyncMessage(outbox.hasPending() ? "Your newer group changes are saved on this device and waiting to sync." : "");
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
        setSyncMessage("Your group changes are saved on this device and waiting to sync.");
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
        throw new Error("Private device storage could not save the group outbox.");
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
          setError("Private device storage could not save your pending group changes.");
          setSyncMessage("Keep Parkdex open and try again before leaving this page.");
        } else if (isOfflineFailure(caught)) {
          setOffline(true);
          setSyncStatus("offline");
          setSyncMessage("Your group changes are saved on this device and waiting to sync.");
        } else {
          setSyncStatus("error");
          setError(messageFor(caught));
          setSyncMessage("Your group changes are saved on this device and waiting to sync.");
        }
      }
      throw caught;
    }
  }, [apiBaseUrl, identityKey, persistOutbox, reconcileGroups, sendMembership]);

  const load = useCallback(async () => {
    const accountId = identityKey;
    const currentRequest = requestRef.current;
    const epoch = ++epochRef.current;
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

    let outbox: GroupOutbox;
    let cached: Group[];
    try {
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
      setError("Private device storage could not open your saved groups.");
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
        ? "Your group changes are saved on this device and waiting to sync."
        : cached.length ? "Showing your saved groups offline." : "Your groups are unavailable offline.");
      await persistOutbox(accountId, outbox);
      return;
    }

    const checkpoint = outbox.checkpoint();
    try {
      const next = await listGroups(currentRequest);
      if (epoch !== epochRef.current) return;
      const rebased = outbox.applyTo(next, checkpoint);
      setCurrentGroups(rebased, accountId);
      setSelectedGroupId((current) => current && rebased.some((group) => group.id === current) ? current : null);
      if (!await persistSnapshot(accountId, rebased) || !await persistOutbox(accountId, outbox)) {
        throw new Error("Private device storage could not save your groups.");
      }
      setOffline(false);
      setError("");
      await drainOutbox(accountId, epoch, currentRequest);
    } catch (caught) {
      if (epoch !== epochRef.current) return;
      const nowOffline = isOfflineFailure(caught);
      setOffline(nowOffline);
      setSyncStatus(nowOffline ? "offline" : "error");
      setError(messageFor(caught));
      setSyncMessage(nowOffline
        ? outbox.hasPending() ? "Your group changes are saved on this device and waiting to sync." : cached.length ? "Showing your saved groups offline." : "Your groups are unavailable offline."
        : "");
    } finally {
      if (epoch === epochRef.current) {
        setLoading(false);
        setBusy(false);
      }
    }
  }, [apiBaseUrl, authenticated, drainOutbox, hydrateOutbox, identityKey, persistOutbox, persistSnapshot, setCurrentGroups, storage]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => { window.clearTimeout(timer); epochRef.current += 1; };
  }, [load]);

  useEffect(() => {
    const becameOffline = () => {
      setOffline(true);
      setSyncStatus("offline");
      if (outboxRef.current.hasPending()) setSyncMessage("Your group changes are saved on this device and waiting to sync.");
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
    if (!apiBaseUrl || offline || browserIsOffline()) {
      setOffline(true);
      setSyncStatus("offline");
      throw new Error("Creating, renaming, or deleting groups requires an online connection.");
    }
    const currentRequest = requestRef.current;
    if (!currentRequest) throw new Error("Sign in to manage groups.");
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
          throw new Error("Private device storage could not save your groups.");
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

  const create = useCallback(async (name: string, placeIds: string[]) => {
    const result = await mutate((currentRequest) => createGroup(currentRequest, name, placeIds));
    if (result) setSelectedGroupId(result.id);
    return result ?? null;
  }, [mutate]);

  const rename = useCallback(async (id: string, name: string) => {
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
  }, [hydrateOutbox, identityKey, mutate, reconcileGroups]);

  const remove = useCallback(async (id: string) => {
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
      if (!await persistOutbox(accountId, outbox)) throw new Error("Private device storage could not clear the group outbox.");
      const next = groupsRef.current.filter((group) => group.id !== id);
      setCurrentGroups(next, accountId);
      if (!await persistSnapshot(accountId, next)) throw new Error("Private device storage could not save your groups.");
      if (selectedGroupId === id) setSelectedGroupId(null);
      setPendingMemberships(outbox.pendingCount());
    }
  }, [hydrateOutbox, identityKey, mutate, persistOutbox, persistSnapshot, reconcileGroups, selectedGroupId, setCurrentGroups]);

  const changeMembership = useCallback(async (groupId: string, placeId: string, included: boolean) => {
    const accountId = identityKey;
    const epoch = epochRef.current;
    if (!authenticated || !accountId) throw new Error("Sign in to manage groups.");
    if (groupsOwnerRef.current !== accountId || !groupsRef.current.some((group) => group.id === groupId)) {
      throw new Error("That group is not available yet. Please try again.");
    }
    const outbox = await hydrateOutbox(accountId, epoch);
    if (!outbox || epoch !== epochRef.current || accountId !== identityKey) {
      throw new Error("Your account changed while opening saved groups. Try again.");
    }
    outbox.setDesired(groupId, placeId, included);
    const next = withMembershipInGroups(groupsRef.current, groupId, placeId, included);
    setCurrentGroups(next, accountId);
    setPendingMemberships(outbox.pendingCount());
    setError("");
    if (!await persistOutbox(accountId, outbox) || !await persistSnapshot(accountId, next)) {
      setSyncStatus("error");
      setError("Private device storage could not save this group change.");
      setSyncMessage("Keep Parkdex open and try again before leaving this page.");
      throw new Error("Private device storage could not save this group change.");
    }

    const currentRequest = requestRef.current;
    if (!apiBaseUrl || browserIsOffline() || !currentRequest) {
      setOffline(true);
      setSyncStatus("offline");
      setSyncMessage("Your group changes are saved on this device and waiting to sync.");
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
      if (!await persistOutbox(accountId, outbox)) throw new Error("Private device storage could not save the group outbox.");
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
          setError("Private device storage could not save your pending group changes.");
          setSyncMessage("Keep Parkdex open and try again before leaving this page.");
        } else if (reconciledPermanentFailure) {
          setOffline(false);
          setSyncStatus(outbox.hasPending() ? "syncing" : "idle");
          setError(messageFor(caught));
          setSyncMessage(outbox.hasPending() ? "Your newer group changes are saved on this device and waiting to sync." : "");
        } else if (isOfflineFailure(caught)) {
          setOffline(true);
          setSyncStatus("offline");
          setSyncMessage("Your group changes are saved on this device and waiting to sync.");
        } else {
          setSyncStatus("error");
          setError(messageFor(caught));
          setSyncMessage("Your group changes are saved on this device and waiting to sync.");
        }
      }
      if (isOfflineFailure(caught)) return;
      throw caught;
    } finally {
      if (epoch === epochRef.current && accountId === identityKey) setBusy(false);
    }
  }, [apiBaseUrl, authenticated, hydrateOutbox, identityKey, persistOutbox, persistSnapshot, reconcileGroups, sendMembership, setCurrentGroups]);

  const addPlace = useCallback((groupId: string, placeId: string) => changeMembership(groupId, placeId, true), [changeMembership]);
  const removePlace = useCallback((groupId: string, placeId: string) => changeMembership(groupId, placeId, false), [changeMembership]);

  const refreshAfterReset = useCallback(async () => {
    // The caller invokes this only after the account reset request succeeds.
    // Clear first so deleted groups/memberships cannot flash while Wishlist is recreated.
    const accountId = identityKey;
    epochRef.current += 1;
    const epoch = epochRef.current;
    const outbox = outboxOwnerRef.current === accountId ? outboxRef.current : await hydrateOutbox(accountId, epoch);
    if (!outbox || epoch !== epochRef.current) return;
    await outbox.clearAndWait();
    if (accountId) {
      const target = await storage();
      if (!await removeStored(target, accountGroupsCacheKey(accountId)) || !await persistOutbox(accountId, outbox)) {
        throw new Error("Private device storage could not clear the saved groups.");
      }
    }
    setCurrentGroups([], accountId);
    setSelectedGroupId(null);
    setError("");
    setSyncMessage("");
    setPendingMemberships(0);
    setBusy(false);
    await load();
  }, [hydrateOutbox, identityKey, load, persistOutbox, setCurrentGroups, storage]);

  const hydratedGroups = useMemo(() => hydrate(groups), [groups, hydrate]);
  // Until the new identity's effect has hydrated its cache/server response,
  // never expose the previous account's private groups for even one render.
  const visibleGroups = useMemo(() => groupsOwner === identityKey ? hydratedGroups : [], [groupsOwner, hydratedGroups, identityKey]);
  const visibleSelectedGroupId = visibleGroups.some((group) => group.id === selectedGroupId) ? selectedGroupId : null;

  return useMemo(() => ({
    groups: visibleGroups,
    selectedGroupId: visibleSelectedGroupId,
    loading,
    error,
    busy,
    offline,
    syncStatus,
    syncMessage,
    pendingMemberships,
    selectGroup: setSelectedGroupId,
    retry: load,
    refreshAfterReset,
    create,
    rename,
    remove,
    addPlace,
    removePlace,
  }), [addPlace, busy, create, error, load, loading, offline, pendingMemberships, refreshAfterReset, remove, removePlace, rename, syncMessage, syncStatus, visibleGroups, visibleSelectedGroupId]);
}
