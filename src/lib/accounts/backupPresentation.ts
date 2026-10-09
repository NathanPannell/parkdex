import type { AuthPhase, BackupPhase } from "./AuthProvider";

export function backupHeadline(phase: BackupPhase, synced: boolean) {
  if (phase === "syncing") return "Backing up now";
  if (phase === "offline" || phase === "pending") return "Waiting to back up";
  if (phase === "error") return "Backup needs attention";
  return synced ? "Backed up" : "Not backed up yet";
}

export function settingsAccountSubtitle(authPhase: AuthPhase, backupPhase: BackupPhase, synced: boolean) {
  if (authPhase === "starting") return "Opening your account…";
  if (authPhase === "guest") return "Sign in to plant your flag";
  if (authPhase === "offline-account") return "Offline · not being backed up";
  if (authPhase === "error") return "Storage needs attention";
  return backupHeadline(backupPhase, synced);
}
