import type { ContentStatus } from "../lib/content/contracts";

export type ContentGateView = {
  showError: boolean;
  title: string;
  message: string;
  showRetry: boolean;
};

/** What the content loading card says for a content status. */
export function contentGateView(status: Pick<ContentStatus, "phase" | "error" | "syncStage" | "downloadedBytes" | "totalBytes">): ContentGateView {
  const showError = Boolean(status.error) && status.phase !== "offline";
  const progress =
    status.syncStage === "downloading" && status.totalBytes > 0 ? `${Math.min(100, Math.floor((status.downloadedBytes / status.totalBytes) * 100))}%` : "";
  const message = showError
    ? "Your saved visits are safe. We’ll retry while you’re online."
    : status.phase === "offline"
      ? "Connect to the internet to download the park guides."
      : progress
        ? `Downloading park guides · ${progress}`
        : "Preparing the park guides.";
  return {
    showError,
    title: showError ? "Park guides couldn’t be loaded." : "Getting Parkdex ready…",
    message,
    showRetry: showError || status.phase === "offline",
  };
}
