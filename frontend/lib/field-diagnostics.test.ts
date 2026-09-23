import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createFieldDiagnosticsStore } from "./field-diagnostics";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("field diagnostics store", () => {
  it("deduplicates a key, keeps a stage timeline, and announces terminal updates", () => {
    const store = createFieldDiagnosticsStore();
    const first = store.begin({ key: "location:foreground", flow: "location", title: "Finding location", stage: "permission" });
    first.stage("watch-start", { summary: "GPS listener started", facts: [{ kind: "permission", value: "precise" }] });
    first.succeed("first-fix", { summary: "Pin ready", facts: [{ kind: "accuracy-meters", value: 8 }] });
    const second = store.begin({ key: "location:foreground", flow: "location", title: "Finding location", stage: "permission", summary: "Trying again" });

    expect(second.id).toBe(first.id);
    expect(store.getSnapshot().retained).toHaveLength(1);
    expect(store.getSnapshot().retained[0].timeline).toHaveLength(1);
    second.fail("first-fix", { summary: "No GPS fix received" });
    expect(store.getSnapshot().announcement).toBe("Finding location: No GPS fix received");
  });

  it("retains only the latest twenty traces and exposes at most two visible by priority", () => {
    const store = createFieldDiagnosticsStore();
    for (let index = 0; index < 22; index += 1) {
      const trace = store.begin({ key: `photo:${index}`, flow: "photo", title: `Photo ${index}`, stage: "camera" });
      if (index === 20) trace.warn("upload", { summary: "Slow" });
      if (index === 21) trace.fail("upload", { summary: "Failed" });
    }
    expect(store.getSnapshot().retained).toHaveLength(20);
    expect(store.getSnapshot().visible).toHaveLength(2);
    expect(store.getSnapshot().visible.map((entry) => entry.tone)).toEqual(["error", "warning"]);
  });

  it("expires success at six seconds and warnings at twelve seconds", () => {
    const store = createFieldDiagnosticsStore();
    const success = store.begin({ key: "photo:a", flow: "photo", title: "Photo", stage: "camera" });
    success.succeed("upload", { summary: "Uploaded" });
    const warning = store.begin({ key: "location:a", flow: "location", title: "Location", stage: "watch-start" });
    warning.warn("first-fix", { summary: "Still waiting" });
    vi.advanceTimersByTime(6_001);
    expect(store.getSnapshot().retained.find((entry) => entry.id === success.id)?.visible).toBe(false);
    expect(store.getSnapshot().retained.find((entry) => entry.id === warning.id)?.visible).toBe(true);
    vi.advanceTimersByTime(6_000);
    expect(store.getSnapshot().retained.find((entry) => entry.id === warning.id)?.visible).toBe(false);
  });

  it("pauses and resumes expiry without losing the remaining lifetime", () => {
    const store = createFieldDiagnosticsStore();
    const trace = store.begin({ key: "photo:a", flow: "photo", title: "Photo", stage: "camera" });
    trace.succeed("upload", { summary: "Uploaded" });
    vi.advanceTimersByTime(2_000);
    store.pause(trace.id, "focus");
    vi.advanceTimersByTime(20_000);
    expect(store.getSnapshot().visible).toHaveLength(1);
    store.resume(trace.id, "focus");
    vi.advanceTimersByTime(4_001);
    expect(store.getSnapshot().visible).toHaveLength(0);
  });

  it("starts new traces paused while the document-level pause is active", () => {
    const store = createFieldDiagnosticsStore();
    store.pauseAll("document-hidden");
    const trace = store.begin({ key: "location:a", flow: "location", title: "Location", stage: "watch-start" });
    trace.succeed("first-fix", { summary: "Pin ready" });
    vi.advanceTimersByTime(20_000);
    expect(store.getSnapshot().visible).toHaveLength(1);
    store.resumeAll("document-hidden");
    vi.advanceTimersByTime(6_001);
    expect(store.getSnapshot().visible).toHaveLength(0);
  });

  it("redacts unsafe text and copies only typed, allowlisted facts", () => {
    const store = createFieldDiagnosticsStore();
    const trace = store.begin({ key: "photo:a", flow: "photo", title: "Uploading", stage: "upload" });
    trace.fail("upload", {
      summary: "Bearer abc123 failed at https://signed.example/photo?token=secret near 49.12345,-123.12345",
      facts: [{ kind: "file-bytes", value: 1_500_000 }, { kind: "http-status", value: 0 }],
    });
    const copied = store.copyText(trace.id);
    expect(copied).toContain("Photo size: 1.5 MB");
    expect(copied).toContain("HTTP: no response");
    expect(copied).not.toContain("abc123");
    expect(copied).not.toContain("signed.example");
    expect(copied).not.toContain("49.12345");
  });

  it("drops unknown or malformed facts at the runtime boundary", () => {
    const store = createFieldDiagnosticsStore();
    const trace = store.begin({ key: "photo:a", flow: "photo", title: "Uploading", stage: "upload" });
    trace.fail("upload", {
      summary: "Failed",
      facts: [
        { kind: "file-bytes", value: 500 },
        { kind: "token", value: "secret" },
        { kind: "mime-type", value: "text/plain" },
      ] as never,
    });
    const copied = store.copyText(trace.id);
    expect(copied).toContain("Photo size: 500 B");
    expect(copied).not.toContain("secret");
    expect(copied).not.toContain("text/plain");
  });

  it("is a no-op when diagnostics are disabled", () => {
    const store = createFieldDiagnosticsStore(false);
    const trace = store.begin({ key: "location", flow: "location", title: "Location", stage: "permission" });
    trace.fail("first-fix", { summary: "Failed" });
    expect(store.getSnapshot()).toEqual({ retained: [], visible: [], announcement: "" });
  });
});
