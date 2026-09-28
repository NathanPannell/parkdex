import { AnimatePresence, MotionConfig } from "motion/react";
import { AnimatePresence as Presence, motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { BottomNav } from "./components/BottomNav";
import { ToastProvider } from "./components/Toast";
import { clearConfetti } from "./lib/confetti";
import { ContentProvider } from "./lib/content/provider";
import { setMuted } from "./lib/feedback";
import { FIELD, isNative, minimizeApp, onBackButton, watchLocation } from "./lib/native";
import { StoreProvider, useStore } from "./lib/store";
import { Camera } from "./screens/Camera";
import { Claim } from "./screens/Claim";
import { Collection } from "./screens/Collection";
import { FeedbackSheet } from "./screens/FeedbackSheet";
import { Gallery } from "./screens/Gallery";
import { MapScreen } from "./screens/map/MapScreen";
import { Onboarding } from "./screens/Onboarding";
import { Share } from "./screens/Share";
import { Splash } from "./screens/Splash";

export function App() {
  return (
    <MotionConfig reducedMotion="user">
      <StoreProvider>
        <ContentProvider>{location.hash === "#gallery" ? <Gallery /> : <Stage />}</ContentProvider>
      </StoreProvider>
    </MotionConfig>
  );
}

function Stage() {
  return (
    <div className="stage">
      <aside className="stage-note">
        <h1>Parkdex</h1>
        <p>A mobile UI mockup of the core loop: pick a park, go there, check in inside the boundary, snap a photo, claim the badge, share it.</p>
        <p>
          Use the <kbd>wand</kbd> on the map for demo controls, or tap <kbd>Demo: simulate trip</kbd> after choosing a park.
        </p>
      </aside>
      <div className="device">
        <ToastProvider>
          <Screens />
        </ToastProvider>
      </div>
    </div>
  );
}

function Screens() {
  const { state, dispatch } = useStore();
  const [locationRetry, setLocationRetry] = useState(0);
  const { screen, onboarded } = state;

  useEffect(() => setMuted(state.muted), [state.muted]);
  useEffect(() => {
    if (screen !== "claim") clearConfetti();
  }, [screen]);

  // Real GPS drives check-ins in field builds and on-device; the web demo keeps its demo spot.
  const tracking = onboarded && (FIELD || isNative);
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
  useEffect(
    () =>
      onBackButton(() => {
        const s = latest.current;
        if (s.feedback) dispatch({ type: "feedback", open: false });
        else if (s.selectedId) dispatch({ type: "select", id: null });
        else if (s.screen === "claim") dispatch({ type: "go", screen: "map" });
        else if (s.screen !== "map" && s.screen !== "onboarding" && s.screen !== "splash") dispatch({ type: "go", screen: "map" });
        else minimizeApp();
      }),
    [],
  );

  const showMap = onboarded && screen !== "splash" && screen !== "onboarding";
  const showNav = showMap && (screen === "map" || screen === "collection");

  return (
    <>
      {showMap && <MapScreen />}
      <AnimatePresence>{screen === "collection" && <Collection key="collection" />}</AnimatePresence>
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
        {screen === "claim" && <Claim key="claim" />}
        {screen === "share" && <Share key="share" />}
      </AnimatePresence>
      <AnimatePresence>{state.feedback && <FeedbackSheet key="feedback" origin={state.feedback} />}</AnimatePresence>
      <AnimatePresence>{screen === "onboarding" && <Onboarding key="onboarding" />}</AnimatePresence>
      <AnimatePresence>{screen === "splash" && <Splash key="splash" />}</AnimatePresence>
    </>
  );
}
