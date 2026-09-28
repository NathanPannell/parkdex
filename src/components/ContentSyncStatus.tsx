import { Icon } from "./Icon";
import { useContentStatus } from "../lib/content/provider";

type SyncStage = "idle" | "checking" | "waiting-for-wifi" | "downloading" | "applying" | "error";

type StatusWithSyncStage = ReturnType<typeof useContentStatus> & { syncStage?: SyncStage };

export function ContentSyncStatus() {
  const status = useContentStatus();
  const reportedStage = (status as StatusWithSyncStage).syncStage ?? legacyStage(status);
  const syncStage = reportedStage === "idle" && status.waitingForWifi ? "waiting-for-wifi" : reportedStage;

  if (syncStage === "idle") return null;

  const copy = copyFor(syncStage);
  const progress = syncStage === "downloading" && status.totalBytes > 0
    ? Math.min(100, Math.floor((status.downloadedBytes / status.totalBytes) * 100))
    : null;

  return (
    <>
      <div className={`content-sync content-sync--${syncStage}`}>
        <span className="content-sync__icon" aria-hidden="true">
          {syncStage === "waiting-for-wifi" ? (
            <WifiIcon />
          ) : syncStage === "error" ? (
            <WarningIcon />
          ) : (
            <span className={syncStage === "checking" || syncStage === "downloading" || syncStage === "applying" ? "content-sync__wheel content-sync__wheel--active" : "content-sync__wheel"}>
              <Icon name="refresh" size={18} />
            </span>
          )}
        </span>
        <span className="content-sync__label" aria-hidden="true">{copy.visible}</span>
        {progress !== null && (
          <span
            className="content-sync__progress"
            role="progressbar"
            aria-label="Park update download progress"
            aria-live="off"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progress}
          >
            {progress}%
          </span>
        )}
      </div>
      <span className="content-sync__sr-only" role="status" aria-live="polite" aria-atomic="true">{copy.announcement}</span>
    </>
  );
}

function legacyStage(status: ReturnType<typeof useContentStatus>): SyncStage {
  if (status.waitingForWifi) return "waiting-for-wifi";
  if (status.error) return "error";
  if (status.phase === "starting") return "checking";
  if (status.phase === "downloading") return "downloading";
  if (status.phase === "updating") return "applying";
  return "idle";
}

function copyFor(stage: Exclude<SyncStage, "idle">) {
  switch (stage) {
    case "checking":
      return { visible: "Checking for updates", announcement: "Checking for park updates." };
    case "waiting-for-wifi":
      return { visible: "Waiting for Wi-Fi", announcement: "Park updates are waiting for Wi-Fi. Saved parks remain available." };
    case "downloading":
      return { visible: "Downloading park updates", announcement: "Downloading park updates." };
    case "applying":
      return { visible: "Saving park updates", announcement: "Saving park updates." };
    case "error":
      return { visible: "Update failed", announcement: "The park update failed. Your saved parks are still available." };
  }
}

function WifiIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3.5 8.8a13.1 13.1 0 0 1 17 0M7 12.2a7.8 7.8 0 0 1 10 0m-6.5 3.5a2.4 2.4 0 0 1 3 0M12 19h.01" />
    </svg>
  );
}

function WarningIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3 22 20H2L12 3Z" />
      <path d="M12 9v5m0 3h.01" />
    </svg>
  );
}
