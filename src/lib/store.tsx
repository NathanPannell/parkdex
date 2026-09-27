import { createContext, useContext, useEffect, useReducer, type ReactNode } from "react";
import type { LngLat } from "./geo";
import { clearPhotos, loadPhotos, savePhoto } from "./photos";

export type Claim = { at: string; photo: string };

export type Screen = "splash" | "onboarding" | "map" | "collection" | "camera" | "claim" | "share";

// Where the feedback sheet was opened from, captured so reports carry app context.
export type FeedbackOrigin = { screen: Screen; parkId: string | null };

type State = {
  onboarded: boolean;
  claims: Record<string, Claim>;
  user: LngLat;
  // Metres of GPS uncertainty; null until the first real fix arrives.
  accuracy: number | null;
  locationError: string | null;
  muted: boolean;
  screen: Screen;
  selectedId: string | null;
  tripId: string | null;
  pendingPhoto: string | null;
  focusId: string | null;
  feedback: FeedbackOrigin | null;
};

type Action =
  | { type: "go"; screen: Screen }
  | { type: "onboarded" }
  | { type: "select"; id: string | null }
  | { type: "trip"; id: string | null }
  | { type: "move"; user: LngLat; accuracy?: number }
  | { type: "locationError"; error: string | null }
  | { type: "photos"; photos: Record<string, string> }
  | { type: "photo"; photo: string | null }
  | { type: "claim"; id: string; photo: string }
  | { type: "focus"; id: string | null }
  | { type: "mute" }
  | { type: "feedback"; open: boolean; parkId?: string | null }
  | { type: "reset" };

// Downtown Victoria: the mockup's starting point for testers without GPS.
export const DEMO_START: LngLat = [-123.3656, 48.4284];
const KEY = "parkdex-mockup-v1";

const initial: State = {
  onboarded: false,
  claims: {},
  user: DEMO_START,
  accuracy: null,
  locationError: null,
  muted: false,
  screen: "splash",
  selectedId: null,
  tripId: null,
  pendingPhoto: null,
  focusId: null,
  feedback: null,
};

function load(): State {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? "null");
    if (!saved) return initial;
    return { ...initial, onboarded: saved.onboarded, claims: saved.claims ?? {}, muted: !!saved.muted };
  } catch {
    return initial;
  }
}

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "go":
      return { ...state, screen: action.screen };
    case "onboarded":
      return { ...state, onboarded: true, screen: "map" };
    case "select":
      return { ...state, selectedId: action.id };
    case "trip":
      return { ...state, tripId: action.id };
    case "move":
      return { ...state, user: action.user, accuracy: action.accuracy ?? state.accuracy, locationError: null };
    case "locationError":
      return { ...state, locationError: action.error };
    case "photos": {
      const claims = { ...state.claims };
      for (const [id, photo] of Object.entries(action.photos)) if (claims[id]) claims[id] = { ...claims[id], photo };
      return { ...state, claims };
    }
    case "photo":
      return { ...state, pendingPhoto: action.photo };
    case "claim":
      return {
        ...state,
        claims: { ...state.claims, [action.id]: { at: new Date().toISOString(), photo: action.photo } },
        tripId: null,
      };
    case "focus":
      return { ...state, focusId: action.id };
    case "mute":
      return { ...state, muted: !state.muted };
    case "feedback":
      if (!action.open) return { ...state, feedback: null };
      return { ...state, feedback: { screen: state.screen, parkId: action.parkId ?? state.selectedId ?? state.tripId } };
    case "reset":
      return { ...initial, screen: "splash" };
  }
}

const Ctx = createContext<{ state: State; dispatch: (a: Action) => void } | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, undefined, load);

  useEffect(() => {
    loadPhotos()
      .then((photos) => dispatch({ type: "photos", photos }))
      .catch(() => {});
  }, []);

  useEffect(() => {
    const { onboarded, muted } = state;
    // Photos are stored separately in IndexedDB; only claim metadata goes to localStorage.
    const claims = Object.fromEntries(Object.entries(state.claims).map(([id, c]) => [id, { at: c.at, photo: "" }]));
    try {
      localStorage.setItem(KEY, JSON.stringify({ onboarded, claims, muted }));
    } catch {
      // Storage can be unavailable in private modes; the session still works in memory.
    }
  }, [state.onboarded, state.claims, state.muted]);

  const wrapped = (action: Action) => {
    if (action.type === "claim" && action.photo) void savePhoto(action.id, action.photo).catch(() => {});
    if (action.type === "reset") void clearPhotos().catch(() => {});
    dispatch(action);
  };

  return <Ctx.Provider value={{ state, dispatch: wrapped }}>{children}</Ctx.Provider>;
}

export function useStore() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useStore outside StoreProvider");
  return ctx;
}
