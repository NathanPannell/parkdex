import { createContext, useContext, useEffect, useReducer, type ReactNode } from "react";
import type { LngLat } from "./geo";

export type Claim = { at: string; photo: string };

export type Screen = "splash" | "onboarding" | "map" | "collection" | "camera" | "claim" | "share";

type State = {
  onboarded: boolean;
  claims: Record<string, Claim>;
  user: LngLat;
  muted: boolean;
  waitlist: string[];
  screen: Screen;
  selectedId: string | null;
  tripId: string | null;
  pendingPhoto: string | null;
  focusId: string | null;
};

type Action =
  | { type: "go"; screen: Screen }
  | { type: "onboarded" }
  | { type: "select"; id: string | null }
  | { type: "trip"; id: string | null }
  | { type: "move"; user: LngLat }
  | { type: "photo"; photo: string | null }
  | { type: "claim"; id: string; photo: string }
  | { type: "focus"; id: string | null }
  | { type: "mute" }
  | { type: "waitlist"; product: string }
  | { type: "reset" };

// Downtown Victoria: the mockup's starting point for testers without GPS.
export const DEMO_START: LngLat = [-123.3656, 48.4284];
const KEY = "parkdex-mockup-v1";

const initial: State = {
  onboarded: false,
  claims: {},
  user: DEMO_START,
  muted: false,
  waitlist: [],
  screen: "splash",
  selectedId: null,
  tripId: null,
  pendingPhoto: null,
  focusId: null,
};

function load(): State {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? "null");
    if (!saved) return initial;
    return { ...initial, onboarded: saved.onboarded, claims: saved.claims ?? {}, muted: !!saved.muted, waitlist: saved.waitlist ?? [] };
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
      return { ...state, user: action.user };
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
    case "waitlist":
      return state.waitlist.includes(action.product) ? state : { ...state, waitlist: [...state.waitlist, action.product] };
    case "reset":
      return { ...initial, screen: "splash" };
  }
}

const Ctx = createContext<{ state: State; dispatch: (a: Action) => void } | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, undefined, load);

  useEffect(() => {
    const { onboarded, claims, muted, waitlist } = state;
    try {
      localStorage.setItem(KEY, JSON.stringify({ onboarded, claims, muted, waitlist }));
    } catch {
      // Photos can exceed the storage quota; keep the session state in memory.
    }
  }, [state.onboarded, state.claims, state.muted, state.waitlist]);

  return <Ctx.Provider value={{ state, dispatch }}>{children}</Ctx.Provider>;
}

export function useStore() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useStore outside StoreProvider");
  return ctx;
}
