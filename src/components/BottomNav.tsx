import { AnimatePresence, motion } from "motion/react";
import { parkContaining, useBoundaries } from "../lib/boundaries";
import { buzz, sfx } from "../lib/feedback";
import { getParkRarityEligibility, getRarityProgress } from "../lib/progression";
import { rarityLockMessage } from "../lib/rarityUi";
import { useStore } from "../lib/store";
import { useContent } from "../lib/content/provider";
import { isUsableGpsAccuracy } from "../lib/geo";
import { Icon } from "./Icon";

export function BottomNav() {
  const { state, dispatch } = useStore();
  const content = useContent();
  const bounds = useBoundaries();
  const accuracy = state.locationError !== "denied" && isUsableGpsAccuracy(state.accuracy) ? state.accuracy : 0;
  const here = parkContaining(state.user, content?.parks ?? [], bounds?.byId, accuracy);
  const progress = getRarityProgress(state.claims, content?.parkById);
  const eligibility = here && state.progressReady ? getParkRarityEligibility(here, progress, !!state.claims[here.id]) : null;
  const canClaim = !!here && !state.claims[here.id] && !!eligibility?.eligible && eligibility.reason !== "already-earned";
  const tab = state.screen === "collection" ? "collection" : "map";

  const go = (screen: "map" | "collection") => {
    if (screen === state.screen) return;
    sfx.tap();
    buzz(8);
    dispatch({ type: "go", screen });
  };

  const fab = () => {
    sfx.pop();
    buzz(12);
    if (canClaim) {
      dispatch({ type: "trip", id: here.id });
      dispatch({ type: "select", id: null });
      dispatch({ type: "go", screen: "camera" });
    } else {
      dispatch({ type: "go", screen: "map" });
      toastless(!here ? "outside" : state.claims[here.id] ? "claimed" : eligibility?.reason === "unavailable" || !state.progressReady ? "progress" : !eligibility?.eligible ? "locked" : "claimed");
    }
  };

  // Outside a park the FAB nudges instead of failing: it wiggles and shows why.
  const toastless = (reason: "claimed" | "outside" | "locked" | "progress") => {
    const el = document.querySelector(".fab__hint");
    el?.setAttribute("data-reason", reason);
    el?.classList.remove("is-on");
    void (el as HTMLElement | null)?.offsetWidth;
    el?.classList.add("is-on");
  };

  return (
    <motion.nav className="nav" initial={{ y: 120 }} animate={{ y: 0 }} exit={{ y: 120 }} transition={{ type: "spring", stiffness: 300, damping: 28 }}>
      <div className="nav__bar">
        {(["map", "collection"] as const).map((t) => (
          <button key={t} className={`nav__tab ${tab === t ? "is-on" : ""}`} onClick={() => go(t)}>
            {tab === t && <motion.span layoutId="nav-pill" className="nav__pill" transition={{ type: "spring", stiffness: 500, damping: 34 }} />}
            <Icon name={t === "map" ? "map" : "case"} size={22} />
            <span>{t === "map" ? "Explore" : "My Dex"}</span>
          </button>
        ))}
      </div>
      <motion.button
        className={`fab ${canClaim ? "fab--live" : ""}`}
        onClick={fab}
        whileTap={{ scale: 0.88 }}
        aria-label={canClaim ? "Check in" : !here ? "Check in, get inside a park first" : state.claims[here.id] ? "Check in, this park is already claimed" : eligibility && (eligibility.reason === "locked" || eligibility.reason === "unsupported-rarity") ? `Check in unavailable. ${rarityLockMessage(eligibility)}` : "Check in unavailable while saved progress loads"}
      >
        {canClaim && (
          <>
            <span className="fab__ring" />
            <span className="fab__ring fab__ring--2" />
          </>
        )}
        <Icon name="camera" size={28} stroke={2.4} />
        <AnimatePresence>
          {canClaim && (
            <motion.span className="fab__label" initial={{ scale: 0, y: 6 }} animate={{ scale: 1, y: 0 }} exit={{ scale: 0 }} transition={{ type: "spring", stiffness: 600, damping: 18 }}>
              Claim!
            </motion.span>
          )}
        </AnimatePresence>
      </motion.button>
      <span className="fab__hint" />
    </motion.nav>
  );
}
