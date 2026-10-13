import { AnimatePresence, MotionConfig } from "motion/react";
import { AnimatePresence as Presence, motion } from "motion/react";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { BottomNav } from "./components/BottomNav";
import { KipTipHost } from "./components/KipTip";
import { ToastProvider } from "./components/Toast";
import { clearConfetti } from "./lib/confetti";
import { AuthProvider, useAuth } from "./lib/accounts/AuthProvider";
import { handleBack } from "./lib/backStack";
import { GameProvider, useGame } from "./lib/game/GameProvider";
import { HandleSheet } from "./screens/HandleSheet";
import "./game-ui.css";
import "./account.css";
import { ContentProvider, useContentStatus } from "./lib/content/provider";
import { setMuted } from "./lib/feedback";
import { FIELD, isNative, minimizeApp, onBackButton, watchLocation } from "./lib/native";
import { DEMO_TOOLS } from "./lib/demo";
import { projectClaims, progressOwnerKey, StoreProvider, useStore } from "./lib/store";
import { listPersonalClaims, loadPersonalProgress, setLegacyClaimSnapshot, type ProgressOwner } from "./lib/accounts/personalStore";
import { Camera } from "./screens/Camera";
import { FeedbackSheet } from "./screens/FeedbackSheet";
import { UpdateGate } from "./components/UpdateGate";
import { currentUpdateStatus, subscribeUpdateStatus } from "./lib/appConfig";
import { notifyOverTheAirReady } from "./lib/ota";
import { Account } from "./screens/Account";
import { ManageDownloads } from "./screens/ManageDownloads";
import { Settings } from "./screens/Settings";
import { MapScreen } from "./screens/map/MapScreen";
import { Onboarding } from "./screens/Onboarding";
import { Leaderboard } from "./screens/Leaderboard";
import { Plant } from "./screens/Plant";
import { backCanLeavePlant, leavePlant } from "./lib/game/plantExit";
import { FoundingDecisionSheet, useFoundingDecisions } from "./screens/FoundingDecisionSheet";
import { TakeoverMessages } from "./screens/TakeoverSheet";
import { YourParks } from "./screens/YourParks";
import { Splash } from "./screens/Splash";

export function App() {
  const updateStatus = useSyncExternalStore(subscribeUpdateStatus, currentUpdateStatus, currentUpdateStatus);
  return (
    <MotionConfig reducedMotion="user">
      <AuthProvider>
        <GameProvider>
          <StoreProvider>
            <div inert={updateStatus === "required"} aria-hidden={updateStatus === "required"} style={{ display: "contents" }}>
              <ContentProvider><Stage /></ContentProvider>
            </div>
            <UpdateGate status={updateStatus} />
          </StoreProvider>
        </GameProvider>
      </AuthProvider>
    </MotionConfig>
  );
}

function Stage() {
  return (
    <>
      <ClaimSnapshotRestorer />
      <div className="stage">
        <aside className="stage-note">
          <h1>Parkdex</h1>
          {DEMO_TOOLS ? (
            <>
              <p>A development build of the core loop: pick a park, go there, check in inside the boundary and plant your flag.</p>
              <p>
                Use the <kbd>wand</kbd> in the map menu for demo controls, or tap <kbd>Demo: simulate trip</kbd> after choosing a park.
              </p>
            </>
          ) : (
            <>
              <p>Plant your flag in real parks. Go to a park and your flag goes up. You earn a point for every day it flies, until someone takes it.</p>
              <p>
                Parkdex is made for your phone. <a href="https://parkdex.app/#beta-access" target="_blank" rel="noopener noreferrer">Get the Android app</a> to play where you are.
              </p>
            </>
          )}
        </aside>
        <div className="device">
          <ToastProvider>
            <Screens />
          </ToastProvider>
        </div>
      </div>
    </>
  );
}

