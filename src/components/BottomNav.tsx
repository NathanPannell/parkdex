import { AnimatePresence, motion } from "motion/react";
import { parkContaining, useBoundaries } from "../lib/boundaries";
import { buzz, sfx } from "../lib/feedback";
import { useStore } from "../lib/store";
import { Icon } from "./Icon";

export function BottomNav() {
  const { state, dispatch } = useStore();
  const bounds = useBoundaries();
  const here = parkContaining(state.user, bounds?.byId);
  const canClaim = !!here && !state.claims[here.id];
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
      toastless(here ? "claimed" : "outside");
    }
  };

  // Outside a park the FAB nudges instead of failing: it wiggles and shows why.
  const toastless = (reason: "claimed" | "outside") => {
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
            <span>{t === "map" ? "Explore" : "My case"}</span>
          </button>
        ))}
      </div>
      <motion.button className={`fab ${canClaim ? "fab--live" : ""}`} onClick={fab} whileTap={{ scale: 0.88 }} aria-label={canClaim ? "Check in" : "Check in (get inside a park first)"}>
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
