"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Place } from "./places";
import { addTripPlace, createTrip, deleteTrip, listTrips, removeTripPlace, updateTrip, type AuthenticatedRequest, type Trip } from "./trips";

type TripState = {
  trips: Trip[];
  selectedTripId: string | null;
  loading: boolean;
  error: string;
  busy: boolean;
  selectTrip: (id: string | null) => void;
  retry: () => Promise<void>;
  create: (name: string, placeIds: string[]) => Promise<Trip | null>;
  rename: (id: string, name: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  addPlace: (tripId: string, placeId: string) => Promise<void>;
  removePlace: (tripId: string, placeId: string) => Promise<void>;
};

function messageFor(error: unknown) {
  return error instanceof Error ? error.message : "Groups are unavailable right now. Please try again.";
}

export function useTrips({ apiBaseUrl, authenticated, identityKey = "", places, request }: { apiBaseUrl: string; authenticated: boolean; identityKey?: string; places: Place[]; request?: AuthenticatedRequest }): TripState {
  const [trips, setTrips] = useState<Trip[]>([]);
  const [selectedTripId, setSelectedTripId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const epochRef = useRef(0);
  const requestRef = useRef(request);
  useEffect(() => { requestRef.current = request; }, [request]);

  const hydrate = useCallback((items: Trip[]) => items.map((trip) => ({
    ...trip,
    places: (trip.placeIds ?? trip.places.map((place) => place.id)).map((id) => places.find((place) => place.id === id)).filter((place): place is Place => Boolean(place)),
  })), [places]);

  const load = useCallback(async () => {
    const currentRequest = requestRef.current;
    const epoch = ++epochRef.current;
    if (!apiBaseUrl || !authenticated || !identityKey || !currentRequest) { setTrips([]); setSelectedTripId(null); setLoading(false); setBusy(false); return; }
    setLoading(true); setError("");
    try {
      const next = await listTrips(currentRequest);
      if (epoch !== epochRef.current) return;
      setTrips(next);
      setSelectedTripId((current) => current && next.some((trip) => trip.id === current) ? current : null);
    } catch (caught) {
      if (epoch === epochRef.current) setError(messageFor(caught));
    } finally {
      if (epoch === epochRef.current) setLoading(false);
    }
  }, [apiBaseUrl, authenticated, identityKey]);

  useEffect(() => { setBusy(false); void load(); return () => { epochRef.current += 1; }; }, [load]);
  const hydratedTrips = useMemo(() => hydrate(trips), [hydrate, trips]);

  const mutate = useCallback(async (operation: (request: AuthenticatedRequest) => Promise<Trip | void>) => {
    const currentRequest = requestRef.current;
    if (!currentRequest) throw new Error("Sign in to manage groups.");
    const epoch = epochRef.current;
    const identity = identityKey;
    setBusy(true); setError("");
    try {
      const result = await operation(currentRequest);
      if (epoch !== epochRef.current || identity !== identityKey) return undefined;
      if (result) setTrips((current) => current.some((trip) => trip.id === result.id) ? current.map((trip) => trip.id === result.id ? result : trip) : [...current, result]);
      return result;
    } catch (caught) { if (epoch === epochRef.current && identity === identityKey) setError(messageFor(caught)); throw caught; }
    finally { if (epoch === epochRef.current && identity === identityKey) setBusy(false); }
  }, [identityKey]);

  const create = useCallback(async (name: string, placeIds: string[]) => {
    const result = await mutate((currentRequest) => createTrip(currentRequest, name, placeIds));
    if (result) setSelectedTripId(result.id);
    return result ?? null;
  }, [mutate]);
  const rename = useCallback(async (id: string, name: string) => { await mutate((currentRequest) => updateTrip(currentRequest, id, name)); }, [mutate]);
  const remove = useCallback(async (id: string) => { const epoch = epochRef.current; await mutate((currentRequest) => deleteTrip(currentRequest, id)); if (epoch === epochRef.current) { setTrips((current) => current.filter((trip) => trip.id !== id)); if (selectedTripId === id) setSelectedTripId(null); } }, [mutate, selectedTripId]);
  const addPlace = useCallback(async (tripId: string, placeId: string) => { await mutate((currentRequest) => addTripPlace(currentRequest, tripId, placeId)); }, [mutate]);
  const removePlace = useCallback(async (tripId: string, placeId: string) => { await mutate((currentRequest) => removeTripPlace(currentRequest, tripId, placeId)); }, [mutate]);
  return useMemo(() => ({ trips: hydratedTrips, selectedTripId, loading, error, busy, selectTrip: setSelectedTripId, retry: load, create, rename, remove, addPlace, removePlace }), [addPlace, busy, create, error, hydratedTrips, load, loading, remove, removePlace, rename, selectedTripId]);
}
