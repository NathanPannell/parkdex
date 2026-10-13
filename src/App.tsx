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
import { FriendsProvider, useFriends } from "./lib/friends/FriendsProvider";
import { FRIEND_LINK_PREFIX } from "./lib/friends/links";
import { FRIEND_CODE_LENGTH, normalizeSocialCode } from "./lib/social/codes";
import { listenForAppLinks, type AppLinkRoutes } from "./lib/social/links";
import { AddFriendSheet } from "./screens/AddFriendSheet";
import { CrewProvider, useCrew } from "./lib/game/CrewProvider";
import { CREW_CODE_LENGTH, CREW_LINK_PREFIX, crewLinkPark } from "./lib/game/crew";
import { CrewSheets } from "./screens/CrewSheets";
import { HandleSheet } from "./screens/HandleSheet";
import "./game-ui.css";
import "./account.css";
import { ContentProvider, useContentStatus } from "./lib/content/provider";
import { setMuted } from "./lib/feedback";
import { FIELD, isNative, minimizeApp, onBackButton, watchLocation } from "./lib/native";
import { projectClaims, progressOwnerKey, StoreProvider, useStore } from "./lib/store";
import { listPersonalClaims, loadPersonalProgress, setLegacyClaimSnapshot, type ProgressOwner } from "./lib/accounts/personalStore";
import { Camera } from "./screens/Camera";
import { FeedbackSheet } from "./screens/FeedbackSheet";
import { UpdateGate } from "./components/UpdateGate";
import { PortraitOnly } from "./components/PortraitOnly";
import { installOffer, usePortraitPanel, useWebApp } from "./lib/webApp";
import { useKipTip } from "./lib/kipTips";
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
  // On the web a sideways screen is covered by the portrait panel. The app stays mounted behind it.
  const portraitPanel = usePortraitPanel();
  const covered = updateStatus === "required" || !!portraitPanel;
  return (
    <MotionConfig reducedMotion="user">
      <AuthProvider>
        <GameProvider>
          <FriendsProvider>
            <CrewProvider>
              <StoreProvider>
                <div inert={covered} aria-hidden={covered} style={{ display: "contents" }}>
                  <ContentProvider><Stage /></ContentProvider>
                </div>
                <UpdateGate status={updateStatus} />
              </StoreProvider>
            </CrewProvider>
          </FriendsProvider>
        </GameProvider>
      </AuthProvider>
      <PortraitOnly panel={portraitPanel} />
    </MotionConfig>
  );
}

function Stage() {
  return (
    <>
      <ClaimSnapshotRestorer />
      {/* The app's root box. It fills the viewport at every width; sheets, toasts and confetti are placed inside it. */}
      <div className="device">
        <ToastProvider>
          <Screens />
        </ToastProvider>
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
  const friends = useFriends();
  const crew = useCrew();
  const [locationRetry, setLocationRetry] = useState(0);
  const { screen, onboarded } = state;
  // A link to open once the app is past the splash and onboarding.
  const linkTarget = useRef<"leaderboard" | "map" | null>(null);
  const linkTries = useRef(0);
  const openIncoming = useRef(friends.openIncoming);
  openIncoming.current = friends.openIncoming;
  const offerJoin = useRef(crew.offerJoin);
  offerJoin.current = crew.offerJoin;

  // App Links and web paths into the app (src/lib/social/links.ts): friend links (#64) and crew links (#171).
  useEffect(() => {
    const routes: AppLinkRoutes = {};
    if (friends.enabled) {
      routes[FRIEND_LINK_PREFIX] = (value) => {
        const code = normalizeSocialCode(value, FRIEND_CODE_LENGTH);
        if (!code) return;
        openIncoming.current(code);
        linkTarget.current = "leaderboard";
      };
    }
    if (crew.enabled) {
      // A crew link opens the map with its join card, which runs the sign-in, handle and in-park checks.
      routes[CREW_LINK_PREFIX] = (value, url) => {
        const code = normalizeSocialCode(value, CREW_CODE_LENGTH);
        if (!code) return;
        offerJoin.current({ code, parkId: crewLinkPark(url), source: "link" });
        linkTarget.current = "map";
      };
    }
    if (!Object.keys(routes).length) return;
    return listenForAppLinks(routes);
  }, [friends.enabled, crew.enabled]);

  // Onboarding can finish with its own move to the map, so keep the target until it shows.
  useEffect(() => {
    if (!linkTarget.current || !state.startupReady || !onboarded || screen === "splash" || screen === "onboarding") return;
    if (screen === linkTarget.current || linkTries.current >= 3) {
      linkTarget.current = null;
      linkTries.current = 0;
      return;
    }
    linkTries.current += 1;
    dispatch({ type: "go", screen: linkTarget.current });
  });

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

  // On a phone's browser, Kip suggests the home screen version once it can be installed.
  // Settings keeps the Install Parkdex row for later.
  const webApp = useWebApp();
  useKipTip("install-web", state.startupReady && onboarded && screen === "map" && installOffer(webApp) !== null);

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
      {crew.enabled && <CrewSheets />}
      {friends.enabled && <AddFriendSheet />}
      <AnimatePresence>{game.handleRequest && game.accountId && <HandleSheet key="handle" />}</AnimatePresence>
      <KipTipHost paused={!state.startupReady || !onboarded || screen === "onboarding" || screen === "splash"} />
      <AnimatePresence>{screen === "onboarding" && <Onboarding key="onboarding" />}</AnimatePresence>
      <AnimatePresence>{screen === "splash" && <Splash key="splash" />}</AnimatePresence>
    </>
  );
}
