import { Kip } from "./Kip";
import { useContentRuntime, useContentStatus } from "../lib/content/provider";

export function ContentGate({ overMap = false }: { overMap?: boolean }) {
  const status = useContentStatus();
  const runtime = useContentRuntime();
  const showError = Boolean(status.error) && status.phase !== "offline";
  const progress = status.syncStage === "downloading" && status.totalBytes > 0
    ? `${Math.min(100, Math.floor((status.downloadedBytes / status.totalBytes) * 100))}%`
    : "";
  const message = showError
    ? "Your saved visits are safe. We’ll retry while you’re online."
    : status.phase === "offline"
      ? "Connect to the internet to download the park guides."
      : progress
        ? `Downloading park guides · ${progress}`
        : "Preparing the park guides.";

  return (
    <div className={`screen map-screen map-loading map-loading--content${overMap ? " map-loading--over-map" : ""}`} role="status" aria-live="polite">
      <div className="map-loading__card card">
        <Kip pose={showError ? "think" : "walk"} size={72} />
        <strong>{showError ? "Park guides couldn’t be loaded." : "Getting Parkdex ready…"}</strong>
        {message && <span>{message}</span>}
        {(showError || status.phase === "offline") && <button className="btn btn--sm btn--paper" onClick={() => void runtime.retry()}>Try again</button>}
      </div>
    </div>
  );
}
