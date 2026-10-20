import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, type ReactNode } from "react";
import type { LngLat } from "./geo";
import type { Park } from "./parks";
import { loadPersonalProgress, type ProgressOwner } from "./accounts/personalStore";
import { useAuth } from "./accounts/AuthProvider";
import { getNativeInstallIdentity, isNative } from "./native";
import { onboardingMatchesInstall } from "./onboardingIdentity";
import { isOverTheAirBundle } from "./ota";
import { readLastLocation } from "./lastLocation";
import { webLocationAllowed } from "./liveLocation";
import { isPointInsideContentBounds } from "./content/contracts";

export type Claim = { claimId: string; at: string; photo: string; parkSnapshot: Park | null; contentReleaseId: string | null };

// "claim" is retired; App sends it back to the map. The old camera check-in still names it.
export type Screen = "splash" | "onboarding" | "map" | "camera" | "claim" | "account" | "settings" | "downloads" | "plant" | "parks" | "leaderboard";

/**
 * What a signed-out player was doing when the app sent them to sign in. Once they are signed
 * in, the map picks it up again: the handle sheet if they need one, then the visit, the crew
 * join or founding they asked for.
 */
export type Resume = { kind: "visit"; parkId: string } | { kind: "join"; parkId: string; code: string } | { kind: "found"; parkId: string | null };

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
  // The player's last real position, from a fix or the one saved last time. Demo moves
  // (teleports, simulated trips) never change it. Null when Parkdex has never had one.
  located: LngLat | null;
  locationError: string | null;
  // The hosted web app follows the player only after they allow location (src/lib/liveLocation.ts).
  webLocation: boolean;
  muted: boolean;
  screen: Screen;
  startupReady: boolean;
  onboardingBuildId: string | null;
  onboardingPackageIdentity: string | null;
  currentBuildId: string | null;
  currentPackageIdentity: string | null;
  selectedId: string | null;
  tripId: string | null;
  pendingPhoto: string | null;
  focusId: string | null;
  // Whether a focus request opens the park's page, or only settles the map on it.
  focusOpen: boolean;
  feedback: FeedbackOrigin | null;
  resume: Resume | null;
  // The screen Account & backup was opened from, so Back returns there.
  accountFrom: Screen | null;
};

export type Action =
  | { type: "go"; screen: Screen }
  | { type: "installReady"; buildId: string; packageInstallIdentity: string | null; native: boolean; overTheAir?: boolean }
  | { type: "onboarded" }
  | { type: "select"; id: string | null }
  | { type: "trip"; id: string | null }
  | { type: "move"; user: LngLat; accuracy?: number | null }
  | { type: "locationError"; error: string | null }
  | { type: "webLocation"; allowed: boolean }
  | { type: "photo"; photo: string | null }
  | { type: "claim"; ownerKey: string; id: string; claimId: string; at: string; photo: string; parkSnapshot: Park; contentReleaseId: string | null }
  | { type: "focus"; id: string | null; open?: boolean }
  | { type: "signInFor"; resume: Resume }
  | { type: "resume"; resume: Resume | null }
  | { type: "mute" }
  | { type: "feedback"; open: boolean; parkId?: string | null }
  | { type: "progressLoading"; ownerKey: string | null }
  | { type: "progressLoaded"; ownerKey: string; claims: Record<string, Claim>; claimRevisionAtStart?: number; metadataOnly?: boolean }
  | { type: "progressFailed"; ownerKey: string; message: string }
  | { type: "reset" };

// Downtown Victoria: the demo spot for testers without GPS and players outside every
// supported province. A real location inside the content areas always wins over it.
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
  located: null,
  locationError: null,
  webLocation: false,
  muted: false,
  screen: "splash",
  startupReady: false,
  onboardingBuildId: null,
  onboardingPackageIdentity: null,
  currentBuildId: null,
  currentPackageIdentity: null,
  selectedId: null,
  tripId: null,
  pendingPhoto: null,
  focusId: null,
  focusOpen: true,
  feedback: null,
  resume: null,
  accountFrom: null,
};

