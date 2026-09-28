import { Kip } from "./Kip";
import { useContentRuntime, useContentStatus } from "../lib/content/provider";

export function ContentGate() {
  const status = useContentStatus();
  const runtime = useContentRuntime();
  const showError = Boolean(status.error) && !status.waitingForWifi && status.phase !== "offline";
  const progress = status.syncStage === "downloading" && status.totalBytes > 0
    ? `${Math.min(100, Math.floor((status.downloadedBytes / status.totalBytes) * 100))}%`
    : "";
  const message = status.waitingForWifi || showError
    ? null
    : status.phase === "offline"
      ? "Connect to the internet to download your first park guides and map."
      : progress
        ? `Downloading park guides · ${progress}`
        : "Preparing your park guides and map.";

  return (
    <div className="screen map-screen map-loading map-loading--content" role="status" aria-live="polite">
      <div className="map-loading__card card">
        <Kip pose={showError ? "think" : "walk"} size={72} />
        <strong>{showError ? "Park guides couldn’t be loaded." : "Getting Parkdex ready…"}</strong>
        {message && <span>{message}</span>}
        {(showError || (!status.waitingForWifi && status.phase === "offline")) && <button className="btn btn--sm btn--paper" onClick={() => void runtime.retry()}>Try again</button>}
      </div>
    </div>
  );
}
