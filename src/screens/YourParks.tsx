import { motion } from "motion/react";
import { useEffect, useState } from "react";
import { Flag, FlagPin } from "../components/Flag";
import { Icon } from "../components/Icon";
import { Bubble, Kip } from "../components/Kip";
import { RollingNumber } from "../components/Motion";
import { useAuth } from "../lib/accounts/AuthProvider";
import { useContent } from "../lib/content/provider";
import { sfx } from "../lib/feedback";
import { useGame } from "../lib/game/GameProvider";
import { sortHeldParks } from "../lib/game/visit";
import { bouncy, listItem, listParent, press, tabPage } from "../lib/motion";
import { useStore } from "../lib/store";
import "../game.css";
import "../game-ui.css";

function plural(count: number, one: string, many: string) {
  return `${count} ${count === 1 ? one : many}`;
}

/** The score counts up from zero when the page opens, so it lands with a little drama. */
function useCountUp(value: number) {
  const [shown, setShown] = useState(0);
  useEffect(() => {
    const timer = window.setTimeout(() => setShown(value), 180);
    return () => window.clearTimeout(timer);
  }, [value]);
  return shown;
}

/** The player's score and the parks their flag flies over, longest-held first. */
export function YourParks() {
  const { dispatch } = useStore();
  const auth = useAuth();
  const game = useGame();
  const content = useContent();
  const signedIn = auth.phase === "authenticated" || auth.phase === "offline-account";
  const player = game.me?.player ?? null;
  const parks = sortHeldParks(game.me?.parks ?? []);
  const score = useCountUp(game.me?.score ?? 0);

  // Scores change while the app sits in the background, so read them fresh on open.
  useEffect(() => {
    void game.refresh();
  }, [game.refresh]);

  const openOnMap = (parkId: string) => {
    sfx.pop();
    dispatch({ type: "focus", id: parkId });
    dispatch({ type: "go", screen: "map" });
  };

  return (
    <motion.main className="screen account-screen account-screen--tabbed game-screen scroll" {...tabPage} aria-labelledby="your-parks-title">
      <header className="account-head">
        <div className="account-head__title">
          <span className="eyebrow">Parkdex</span>
          <h1 id="your-parks-title">Your parks</h1>
        </div>
      </header>

      <div className="account-body">
        {!signedIn ? (
          <section className="account-card card game-empty">
            <motion.div animate={{ rotate: [0, -6, 6, 0] }} transition={{ duration: 2.4, repeat: Infinity }}>
              <Kip pose="cheer" size={72} />
            </motion.div>
            <h2>Plant your flag in parks</h2>
            <p className="account-help">Go to a park and your flag goes up. You earn a point for every day it flies.</p>
            <motion.button whileTap={press} className="btn btn--sun btn--block" onClick={() => dispatch({ type: "go", screen: "account" })}>Sign in to plant your flag</motion.button>
          </section>
        ) : game.status === "loading" && !game.me ? (
          <section className="account-card card account-loading" aria-live="polite">
            <Kip size={64} pose="think" />
            <div><strong>Loading your parks…</strong></div>
          </section>
        ) : !game.me ? (
          <section className="account-card card game-empty" role="alert">
            <Kip size={64} pose="think" />
            <h2>Your parks need a connection</h2>
            <p className="account-help">{game.status === "offline" ? "Connect to the internet to see your flags and score." : game.error ?? "Parkdex is unavailable right now."}</p>
            <motion.button whileTap={press} className="btn btn--paper btn--block" onClick={() => void game.refresh()}><Icon name="refresh" /> Try again</motion.button>
          </section>
        ) : !player ? (
          <section className="account-card card game-empty">
            <Flag seed={game.me.flagSeed} size={110} className="is-waving" />
            <h2>Pick a handle to fly this flag</h2>
            <p className="account-help">Everyone sees your flag and @handle on the parks you hold.</p>
            <motion.button whileTap={press} className="btn btn--sun btn--block" onClick={() => game.openHandleSheet()}>Pick your handle</motion.button>
          </section>
        ) : (
          <>
            <motion.section className="account-card card game-score" initial={{ scale: 0.92, rotate: -2, opacity: 0 }} animate={{ scale: 1, rotate: 0, opacity: 1 }} transition={bouncy}>
              <span className="game-score__rays" aria-hidden="true" />
              <FlagPin seed={player.flagSeed} size={64} showAge={false} className="is-waving-pin" label={`Flag of @${player.handle}`} />
              <div className="game-score__text">
                <strong>@{player.handle}</strong>
                <span>{plural(parks.length, "park", "parks")} held</span>
              </div>
              <div className="game-score__points">
                <strong><RollingNumber value={score} /></strong>
                <span>{game.me.score === 1 ? "point" : "points"}</span>
              </div>
            </motion.section>
            {game.status === "offline" && <p className="account-help game-stale" role="status">Offline. Showing what Parkdex said a moment ago.</p>}

            {parks.length === 0 ? (
              <section className="account-card card game-empty">
                <Bubble side="down" style={{ position: "relative" }}>No flags up yet. Go plant one!</Bubble>
                <motion.div animate={{ y: [0, -6, 0] }} transition={{ duration: 1.6, repeat: Infinity, ease: "easeInOut" }}>
                  <Kip pose="idle" size={84} />
                </motion.div>
                <motion.button whileTap={press} className="btn btn--sun btn--sm" onClick={() => dispatch({ type: "go", screen: "map" })}>
                  <Icon name="map" size={18} /> Find a park near me
                </motion.button>
              </section>
            ) : (
              <motion.ul className="game-list" aria-label="Parks you hold" variants={listParent} initial="hidden" animate="show">
                {parks.map((held, index) => {
                  const park = content?.parkById.get(held.parkId);
                  return (
                    <motion.li key={held.parkId} variants={listItem}>
                      <motion.button whileTap={press} className={`game-row card ${index === 0 && held.days > 0 ? "is-top" : ""}`} onClick={() => openOnMap(held.parkId)}>
                        <FlagPin seed={player.flagSeed} days={held.days} size={44} showAge={false} />
                        <span className="game-row__name">
                          <strong>{park?.name ?? held.parkId}</strong>
                          <span>{index === 0 && held.days > 0 ? "Your longest-flying flag" : park?.region ?? "Park"}</span>
                        </span>
                        <span className="game-row__days">
                          <strong>{held.days}</strong>
                          <span>{held.days === 1 ? "day" : "days"}</span>
                        </span>
                      </motion.button>
                    </motion.li>
                  );
                })}
              </motion.ul>
            )}
          </>
        )}

        <button className="account-text-button game-old-badges" onClick={() => dispatch({ type: "go", screen: "collection" })}>
          See your badge collection
        </button>
      </div>
    </motion.main>
  );
}