export function load(): State {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? "null");
    if (!saved || typeof saved !== "object") return { ...initial, ...savedLocation() };
    // Claims and photos are migrated transactionally by personalStore. Never project
    // the legacy unpartitioned records into the UI before an owner is known.
    return {
      ...initial,
      ...savedLocation(),
      webLocation: webLocationAllowed(),
      onboarded: !!saved.onboarded,
      muted: !!saved.muted,
      onboardingBuildId: typeof saved.onboardingBuildId === "string" ? saved.onboardingBuildId : null,
      onboardingPackageIdentity: typeof saved.onboardingPackageIdentity === "string" ? saved.onboardingPackageIdentity : null,
    };
  } catch {
    return initial;
  }
}

/** Starts from the last real position inside the content areas, rather than the demo spot. */
function savedLocation(): Pick<State, "user" | "located"> {
  const last = readLastLocation();
  return last && isPointInsideContentBounds(last) ? { user: last, located: last } : { user: DEMO_START, located: null };
}

export function persistOnboardingPreferences(
  storage: Pick<Storage, "getItem" | "setItem">,
  state: Pick<State, "onboarded" | "muted" | "currentBuildId" | "currentPackageIdentity">,
) {
  try {
    // Preserve the legacy claims blob for transactional migration and recovery.
    // It is never rewritten from an account-specific in-memory projection.
    const existing = JSON.parse(storage.getItem(KEY) ?? "{}") as Record<string, unknown>;
    const saved: Record<string, unknown> = { ...existing, onboarded: state.onboarded, muted: state.muted };
    if (state.onboarded) {
      saved.onboardingBuildId = state.currentBuildId;
      saved.onboardingPackageIdentity = state.currentPackageIdentity;
    }
    storage.setItem(KEY, JSON.stringify(saved));
  } catch {
    // Storage can be unavailable in private modes; the active session still works.
  }
}

