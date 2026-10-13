import { AnimatePresence, motion } from "motion/react";
import { parkContaining, useBoundaries } from "../lib/boundaries";
import { buzz, sfx } from "../lib/feedback";
import { useStore, type Screen } from "../lib/store";
import { useContent } from "../lib/content/provider";
import { isUsableGpsAccuracy } from "../lib/geo";
import { useVisit } from "../lib/game/useVisit";
import { Icon, type IconName } from "./Icon";

type Tab = "map" | "parks" | "leaderboard" | "settings";
const TABS: Record<Tab, { icon: IconName; label: string }> = {
  map: { icon: "map", label: "Explore" },
  parks: { icon: "book", label: "My Dex" },
  leaderboard: { icon: "trophy", label: "Leaders" },
  settings: { icon: "gear", label: "Settings" },
};
const LEFT: Tab[] = ["map", "parks"];
const RIGHT: Tab[] = ["leaderboard", "settings"];

function tabFor(screen: Screen): Tab {
  if (screen === "parks") return "parks";
  if (screen === "leaderboard" || screen === "settings") return screen;
  return "map";
}

export function BottomNav() {
  const { state, dispatch } = useStore();
  const content = useContent();
  const bounds = useBoundaries();
  const visit = useVisit();
  const accuracy = state.locationError !== "denied" && isUsableGpsAccuracy(state.accuracy) ? state.accuracy : 0;
  // Every park in the catalogue can carry a flag, with or without badge art.
  const here = parkContaining(state.user, content?.parks ?? [], bounds?.byId, accuracy);
  const visited = !!here && visit.visitedToday(here.id);
  const live = !!here && !visited;
  const tab = tabFor(state.screen);
  const over = tab !== "map";

  const go = (screen: Tab) => {
    if (screen === state.screen) return;
    sfx.tap();
    buzz(8);
    dispatch({ type: "go", screen });
  };

  const fab = () => {
    sfx.pop();
    buzz(12);
    if (live && here) {
      visit.start(here.id);
      return;
    }
    dispatch({ type: "go", screen: "map" });
    // Outside a park, or after today's visit, the button nudges instead of failing: it shows why.
    const hint = document.querySelector(".fab__hint");
    hint?.setAttribute("data-reason", visited ? "visited-today" : "outside-flag");
    hint?.classList.remove("is-on");
    void (hint as HTMLElement | null)?.offsetWidth;
    hint?.classList.add("is-on");
  };

  return (
    <motion.nav className={`nav nav--four ${over ? "nav--over" : ""}`} initial={{ y: 120 }} animate={{ y: 0 }} exit={{ y: 120 }} transition={{ type: "spring", stiffness: 300, damping: 28 }}>
      <div className="nav__bar">
        {[...LEFT, ...RIGHT].map((t, index) => (
          <button
            key={t}
            className={`nav__tab ${tab === t ? "is-on" : ""}`}
            style={{ gridColumn: index < 2 ? index + 1 : index + 2 }}
            onClick={() => go(t)}
            aria-current={tab === t ? "page" : undefined}
          >
            {tab === t && <motion.span layoutId="nav-pill" className="nav__pill" transition={{ type: "spring", stiffness: 500, damping: 34 }} />}
            <Icon name={TABS[t].icon} size={20} />
            <span>{TABS[t].label}</span>
          </button>
        ))}
      </div>
      <motion.button
        className={`fab ${live ? "fab--live" : ""} ${visited ? "fab--visited" : ""}`}
        onClick={fab}
        whileTap={{ scale: 0.88 }}
        aria-label={here ? `${visit.labelFor(here.id)} at ${here.short}` : "Plant your flag, get inside a park first"}
      >
        {live && (
          <>
            <span className="fab__ring" />
            <span className="fab__ring fab__ring--2" />
          </>
        )}
        <Icon name="flag" size={26} stroke={2.4} />
        <AnimatePresence>
          {here && (
            <motion.span className="fab__label" initial={{ scale: 0, y: 6 }} animate={{ scale: 1, y: 0 }} exit={{ scale: 0 }} transition={{ type: "spring", stiffness: 600, damping: 18 }}>
              {visit.shortLabelFor(here.id)}
            </motion.span>
          )}
        </AnimatePresence>
      </motion.button>
      <span className="fab__hint" />
    </motion.nav>
  );
}
