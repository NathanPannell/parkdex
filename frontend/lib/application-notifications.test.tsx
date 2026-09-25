// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApplicationToast } from "@/components/application-toast";
import { dismissNotification, getSnapshot, notifyError, notifyInfo } from "./application-notifications";

afterEach(() => {
  cleanup();
  while (getSnapshot().active) dismissNotification(getSnapshot().active?.id);
  vi.useRealTimers();
});

describe("application notifications", () => {
  it("uses safe public error copy and presents a keyboard-dismissible alert", async () => {
    render(<ApplicationToast />);
    act(() => notifyError(new Error("Could not save your visit. Try again.")));

    const alert = screen.getByRole("alert");
    expect(alert.textContent).toBe("Could not save your visit. Try again.");
    const dismiss = screen.getByRole("button", { name: "Dismiss notification" });
    dismiss.focus();
    fireEvent.keyDown(dismiss, { key: "Escape" });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("uses the generic fallback for unknown or blank failures and supports explicit copy", () => {
    render(<ApplicationToast />);
    act(() => notifyError({ message: "private response body" }));
    expect(screen.getByRole("alert").textContent).toBe("Something went wrong. Please try again.");
    act(() => dismissNotification(getSnapshot().active?.id));
    act(() => notifyError(new Error("internal detail"), "Could not sync your saved visits."));
    expect(screen.getByRole("alert").textContent).toBe("Could not sync your saved visits.");
    expect(screen.getByRole("alert").textContent).not.toContain("internal detail");
    act(() => dismissNotification(getSnapshot().active?.id));
    act(() => notifyError(new TypeError("Failed to fetch")));
    expect(screen.getByRole("alert").textContent).toBe("Something went wrong. Please try again.");
  });

  it("shows queued messages for five seconds each without an old timer dismissing the next toast", () => {
    vi.useFakeTimers();
    render(<ApplicationToast />);
    act(() => {
      notifyInfo("Saved locally.");
      notifyError(new Error("network detail"), "Could not sync right now.");
    });

    expect(screen.getByRole("status").textContent).toContain("Saved locally.");
    act(() => vi.advanceTimersByTime(4_999));
    expect(screen.getByRole("status").textContent).toContain("Saved locally.");
    act(() => vi.advanceTimersByTime(1));
    expect(screen.getByRole("alert").textContent).toContain("Could not sync right now.");
    act(() => vi.advanceTimersByTime(4_999));
    expect(screen.getByRole("alert")).toBeTruthy();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("keeps the external-store snapshot referentially stable between updates", () => {
    const before = getSnapshot();
    expect(getSnapshot()).toBe(before);
    act(() => notifyInfo("A current message."));
    expect(getSnapshot()).not.toBe(before);
  });
});
