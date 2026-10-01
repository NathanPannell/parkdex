import { useState, useSyncExternalStore } from "react";
import { currentUpdateStatus, PLAY_STORE_URL, subscribeUpdateStatus } from "../lib/appConfig";
import { Kip } from "./Kip";
import "../update-gate.css";

/** Blocks builds below the minimum and nudges builds below the latest to update from Google Play. */
export function UpdateGate() {
  const status = useSyncExternalStore(subscribeUpdateStatus, currentUpdateStatus, currentUpdateStatus);
  const [dismissed, setDismissed] = useState(false);

  if (status === "required") {
    return (
      <div className="update-gate" role="alertdialog" aria-modal="true" aria-labelledby="update-gate-title">
        <div className="update-gate__card">
          <Kip pose="wave" size={96} />
          <h2 id="update-gate-title">Time to update Parkdex</h2>
          <p>This version is too old to keep exploring. Update from Google Play to carry on. Your badges and photos stay on your phone.</p>
          <a className="btn btn--block update-gate__button" href={PLAY_STORE_URL} target="_blank" rel="noreferrer">Update on Google Play</a>
        </div>
      </div>
    );
  }

  if (status === "available" && !dismissed) {
    return (
      <div className="update-nudge" role="status">
        <span>A new version of Parkdex is ready.</span>
        <a className="update-nudge__action" href={PLAY_STORE_URL} target="_blank" rel="noreferrer">Update</a>
        <button className="update-nudge__close" type="button" aria-label="Dismiss update reminder" onClick={() => setDismissed(true)}>×</button>
      </div>
    );
  }

  return null;
}
