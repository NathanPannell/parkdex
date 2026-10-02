import { motion } from "motion/react";
import { useEffect, useState } from "react";
import { Icon } from "../components/Icon";
import { useStore } from "../lib/store";
import { formatMegabytes, readSavedSquares } from "../lib/mapCells";
import { useContentRuntime } from "../lib/content/provider";
import { summarizeLocalStorage } from "../lib/localStorageSummary";

/** App settings, separate from the account page. */
export function Settings({ tabbed = false }: { tabbed?: boolean }) {
  const { state, dispatch } = useStore();
  const runtime = useContentRuntime();
  const [savedSquares] = useState(() => readSavedSquares().length);
  const [usedBytes, setUsedBytes] = useState<number | null>(null);

  useEffect(() => {
    let live = true;
    void summarizeLocalStorage(runtime).then((summary) => { if (live) setUsedBytes(summary.totalBytes); }).catch(() => {});
    return () => { live = false; };
  }, [runtime]);

  const downloadsLine = [
    savedSquares ? `${savedSquares} map ${savedSquares === 1 ? "square" : "squares"} saved` : null,
    usedBytes !== null ? `${formatMegabytes(usedBytes)} on this phone` : null,
  ].filter(Boolean).join(" · ") || "Maps and park content on this phone";

  return (
    <motion.main
      className={tabbed ? "screen account-screen account-screen--tabbed scroll" : "screen account-screen scroll"}
      // Tabs swap in place; pages reached from elsewhere slide in.
      initial={tabbed ? { opacity: 0 } : { x: "100%" }}
      animate={tabbed ? { opacity: 1 } : { x: 0 }}
      exit={tabbed ? { opacity: 0 } : { x: "100%" }}
      transition={{ type: "spring", stiffness: 300, damping: 34 }}
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
        <section className="account-card card account-section" aria-label="Settings">
          <button className="account-setting account-setting--button" onClick={() => dispatch({ type: "go", screen: "account" })}>
            <span className="account-setting__icon" aria-hidden="true"><Icon name="link" size={20} /></span>
            <span className="account-setting__text">
              <strong>Account &amp; backup</strong>
              <span>Sign in to back up your Dex</span>
            </span>
            <Icon name="next" size={18} />
          </button>
          <label className="account-setting account-setting--row">
            <span className="account-setting__icon" aria-hidden="true"><Icon name={state.muted ? "mute" : "sound"} size={20} /></span>
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
          </label>
          <button className="account-setting account-setting--button" onClick={() => dispatch({ type: "go", screen: "downloads" })}>
            <span className="account-setting__icon" aria-hidden="true"><Icon name="download" size={20} /></span>
            <span className="account-setting__text">
              <strong>Manage downloads</strong>
              <span>{downloadsLine}</span>
            </span>
            <Icon name="next" size={18} />
          </button>
        </section>

        <p className="account-policy-link"><a href="https://parkdex.app/privacy/" target="_blank" rel="noopener noreferrer">Parkdex Privacy Policy</a></p>
      </div>
    </motion.main>
  );
}
