import { AnimatePresence, MotionConfig } from "motion/react";
import { useEffect } from "react";
import { BottomNav } from "./components/BottomNav";
import { ToastProvider } from "./components/Toast";
import { setMuted } from "./lib/feedback";
import { StoreProvider, useStore } from "./lib/store";
import { Camera } from "./screens/Camera";
import { Claim } from "./screens/Claim";
import { Collection } from "./screens/Collection";
import { Gallery } from "./screens/Gallery";
import { MapScreen } from "./screens/map/MapScreen";
import { Onboarding } from "./screens/Onboarding";
import { Share } from "./screens/Share";
import { Splash } from "./screens/Splash";

export function App() {
  if (location.hash === "#gallery") return <Gallery />;
  return (
    <MotionConfig reducedMotion="user">
      <StoreProvider>
        <Stage />
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
  const { state } = useStore();
  const { screen, onboarded } = state;

  useEffect(() => setMuted(state.muted), [state.muted]);

  const showMap = onboarded && screen !== "splash" && screen !== "onboarding";
  const showNav = showMap && (screen === "map" || screen === "collection");

  return (
    <>
      {showMap && <MapScreen />}
      <AnimatePresence>{screen === "collection" && <Collection key="collection" />}</AnimatePresence>
      <AnimatePresence>{showNav && <BottomNav key="nav" />}</AnimatePresence>
      <AnimatePresence>
        {screen === "camera" && <Camera key="camera" />}
        {screen === "claim" && <Claim key="claim" />}
        {screen === "share" && <Share key="share" />}
      </AnimatePresence>
      <AnimatePresence>{screen === "onboarding" && <Onboarding key="onboarding" />}</AnimatePresence>
      <AnimatePresence>{screen === "splash" && <Splash key="splash" />}</AnimatePresence>
    </>
  );
}
