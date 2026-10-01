import { Icon } from "./Icon";
import { useContentRuntime, useContentStatus } from "../lib/content/provider";

export function ContentSyncStatus() {
  const status = useContentStatus();
  const runtime = useContentRuntime();
  const updating = ["checking", "downloading", "applying"].includes(status.syncStage);
  const failed = status.syncStage === "error";
  if (!updating && !failed && status.activeDownloads < 1) return null;
  if (failed) return (
    <button className="content-sync content-sync--retry" onClick={() => void runtime.retry()} aria-label="Update paused. Try again">
      <Icon name="refresh" size={18} />
      <span>Update paused · Try again</span>
    </button>
  );

  return (
    <>
      <div className="content-sync content-sync--downloading">
        <span className="content-sync__icon" aria-hidden="true">
          <span className="content-sync__wheel content-sync__wheel--active">
            <Icon name="refresh" size={18} />
          </span>
        </span>
        <span className="content-sync__label" aria-hidden="true">Downloading update</span>
      </div>
      <span className="content-sync__sr-only" role="status" aria-live="polite" aria-atomic="true">Downloading update.</span>
    </>
  );
}
