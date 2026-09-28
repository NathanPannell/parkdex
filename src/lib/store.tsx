import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, type ReactNode } from "react";
import type { LngLat } from "./geo";
import type { Park } from "./parks";
import { loadPersonalProgress, type ProgressOwner } from "./accounts/personalStore";
import { useAuth } from "./accounts/AuthProvider";

export type Claim = { claimId: string; at: string; photo: string; parkSnapshot: Park | null; contentReleaseId: string | null };

export type Screen = "splash" | "onboarding" | "map" | "collection" | "camera" | "claim" | "share" | "account";

// Where the feedback sheet was opened from, captured so reports carry app context.
export type FeedbackOrigin = { screen: Screen; parkId: string | null };

type State = {
  onboarded: boolean;
  claims: Record<string, Claim>;
  progressReady: boolean;
  progressError: string | null;
  progressOwnerKey: string | null;
  claimRevision: number;
  claimRevisionByPark: Record<string, number>;
  user: LngLat;
  // Metres of GPS uncertainty; null until the first real fix arrives.
  accuracy: number | null;
  locationError: string | null;
  muted: boolean;
  screen: Screen;
  selectedId: string | null;
  tripId: string | null;
  shareClaimId: string | null;
  pendingPhoto: string | null;
  focusId: string | null;
  feedback: FeedbackOrigin | null;
};

type Action =
  | { type: "go"; screen: Screen }
  | { type: "onboarded" }
  | { type: "select"; id: string | null }
  | { type: "trip"; id: string | null }
  | { type: "move"; user: LngLat; accuracy?: number | null }
  | { type: "locationError"; error: string | null }
  | { type: "photo"; photo: string | null }
  | { type: "claim"; ownerKey: string; id: string; claimId: string; at: string; photo: string; parkSnapshot: Park; contentReleaseId: string | null }
  | { type: "shareClaim"; claimId: string | null }
  | { type: "focus"; id: string | null }
  | { type: "mute" }
  | { type: "feedback"; open: boolean; parkId?: string | null }
  | { type: "progressLoading"; ownerKey: string | null }
  | { type: "progressLoaded"; ownerKey: string; claims: Record<string, Claim>; claimRevisionAtStart?: number }
  | { type: "progressFailed"; ownerKey: string; message: string }
  | { type: "reset" };

// Downtown Victoria: the mockup's starting point for testers without GPS.
export const DEMO_START: LngLat = [-123.3656, 48.4284];
const KEY = "parkdex-mockup-v1";

const initial: State = {
  onboarded: false,
  claims: {},
  progressReady: false,
  progressError: null,
  progressOwnerKey: null,
  claimRevision: 0,
  claimRevisionByPark: {},
  user: DEMO_START,
  accuracy: null,
  locationError: null,
  muted: false,
  screen: "splash",
  selectedId: null,
  tripId: null,
  shareClaimId: null,
  pendingPhoto: null,
  focusId: null,
  feedback: null,
};

function load(): State {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? "null");
    if (!saved || typeof saved !== "object") return initial;
    // Claims and photos are migrated transactionally by personalStore. Never project
    // the legacy unpartitioned records into the UI before an owner is known.
    return { ...initial, onboarded: !!saved.onboarded, muted: !!saved.muted };
  } catch {
    return initial;
  }
}

export function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "go":
      return { ...state, screen: action.screen };
    case "onboarded":
      return { ...state, onboarded: true, screen: "map" };
    case "select":
      return { ...state, selectedId: action.id };
    case "trip":
      return { ...state, tripId: action.id };
    case "shareClaim":
      return { ...state, shareClaimId: action.claimId };
    case "move":
      return { ...state, user: action.user, accuracy: action.accuracy === undefined ? state.accuracy : action.accuracy, locationError: null };
    case "locationError":
      return { ...state, locationError: action.error };
    case "photo":
      return { ...state, pendingPhoto: action.photo };
    case "claim": {
      if (state.progressOwnerKey !== action.ownerKey) return state;
      const claimRevision = state.claimRevision + 1;
      return {
        ...state,
        claims: { ...state.claims, [action.id]: { claimId: action.claimId, at: action.at, photo: action.photo, parkSnapshot: action.parkSnapshot, contentReleaseId: action.contentReleaseId } },
        claimRevision,
        claimRevisionByPark: { ...state.claimRevisionByPark, [action.id]: claimRevision },
        tripId: null,
        shareClaimId: action.claimId,
        pendingPhoto: null,
      };
    }
    case "focus":
      return { ...state, focusId: action.id };
    case "mute":
      return { ...state, muted: !state.muted };
    case "feedback":
      if (!action.open) return { ...state, feedback: null };
      return { ...state, feedback: { screen: state.screen, parkId: action.parkId ?? state.selectedId ?? state.tripId } };
    case "progressLoading":
      // Refreshing the same owner's durable projection happens during normal
      // backup. Keep the current screen mounted while that read is in flight.
      if (state.progressOwnerKey === action.ownerKey) return { ...state, progressError: null };
      return {
        ...state,
        claims: {},
        progressOwnerKey: action.ownerKey,
        claimRevision: 0,
        claimRevisionByPark: {},
        progressReady: false,
        progressError: null,
        selectedId: null,
        tripId: null,
        shareClaimId: null,
        pendingPhoto: null,
        focusId: null,
        screen: ["camera", "claim", "share"].includes(state.screen) ? "map" : state.screen,
      };
    case "progressLoaded":
      if (state.progressOwnerKey !== action.ownerKey) return state;
      {
        const claimRevisionAtStart = action.claimRevisionAtStart ?? state.claimRevision;
        const claims = { ...action.claims };
        // A refresh may have started just before a new durable claim committed.
        // Preserve only claims written after that read began. Later fresh reads
        // can still replace them with a newer visit restored from another device.
        for (const [parkId, revision] of Object.entries(state.claimRevisionByPark)) {
          const localClaim = state.claims[parkId];
          if (revision > claimRevisionAtStart && localClaim) claims[parkId] = localClaim;
        }
        return { ...state, claims, progressReady: true, progressError: null };
      }
    case "progressFailed":
      if (state.progressOwnerKey !== action.ownerKey) return state;
      if (state.progressReady) return { ...state, progressError: action.message };
      return { ...state, claims: {}, progressReady: false, progressError: action.message };
    case "reset":
      // The demo reset replays onboarding, while a visitor's personal collection
      // remains in its owner partition and must not be cleared by a UI reset.
      return { ...initial, claims: state.claims, progressReady: state.progressReady, progressError: state.progressError, progressOwnerKey: state.progressOwnerKey, claimRevision: state.claimRevision, claimRevisionByPark: state.claimRevisionByPark };
  }
}