export function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "go":
      if (action.screen === "account" && state.screen !== "account") return { ...state, screen: action.screen, accountFrom: state.screen };
      return { ...state, screen: action.screen };
    case "signInFor":
      return {
        ...state,
        resume: action.resume,
        selectedId: null,
        screen: "account",
        accountFrom: state.screen === "account" ? state.accountFrom : state.screen,
      };
    case "resume":
      return { ...state, resume: action.resume };
    case "installReady": {
      const packageInstallIdentity = action.packageInstallIdentity;
      const onboarded = onboardingMatchesInstall(
        {
          onboarded: state.onboarded,
          buildId: state.onboardingBuildId,
          packageInstallIdentity: state.onboardingPackageIdentity,
        },
        { buildId: action.buildId, packageInstallIdentity, native: action.native, overTheAir: action.overTheAir },
      );
      return {
        ...state,
        onboarded,
        startupReady: true,
        currentBuildId: action.buildId,
        currentPackageIdentity: packageInstallIdentity,
        screen: "splash",
      };
    }
    case "onboarded":
      if (!state.startupReady) return state;
      return { ...state, onboarded: true, screen: "map" };
    case "select":
      return { ...state, selectedId: action.id };
    case "trip":
      return { ...state, tripId: action.id };
    case "move":
      return {
        ...state,
        user: action.user,
        accuracy: action.accuracy === undefined ? state.accuracy : action.accuracy,
        // Only a move that carries a fix's accuracy is a real position.
        located: typeof action.accuracy === "number" ? action.user : state.located,
        locationError: null,
      };
    case "locationError":
      return { ...state, locationError: action.error };
    case "webLocation":
      return { ...state, webLocation: action.allowed, locationError: action.allowed ? state.locationError : null };
    case "photo":
      return { ...state, pendingPhoto: action.photo };
    case "claim": {
      if (state.progressOwnerKey !== action.ownerKey) return state;
      const claimRevision = state.claimRevision + 1;
      return {
        ...state,
        claims: {
          ...state.claims,
          [action.id]: {
            claimId: action.claimId,
            at: action.at,
            photo: action.photo,
            parkSnapshot: action.parkSnapshot,
            contentReleaseId: action.contentReleaseId,
          },
        },
        claimRevision,
        claimRevisionByPark: { ...state.claimRevisionByPark, [action.id]: claimRevision },
        tripId: null,
        pendingPhoto: null,
      };
    }
    case "focus":
      return { ...state, focusId: action.id, focusOpen: action.open ?? true };
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
        pendingPhoto: null,
        focusId: null,
        screen: ["camera", "claim", "plant"].includes(state.screen) ? "map" : state.screen,
      };
    case "progressLoaded":
      if (state.progressOwnerKey !== action.ownerKey) return state;
      {
        const claimRevisionAtStart = action.claimRevisionAtStart ?? state.claimRevision;
        const claims = { ...action.claims };
        // A metadata-only refresh must not blank a photo already shown for the
        // same durable claim while photo bytes are still being converted.
        if (action.metadataOnly) {
          for (const [parkId, claim] of Object.entries(claims)) {
            const current = state.claims[parkId];
            if (current?.claimId === claim.claimId && !claim.photo && current.photo) {
              claims[parkId] = { ...claim, photo: current.photo };
            }
          }
        }
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
      return {
        ...initial,
        startupReady: state.startupReady,
        onboardingBuildId: state.onboardingBuildId,
        onboardingPackageIdentity: state.onboardingPackageIdentity,
        currentBuildId: state.currentBuildId,
        currentPackageIdentity: state.currentPackageIdentity,
        claims: state.claims,
        progressReady: state.progressReady,
        progressError: state.progressError,
        progressOwnerKey: state.progressOwnerKey,
        claimRevision: state.claimRevision,
        claimRevisionByPark: state.claimRevisionByPark,
      };
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
    projected[claim.parkId] = {
      claimId: claim.claimId,
      at: claim.claimedAt,
      photo: photos[claim.parkId] ?? "",
      parkSnapshot: claim.parkSnapshot,
      contentReleaseId: claim.contentReleaseId,
    };
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
    let live = true;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const unavailable = new Promise<null>((resolve) => {
      timeout = setTimeout(() => resolve(null), 1500);
    });
    void Promise.race([getNativeInstallIdentity(), unavailable])
      .then((packageInstallIdentity) => {
        if (live) dispatch({ type: "installReady", buildId: __APP_BUILD__, packageInstallIdentity, native: isNative, overTheAir: isOverTheAirBundle() });
      })
      .catch(() => {
        if (live) dispatch({ type: "installReady", buildId: __APP_BUILD__, packageInstallIdentity: null, native: isNative, overTheAir: isOverTheAirBundle() });
      })
      .finally(() => {
        clearTimeout(timeout);
      });
    return () => {
      live = false;
      clearTimeout(timeout);
    };
  }, []);

  useEffect(() => {
    if (!owner || !key) {
      dispatch({ type: "progressLoading", ownerKey: null });
      return;
    }
    dispatch({ type: "progressLoading", ownerKey: key });
    let live = true;
    let metadataPublished = false;
    const claimRevisionAtStart = state.progressOwnerKey === key ? state.claimRevision : 0;
    void loadPersonalProgress(owner, (claims) => {
      metadataPublished = true;
      if (live && currentOwnerKey.current === key) {
        dispatch({
          type: "progressLoaded",
          ownerKey: key,
          claims: projectClaims(claims, {}),
          claimRevisionAtStart,
          metadataOnly: true,
        });
      }
    })
      .then(({ claims, photos }) => {
        if (live && currentOwnerKey.current === key)
          dispatch({ type: "progressLoaded", ownerKey: key, claims: projectClaims(claims, photos), claimRevisionAtStart });
      })
      .catch(() => {
        if (live && currentOwnerKey.current === key)
          dispatch({
            type: "progressFailed",
            ownerKey: key,
            message: metadataPublished
              ? "Some saved photos could not be opened. Your saved parks are still available."
              : "Saved progress could not be opened. Retry from your account.",
          });
      });
    return () => {
      live = false;
    };
  }, [key, owner, auth.progressRevision, state.claimRevision]);

  useEffect(() => {
    if (!state.startupReady || auth.phase === "starting" || auth.phase === "error") return;
    persistOnboardingPreferences(localStorage, state);
  }, [auth.phase, state.startupReady, state.onboarded, state.muted, state.currentBuildId, state.currentPackageIdentity]);

  const wrapped = useCallback((action: Action) => dispatch(action), []);
  const visibleState =
    state.progressOwnerKey === key
      ? state
      : {
          ...state,
          claims: {},
          progressReady: false,
          progressError: null,
          selectedId: null,
          tripId: null,
          pendingPhoto: null,
        };

  return <Ctx.Provider value={{ state: visibleState, dispatch: wrapped }}>{children}</Ctx.Provider>;
}

export function useStore() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useStore outside StoreProvider");
  return ctx;
}
