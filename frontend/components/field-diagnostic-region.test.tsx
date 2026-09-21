// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createFieldDiagnosticsStore } from "@/lib/field-diagnostics";
import { FieldDiagnosticRegion } from "./field-diagnostic-region";

beforeEach(() => {
  vi.useFakeTimers();
  Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("FieldDiagnosticRegion", () => {
  it("renders one polite live region and compact diagnostic controls", () => {
    const store = createFieldDiagnosticsStore();
    store.begin({ key: "location", flow: "location", title: "Finding location", stage: "permission", summary: "Checking permission" });
    render(<FieldDiagnosticRegion store={store} />);

    expect(screen.getAllByText("Finding location")).toHaveLength(2);
    expect(document.querySelectorAll('[aria-live="polite"]')).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Details" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Dismiss Finding location" })).toBeTruthy();
  });

  it("opens a focus-managed detail dialog, copies safe text, and restores focus", async () => {
    const store = createFieldDiagnosticsStore();
    const trace = store.begin({ key: "photo", flow: "photo", title: "Uploading photo", stage: "upload", facts: [{ kind: "file-bytes", value: 2_000_000 }] });
    trace.fail("upload", { summary: "No server response", facts: [{ kind: "http-status", value: 0 }] });
    render(<FieldDiagnosticRegion store={store} />);
    const details = screen.getByRole("button", { name: "Details" });
    fireEvent.click(details);

    expect(screen.getByRole("dialog", { name: "Uploading photo" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Close diagnostic details" })).toBe(document.activeElement);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Copy details" })); });
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(expect.stringContaining("HTTP: no response"));
    expect(screen.getByText("Copied")).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    act(() => vi.advanceTimersByTime(16));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(details).toBe(document.activeElement);
  });

  it("pauses expiry while focus is inside the toast", () => {
    const store = createFieldDiagnosticsStore();
    const trace = store.begin({ key: "photo", flow: "photo", title: "Photo uploaded", stage: "upload" });
    trace.succeed("upload", { summary: "Postcard ready" });
    render(<FieldDiagnosticRegion store={store} />);
    const details = screen.getByRole("button", { name: "Details" });
    fireEvent.focus(details);
    act(() => vi.advanceTimersByTime(20_000));
    expect(screen.getByText("Postcard ready")).toBeTruthy();
    fireEvent.blur(details, { relatedTarget: document.body });
    act(() => vi.advanceTimersByTime(6_001));
    expect(screen.queryByText("Postcard ready")).toBeNull();
  });

  it("dismisses a toast without deleting its retained details", () => {
    const store = createFieldDiagnosticsStore();
    store.begin({ key: "location", flow: "location", title: "Location found", stage: "first-fix" });
    render(<FieldDiagnosticRegion store={store} />);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss Location found" }));
    expect(screen.queryByText("Location found")).toBeNull();
    expect(store.getSnapshot().retained).toHaveLength(1);
  });
});
