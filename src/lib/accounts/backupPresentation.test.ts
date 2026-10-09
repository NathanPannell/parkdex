import { describe, expect, it } from "vitest";
import { backupHeadline, settingsAccountSubtitle } from "./backupPresentation";

describe("account backup presentation", () => {
  it("uses the backup phase and successful backup marker for the Account headline", () => {
    expect(backupHeadline("syncing", false)).toBe("Backing up now");
    expect(backupHeadline("pending", true)).toBe("Waiting to back up");
    expect(backupHeadline("offline", false)).toBe("Waiting to back up");
    expect(backupHeadline("error", true)).toBe("Backup needs attention");
    expect(backupHeadline("success", true)).toBe("Backed up");
    expect(backupHeadline("idle", false)).toBe("Not backed up yet");
    expect(backupHeadline("success", false)).toBe("Up to date");
  });

  it("shows account startup, sign-in, offline, and error states in Settings", () => {
    expect(settingsAccountSubtitle("starting", "idle", false)).toBe("Opening your Dex…");
    expect(settingsAccountSubtitle("guest", "idle", false)).toBe("Sign in to back up your Dex");
    expect(settingsAccountSubtitle("offline-account", "offline", true)).toBe("Offline · not being backed up");
    expect(settingsAccountSubtitle("error", "error", false)).toBe("Storage needs attention");
  });

  it("uses the Account screen's backup headline when authenticated", () => {
    expect(settingsAccountSubtitle("authenticated", "syncing", false)).toBe("Backing up now");
    expect(settingsAccountSubtitle("authenticated", "pending", false)).toBe("Waiting to back up");
    expect(settingsAccountSubtitle("authenticated", "error", false)).toBe("Backup needs attention");
    expect(settingsAccountSubtitle("authenticated", "success", true)).toBe("Backed up");
    expect(settingsAccountSubtitle("authenticated", "idle", false)).toBe("Not backed up yet");
  });
});
