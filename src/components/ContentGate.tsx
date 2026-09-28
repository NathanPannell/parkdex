import { Kip } from "./Kip";
import { useContentRuntime, useContentStatus } from "../lib/content/provider";

export function ContentGate() {
  const status = useContentStatus();
  const runtime = useContentRuntime();
  const progress = status.totalBytes > 0
    ? `${Math.min(100, Math.floor((status.downloadedBytes / status.totalBytes) * 100))}%`
    : "";

  return (
    <div className="screen map-screen map-loading map-loading--content" role="status" aria-live="polite">
      <div className="map-loading__card card">
        <Kip pose={status.error ? "think" : "walk"} size={72} />
        <strong>{status.error ? "Park guides couldn’t be loaded." : "Getting Parkdex ready…"}</strong>
        <span>{status.waitingForWifi ? "The first park guides are waiting for Wi-Fi." : status.phase === "offline" ? "Connect to download your first park guides." : progress ? `Downloading park guides · ${progress}` : "Preparing your park guides and map."}</span>
        {(status.error || status.phase === "offline") && <button className="btn btn--sm btn--paper" onClick={() => void runtime.retry()}>Try again</button>}
      </div>
    </div>
  );
}
