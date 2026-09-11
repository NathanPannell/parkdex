export function cleanupDisposition(pullRequest) {
  if (!Number.isInteger(pullRequest) || pullRequest < 1 || pullRequest > 999999) {
    throw new Error("Cleanup requires a valid pull request number");
  }
  return {
    outcome: "pending-journal-cleanup",
    providerCalls: false,
    message: `No provider cleanup was attempted for merged PR #${pullRequest}. The release journal is external to GitHub; the authorized coordinator must locate that PR's exact journal, verify its recorded provider ownership, run scripts/local-release.ps1 -Mode Cleanup -StatePath <exact-journal> -Apply, and verify every recorded resource absent.`,
  };
}
