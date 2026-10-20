import { motion } from "motion/react";
import { useEffect, useState } from "react";
import { Flag } from "../components/Flag";
import { Icon } from "../components/Icon";
import { useGame } from "../lib/game/GameProvider";
import { handleFit } from "../lib/game/handleFit";
import { formatPoints } from "../lib/game/visit";
import { listItem, listParent, press, tabPage } from "../lib/motion";
import "../game-ui.css";
import { WebAppSettings } from "./WebAppSettings";
import { openDexOn } from "../lib/dex/prefs";
import { useStore } from "../lib/store";
import { formatMegabytes, readSavedSquares } from "../lib/mapCells";
import { useContentRuntime } from "../lib/content/provider";
import { OFFLINE_DOWNLOADS } from "../lib/content/contracts";
import { summarizeLocalStorage } from "../lib/localStorageSummary";
import { useAuth } from "../lib/accounts/AuthProvider";
import { settingsAccountSubtitle } from "../lib/accounts/backupPresentation";

/** App settings, separate from the account page. */
export function Settings({ tabbed = false }: { tabbed?: boolean }) {
  const { state, dispatch } = useStore();
  const auth = useAuth();
  const game = useGame();
  const player = game.me?.player ?? null;
  const runtime = useContentRuntime();
  // Saved squares return with offline downloads (#199).
  const [savedSquares] = useState(() => (OFFLINE_DOWNLOADS ? readSavedSquares().length : 0));
  const [usedBytes, setUsedBytes] = useState<number | null>(null);

  useEffect(() => {
    let live = true;
    void summarizeLocalStorage(runtime)
      .then((summary) => {
        if (live) setUsedBytes(summary.totalBytes);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [runtime]);

  const downloadsLine =
    [
      savedSquares ? `${savedSquares} map ${savedSquares === 1 ? "square" : "squares"} saved` : null,
      usedBytes !== null ? `${formatMegabytes(usedBytes)} on this phone` : null,
    ]
      .filter(Boolean)
      .join(" · ") || "Maps and park content on this phone";
  const accountLine = settingsAccountSubtitle(auth.phase, auth.backup.phase, !!(auth.backup.lastSyncedAt ?? auth.backup.updatedAt));

  return (
    <motion.main
      className={tabbed ? "screen account-screen account-screen--tabbed scroll" : "screen account-screen scroll"}
      // Tabs swap in place; pages reached from elsewhere slide in.
      {...(tabbed ? tabPage : { initial: { x: "100%" }, animate: { x: 0 }, exit: { x: "100%" }, transition: { type: "spring", stiffness: 300, damping: 34 } })}
      aria-labelledby="settings-title"
    >
      <header className="account-head">
        {!tabbed && (
          <button className="btn btn--paper btn--icon account-back" onClick={() => dispatch({ type: "go", screen: "map" })} aria-label="Back">
            <Icon name="back" size={20} />
          </button>
        )}
        <div className="account-head__title">
          <span className="eyebrow">Parkdex</span>
          <h1 id="settings-title">Settings</h1>
        </div>
      </header>

      <div className="account-body">
        <motion.button
          whileTap={press}
          className="account-card card settings-flag"
          style={handleFit(player?.handle)}
          initial={{ y: 16, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ type: "spring", stiffness: 420, damping: 28 }}
          onClick={() => {
            if (!player) return auth.phase === "authenticated" ? game.openHandleSheet() : dispatch({ type: "go", screen: "account" });
            openDexOn("flags");
            dispatch({ type: "go", screen: "parks" });
          }}
        >
          <Flag seed={player?.flagSeed ?? game.me?.flagSeed ?? null} size={64} patches={game.me?.flagPatches} className="is-waving" />
          <span className="settings-flag__text">
            <strong>{player ? `@${player.handle}` : "Your flag"}</strong>
            <span>
              {player
                ? `${formatPoints(game.me?.score ?? 0)} · see your flags`
                : auth.phase === "authenticated"
                  ? "Pick a handle to fly it"
                  : "Sign in to get your own flag"}
            </span>
          </span>
          <Icon name="next" size={18} />
        </motion.button>

        <motion.section className="account-card card account-section" aria-label="Settings" variants={listParent} initial="hidden" animate="show">
          <motion.button
            variants={listItem}
            whileTap={press}
            className="account-setting account-setting--button"
            onClick={() => dispatch({ type: "go", screen: "account" })}
          >
            <span className="account-setting__icon" aria-hidden="true">
              <Icon name="link" size={20} />
            </span>
            <span className="account-setting__text">
              <strong>Account &amp; backup</strong>
              <span>{accountLine}</span>
            </span>
            <Icon name="next" size={18} />
          </motion.button>
          <motion.label variants={listItem} className="account-setting account-setting--row">
            <span className="account-setting__icon" aria-hidden="true">
              <Icon name={state.muted ? "mute" : "sound"} size={20} />
            </span>
            <span className="account-setting__text">
              <strong>Sound effects</strong>
              <span>{state.muted ? "Off" : "On"}</span>
            </span>
            <input
              type="checkbox"
              role="switch"
              className="account-switch"
              checked={!state.muted}
              onChange={() => dispatch({ type: "mute" })}
              aria-label="Sound effects"
            />
          </motion.label>
          <motion.button
            variants={listItem}
            whileTap={press}
            className="account-setting account-setting--button"
            onClick={() => dispatch({ type: "go", screen: "downloads" })}
          >
            <span className="account-setting__icon" aria-hidden="true">
              <Icon name="download" size={20} />
            </span>
            <span className="account-setting__text">
              <strong>Manage downloads</strong>
              <span>{downloadsLine}</span>
            </span>
            <Icon name="next" size={18} />
          </motion.button>
        </motion.section>

        <WebAppSettings />

        <p className="account-policy-link">
          <a href="https://parkdex.app/privacy/" target="_blank" rel="noopener noreferrer">
            Parkdex Privacy Policy
          </a>
        </p>
      </div>
    </motion.main>
  );
}
