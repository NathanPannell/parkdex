import { Icon } from "./Icon";
import { useContentRuntime, useContentStatus } from "../lib/content/provider";

export function ContentSyncStatus() {
  const status = useContentStatus();
  const runtime = useContentRuntime();
  const updating = ["checking", "downloading", "applying"].includes(status.syncStage);
  const failed = status.syncStage === "error";
  if (!updating && !failed && status.activeDownloads < 1) return null;
  if (failed)
    return (
      <button className="content-sync content-sync--retry" onClick={() => void runtime.retry()} aria-label="Update paused. Try again">
        <Icon name="refresh" size={18} />
        <span>Update paused · Try again</span>
      </button>
    );

  // Downloads run often (streamed map detail included) and work in the background, so
  // nothing is drawn over the map; screen readers still hear that an update is underway.
  return (
    <span className="content-sync__sr-only" role="status" aria-live="polite" aria-atomic="true">
      Downloading update.
    </span>
  );
}
