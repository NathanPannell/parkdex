import { AnimatePresence, motion } from "motion/react";
import { parkContaining, useBoundaries } from "../lib/boundaries";
import { buzz, sfx } from "../lib/feedback";
import { getParkRarityEligibility, getRarityProgress } from "../lib/progression";
import { rarityLockMessage } from "../lib/rarityUi";
import { useStore } from "../lib/store";
import { mapParks } from "../lib/parks";
import { useContent } from "../lib/content/provider";
import { isUsableGpsAccuracy } from "../lib/geo";
import { friendsEnabled } from "../lib/social/flag";
import { Icon, type IconName } from "./Icon";

type Tab = "map" | "collection" | "friends" | "settings";
const TAB_LABEL: Record<Tab, { icon: IconName; label: string }> = {
  map: { icon: "map", label: "Explore" },
  collection: { icon: "case", label: "My Dex" },
  friends: { icon: "friends", label: "Friends" },
  settings: { icon: "gear", label: "Settings" },
};

export function BottomNav() {
  const { state, dispatch } = useStore();
  const content = useContent();
  const bounds = useBoundaries();
  const accuracy = state.locationError !== "denied" && isUsableGpsAccuracy(state.accuracy) ? state.accuracy : 0;
  const here = parkContaining(state.user, mapParks(content?.parks ?? [], state.claims), bounds?.byId, accuracy);
  const progress = getRarityProgress(state.claims, content?.parkById);
  const eligibility = here && state.progressReady ? getParkRarityEligibility(here, progress, !!state.claims[here.id]) : null;
  const canClaim = !!here && !state.claims[here.id] && !!eligibility?.eligible && eligibility.reason !== "already-earned";
  // With friends on, four tabs sit two either side of the camera.
  const four = friendsEnabled();
  const left: Tab[] = ["map", "collection"];
  const right: Tab[] = four ? ["friends", "settings"] : [];
  const tab: Tab = (["collection", "friends", "settings"] as Tab[]).includes(state.screen as Tab) ? state.screen as Tab : "map";

  const go = (screen: Tab) => {
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
    <motion.nav className={["nav", four && "nav--four", (tab === "friends" || tab === "settings") && "nav--over"].filter(Boolean).join(" ")} initial={{ y: 120 }} animate={{ y: 0 }} exit={{ y: 120 }} transition={{ type: "spring", stiffness: 300, damping: 28 }}>
      <div className="nav__bar">
        {[...left, ...right].map((t, index) => (
          <button
            key={t}
            className={`nav__tab ${tab === t ? "is-on" : ""}`}
            style={four ? { gridColumn: index < 2 ? index + 1 : index + 2 } : undefined}
            onClick={() => go(t)}
            aria-current={tab === t ? "page" : undefined}
          >
            {tab === t && <motion.span layoutId="nav-pill" className="nav__pill" transition={{ type: "spring", stiffness: 500, damping: 34 }} />}
            <Icon name={TAB_LABEL[t].icon} size={four ? 20 : 22} />
            <span>{TAB_LABEL[t].label}</span>
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
        <Icon name="camera" size={four ? 24 : 28} stroke={2.4} />
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