function ClaimSnapshotRestorer() {
  const { state, dispatch } = useStore();
  const auth = useAuth();
  const content = useContentStatus().snapshot;
  const owner = useMemo<ProgressOwner | null>(() => {
    if (auth.phase === "guest") return { kind: "guest" };
    if ((auth.phase === "authenticated" || auth.phase === "offline-account") && auth.ownerAccountId) return { kind: "account", accountId: auth.ownerAccountId };
    return null;
  }, [auth.phase, auth.ownerAccountId]);
  const ownerKey = progressOwnerKey(owner);
  const attemptKey = useRef<string | null>(null);

  useEffect(() => {
    if (!owner || !ownerKey || !content || !state.progressReady || state.progressOwnerKey !== ownerKey) return;
    const currentAttempt = `${ownerKey}:${content.releaseId}:${auth.progressRevision}`;
    if (attemptKey.current === currentAttempt) return;
    attemptKey.current = currentAttempt;
    let live = true;
    void (async () => {
      try {
        const claims = await listPersonalClaims(owner);
        let changed = false;
        for (const claim of claims) {
          if (claim.parkSnapshot) continue;
          const currentPark = content.liveParks.find((candidate) => candidate.id === claim.parkId);
          const park = currentPark ?? content.retiredParks.find((candidate) => candidate.id === claim.parkId);
          if (!park) continue;
          await setLegacyClaimSnapshot(owner, claim.claimId, park, claim.contentReleaseId);
          changed = true;
        }
        if (!live || !changed) return;
        const restored = await loadPersonalProgress(owner);
        if (!live || state.progressOwnerKey !== ownerKey) return;
        dispatch({ type: "progressLoaded", ownerKey, claims: projectClaims(restored.claims, restored.photos), claimRevisionAtStart: state.claimRevision });
        if (owner.kind === "account" && auth.phase === "authenticated" && auth.ownerAccountId?.toLowerCase() === owner.accountId.toLowerCase()) void auth.syncBackup({ retryAfterFlight: true });
      } catch {
        if (live) attemptKey.current = null;
      }
    })();
    return () => { live = false; };
  }, [auth.ownerAccountId, auth.phase, auth.progressRevision, auth.syncBackup, content, dispatch, owner, ownerKey, state.progressOwnerKey, state.progressReady]);

  return null;
}

