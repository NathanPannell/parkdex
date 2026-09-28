import { Icon } from "./Icon";
import { useContentStatus } from "../lib/content/provider";

export function ContentSyncStatus() {
  const status = useContentStatus();
  if (status.activeDownloads < 1) return null;

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
