"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Place } from "./places";
import { addGroupPlace, createGroup, deleteGroup, listGroups, removeGroupPlace, updateGroup, type AuthenticatedRequest, type Group } from "./groups";

type GroupState = {
  groups: Group[];
  selectedGroupId: string | null;
  loading: boolean;
  error: string;
  busy: boolean;
  selectGroup: (id: string | null) => void;
  retry: () => Promise<void>;
  create: (name: string, placeIds: string[]) => Promise<Group | null>;
  rename: (id: string, name: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  addPlace: (groupId: string, placeId: string) => Promise<void>;
  removePlace: (groupId: string, placeId: string) => Promise<void>;
};

function messageFor(error: unknown) {
  return error instanceof Error ? error.message : "Groups are unavailable right now. Please try again.";
}

export function useGroups({ apiBaseUrl, authenticated, identityKey = "", places, request }: { apiBaseUrl: string; authenticated: boolean; identityKey?: string; places: Place[]; request?: AuthenticatedRequest }): GroupState {
  const [groups, setGroups] = useState<Group[]>([]);
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const epochRef = useRef(0);
  const requestRef = useRef(request);
  useEffect(() => { requestRef.current = request; }, [request]);

  const hydrate = useCallback((items: Group[]) => items.map((group) => ({
    ...group,
    places: (group.placeIds ?? group.places.map((place) => place.id)).map((id) => places.find((place) => place.id === id)).filter((place): place is Place => Boolean(place)),
  })), [places]);

  const load = useCallback(async () => {
    const currentRequest = requestRef.current;
    const epoch = ++epochRef.current;
    if (!apiBaseUrl || !authenticated || !identityKey || !currentRequest) { setGroups([]); setSelectedGroupId(null); setLoading(false); setBusy(false); return; }
    setLoading(true); setError("");
    try {
      const next = await listGroups(currentRequest);
      if (epoch !== epochRef.current) return;
      setGroups(next);
      setSelectedGroupId((current) => current && next.some((group) => group.id === current) ? current : null);
    } catch (caught) {
      if (epoch === epochRef.current) setError(messageFor(caught));
    } finally {
      if (epoch === epochRef.current) { setLoading(false); setBusy(false); }
    }
  }, [apiBaseUrl, authenticated, identityKey]);

  useEffect(() => { void load(); return () => { epochRef.current += 1; }; }, [load]);
  const hydratedGroups = useMemo(() => hydrate(groups), [groups, hydrate]);

  const mutate = useCallback(async (operation: (request: AuthenticatedRequest) => Promise<Group | void>) => {
    const currentRequest = requestRef.current;
    if (!currentRequest) throw new Error("Sign in to manage groups.");
    const epoch = epochRef.current;
    const identity = identityKey;
    setBusy(true); setError("");
    try {
      const result = await operation(currentRequest);
      if (epoch !== epochRef.current || identity !== identityKey) return undefined;
      if (result) setGroups((current) => current.some((group) => group.id === result.id) ? current.map((group) => group.id === result.id ? result : group) : [...current, result]);
      return result;
    } catch (caught) { if (epoch === epochRef.current && identity === identityKey) setError(messageFor(caught)); throw caught; }
    finally { if (epoch === epochRef.current && identity === identityKey) setBusy(false); }
  }, [identityKey]);

  const create = useCallback(async (name: string, placeIds: string[]) => {
    const result = await mutate((currentRequest) => createGroup(currentRequest, name, placeIds));
    if (result) setSelectedGroupId(result.id);
    return result ?? null;
  }, [mutate]);
  const rename = useCallback(async (id: string, name: string) => { await mutate((currentRequest) => updateGroup(currentRequest, id, name)); }, [mutate]);
  const remove = useCallback(async (id: string) => { const epoch = epochRef.current; await mutate((currentRequest) => deleteGroup(currentRequest, id)); if (epoch === epochRef.current) { setGroups((current) => current.filter((group) => group.id !== id)); if (selectedGroupId === id) setSelectedGroupId(null); } }, [mutate, selectedGroupId]);
  const addPlace = useCallback(async (groupId: string, placeId: string) => { await mutate((currentRequest) => addGroupPlace(currentRequest, groupId, placeId)); }, [mutate]);
  const removePlace = useCallback(async (groupId: string, placeId: string) => { await mutate((currentRequest) => removeGroupPlace(currentRequest, groupId, placeId)); }, [mutate]);
  return useMemo(() => ({ groups: hydratedGroups, selectedGroupId, loading, error, busy, selectGroup: setSelectedGroupId, retry: load, create, rename, remove, addPlace, removePlace }), [addPlace, busy, create, error, hydratedGroups, load, loading, remove, removePlace, rename, selectedGroupId]);
}