function Screens() {
  const { state, dispatch } = useStore();
  const auth = useAuth();
  const game = useGame();
  const [locationRetry, setLocationRetry] = useState(0);
  const { screen, onboarded } = state;

  // The providers and first screen have rendered, so this bundle works and must not be rolled back.
  useEffect(() => notifyOverTheAirReady(), []);

  useEffect(() => {
    if (state.startupReady && auth.pendingAction) dispatch({ type: "go", screen: "account" });
  }, [auth.pendingAction, dispatch, state.startupReady]);

  useEffect(() => setMuted(state.muted), [state.muted]);
  useEffect(() => {
    if (screen !== "plant") clearConfetti();
  }, [screen]);

  // The badge claim screen is retired. The old camera check-in can still ask for it; send it home.
  useEffect(() => {
    if (screen === "claim") dispatch({ type: "go", screen: "map" });
  }, [dispatch, screen]);

  // Real GPS drives check-ins in field builds and on-device; the web demo keeps its demo spot.
  const tracking = state.startupReady && onboarded && (FIELD || isNative);
  useEffect(() => {
    if (!tracking) return;
    let stop = () => {};
    let live = true;
    void watchLocation(
      (fix) => dispatch({ type: "move", user: fix.point, accuracy: fix.accuracy }),
      (error) => dispatch({ type: "locationError", error }),
    ).then((s) => (live ? (stop = s) : s()));
    return () => {
      live = false;
      stop();
    };
  }, [tracking, locationRetry]);

  // Android back closes the top layer first, then leaves the app from the map.
  const latest = useRef(state);
  latest.current = state;
  const latestGame = useRef(game);
  latestGame.current = game;
  useEffect(
    () =>
      onBackButton(() => {
        const s = latest.current;
        if (latestGame.current.handleRequest) latestGame.current.closeHandleSheet();
        else if (handleBack()) return;
        else if (s.feedback) dispatch({ type: "feedback", open: false });
        else if (s.selectedId) dispatch({ type: "select", id: null });
        else if (s.screen === "plant") {
          if (backCanLeavePlant()) for (const action of leavePlant(s.tripId)) dispatch(action);
        }
        else if (s.screen === "account") dispatch({ type: "go", screen: s.onboarded ? "map" : "onboarding" });
        else if (s.screen === "downloads") dispatch({ type: "go", screen: "settings" });
        else if (s.screen !== "map" && s.screen !== "onboarding" && s.screen !== "splash") dispatch({ type: "go", screen: "map" });
        else minimizeApp();
      }),
    [],
  );

  // Mount the map behind the splash so saved pins and tiles can warm while the
  // opening animation plays. Keep the same map instance when the splash leaves.
  const showMap = state.startupReady && onboarded && screen !== "onboarding" && screen !== "account";
  // Settings pages cover the map but keep it mounted, so its camera and tiles survive.
  const mapCovered = screen === "plant" || screen === "settings" || screen === "downloads";
  // Your parks, the leaderboard and settings are tabs, so the bar stays on them.
  const showNav = showMap && (screen === "map" || screen === "parks" || screen === "leaderboard" || screen === "settings");

  // Messages on open: review decisions first, then parks taken while away.
  const messagesAllowed = state.startupReady && onboarded && !game.handleRequest && (screen === "map" || screen === "parks" || screen === "leaderboard");
  const decisions = useFoundingDecisions(messagesAllowed);

  return (
    <>
      {showMap && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            visibility: mapCovered ? "hidden" : "visible",
          }}
          inert={screen === "splash" || mapCovered}
          aria-hidden={screen === "splash" || mapCovered}
        >
          <MapScreen />
        </div>
      )}
      <AnimatePresence>{screen === "parks" && <YourParks key="parks" />}</AnimatePresence>
      <AnimatePresence>{screen === "leaderboard" && <Leaderboard key="leaderboard" />}</AnimatePresence>
      <AnimatePresence>{screen === "account" && <Account key="account" onBack={() => dispatch({ type: "go", screen: onboarded ? "map" : "onboarding" })} />}</AnimatePresence>
      <AnimatePresence>{screen === "settings" && <Settings key="settings" tabbed />}</AnimatePresence>
      <AnimatePresence>{screen === "downloads" && <ManageDownloads key="downloads" />}</AnimatePresence>
      <AnimatePresence>{showNav && <BottomNav key="nav" />}</AnimatePresence>
      <Presence>
        {tracking && state.locationError === "denied" && screen === "map" && (
          <motion.div key="loc" className="loc-off card" initial={{ y: -40, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: -40, opacity: 0 }}>
            <strong>Location is off</strong>
            <span>Parkdex needs your location to check you in at parks. Turn it on in Settings, then try again.</span>
            <button className="btn btn--sm" onClick={() => setLocationRetry((n) => n + 1)}>
              Try again
            </button>
          </motion.div>
        )}
      </Presence>
      <AnimatePresence>
        {screen === "camera" && <Camera key="camera" />}
        {screen === "plant" && <Plant key="plant" />}
      </AnimatePresence>
      <AnimatePresence>{state.feedback && <FeedbackSheet key="feedback" origin={state.feedback} />}</AnimatePresence>
      <FoundingDecisionSheet decision={decisions.current} onDismiss={decisions.dismiss} />
      <TakeoverMessages allowed={messagesAllowed && !decisions.current} />
      <AnimatePresence>{game.handleRequest && game.accountId && <HandleSheet key="handle" />}</AnimatePresence>
      <KipTipHost paused={!state.startupReady || !onboarded || screen === "onboarding" || screen === "splash"} />
      <AnimatePresence>{screen === "onboarding" && <Onboarding key="onboarding" />}</AnimatePresence>
      <AnimatePresence>{screen === "splash" && <Splash key="splash" />}</AnimatePresence>
    </>
  );
}