const Ctx = createContext<{ state: State; dispatch: (a: Action) => void } | null>(null);

function ownerForAuth(phase: string, accountId: string | null): ProgressOwner | null {
  if (phase === "guest") return { kind: "guest" };
  if ((phase === "authenticated" || phase === "offline-account") && accountId) return { kind: "account", accountId };
  return null;
}

export function progressOwnerKey(owner: ProgressOwner | null) {
  if (!owner) return null;
  return owner.kind === "guest" ? "guest" : `account:${owner.accountId.toLowerCase()}`;
}

export function projectClaims(claims: Awaited<ReturnType<typeof loadPersonalProgress>>["claims"], photos: Record<string, string>): Record<string, Claim> {
  const projected: Record<string, Claim> = {};
  // Rows are sorted oldest to newest. The badge shows the latest visit while the
  // personal store retains every historical claim UUID for backup and restore.
  for (const claim of claims) {
    projected[claim.parkId] = { claimId: claim.claimId, at: claim.claimedAt, photo: photos[claim.parkId] ?? "", parkSnapshot: claim.parkSnapshot, contentReleaseId: claim.contentReleaseId };
  }
  return projected;
}

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, undefined, load);
  const auth = useAuth();
  const owner = useMemo(() => ownerForAuth(auth.phase, auth.ownerAccountId), [auth.phase, auth.ownerAccountId]);
  const key = progressOwnerKey(owner);
  const currentOwnerKey = useRef(key);
  currentOwnerKey.current = key;

  useEffect(() => {
    if (!owner || !key) {
      dispatch({ type: "progressLoading", ownerKey: null });
      return;
    }
    dispatch({ type: "progressLoading", ownerKey: key });
    let live = true;
    const claimRevisionAtStart = state.progressOwnerKey === key ? state.claimRevision : 0;
    void loadPersonalProgress(owner).then(({ claims, photos }) => {
      if (live && currentOwnerKey.current === key) dispatch({ type: "progressLoaded", ownerKey: key, claims: projectClaims(claims, photos), claimRevisionAtStart });
    }).catch(() => {
      if (live && currentOwnerKey.current === key) dispatch({ type: "progressFailed", ownerKey: key, message: "Saved progress could not be opened. Retry from your account." });
    });
    return () => { live = false; };
  }, [key, owner, auth.progressRevision, state.claimRevision]);

  useEffect(() => {
    if (auth.phase === "starting" || auth.phase === "error") return;
    const { onboarded, muted } = state;
    try {
      // Preserve the legacy claims blob for transactional migration and recovery.
      // It is never rewritten from an account-specific in-memory projection.
      const existing = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Record<string, unknown>;
      localStorage.setItem(KEY, JSON.stringify({ ...existing, onboarded, muted }));
    } catch {
      // Storage can be unavailable in private modes; the active session still works.
    }
  }, [auth.phase, state.onboarded, state.muted]);

  const wrapped = useCallback((action: Action) => dispatch(action), []);
  const visibleState = state.progressOwnerKey === key ? state : {
    ...state,
    claims: {},
    progressReady: false,
    progressError: null,
    selectedId: null,
    tripId: null,
    shareClaimId: null,
    pendingPhoto: null,
  };

  return <Ctx.Provider value={{ state: visibleState, dispatch: wrapped }}>{children}</Ctx.Provider>;
}

export function useStore() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useStore outside StoreProvider");
  return ctx;
}
