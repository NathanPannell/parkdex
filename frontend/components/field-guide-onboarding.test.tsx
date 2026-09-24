// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Place } from "@/lib/places";
import { dispatchNativeBack } from "@/lib/native-back";
import { FieldGuideOnboarding, fieldGuideOnboardingStepCount } from "./field-guide-onboarding";
import { resetParkSealBoundaryCache } from "./park-seal";

const place: Place = {
  id: "provincial-goldstream-park",
  name: "Goldstream Provincial Park",
  category: "provincial",
  latitude: 48.52,
  longitude: -123.55,
  region: "South Island",
  description: "A forested park.",
  sourceUrl: "https://example.test/goldstream",
  sourceName: "Example Parks",
};

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404 }));
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  resetParkSealBoundaryCache();
});

it("introduces the real Field Guide, Collections, and My Dex journey", () => {
  const onComplete = vi.fn();
  render(<FieldGuideOnboarding place={place} onComplete={onComplete} />);

  expect(screen.getByRole("dialog")).toBeTruthy();
  expect(screen.getByRole("heading", { name: "Find your next park." })).toBeTruthy();
  expect(screen.getByText(/map or list/i)).toBeTruthy();
  expect(screen.getByText(/Search BC parks and islands/i)).toBeTruthy();
  expect(document.querySelector(".field-guide-onboarding__map-seal")).toBeTruthy();
  expect(document.querySelector(".field-guide-onboarding__map-lines")).toBeNull();
  expect(document.querySelector(".field-guide-onboarding__map-pin")).toBeNull();
  expect(document.querySelector(".field-guide-onboarding__place-preview strong")?.textContent).toBe(place.name);
  expect(document.querySelector(".field-guide-onboarding__place-preview .place-image__photo")).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  expect(screen.getByRole("heading", { name: "Keep good possibilities close." })).toBeTruthy();
  expect(screen.getByText("Collections", { selector: "span" })).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  expect(screen.getByRole("heading", { name: "Bring a visit home as a postcard." })).toBeTruthy();
  expect(screen.getByText(/sealed cream postcard in My Dex/i)).toBeTruthy();
  expect(document.querySelector(".impression-print[data-sealed='true']")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Start exploring" })).toBeTruthy();
  expect(fieldGuideOnboardingStepCount).toBe(3);

  fireEvent.click(screen.getByRole("button", { name: "Start exploring" }));
  expect(onComplete).toHaveBeenCalledWith("finished");
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("skips, restores focus, and does not invent account or device-backup promises", async () => {
  const onComplete = vi.fn();
  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.textContent = "Open welcome";
  document.body.append(trigger);
  trigger.focus();
  render(<FieldGuideOnboarding onComplete={onComplete} />);

  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Continue" })));
  expect(screen.getByText("British Columbia")).toBeTruthy();
  expect(screen.queryByText(/no account needed|on this device|backup|sync/i)).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "Skip" }));
  expect(onComplete).toHaveBeenCalledWith("skipped");
  expect(document.activeElement).toBe(trigger);
  trigger.remove();
});

it("traps Tab and treats Escape as a skippable close", async () => {
  const onComplete = vi.fn();
  render(<FieldGuideOnboarding onComplete={onComplete} />);
  const dialog = screen.getByRole("dialog");
  const focusable = [...dialog.querySelectorAll<HTMLButtonElement>("button")];
  expect(focusable.length).toBeGreaterThan(1);

  await act(async () => { focusable[focusable.length - 1].focus(); });
  fireEvent.keyDown(document, { key: "Tab" });
  expect(document.activeElement).toBe(focusable[0]);

  fireEvent.keyDown(document, { key: "Escape" });
  expect(onComplete).toHaveBeenCalledWith("skipped");
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("consumes the native Back action while the intro is visible", async () => {
  const onComplete = vi.fn();
  render(<FieldGuideOnboarding onComplete={onComplete} />);

  expect(dispatchNativeBack()).toBe(false);
  expect(onComplete).toHaveBeenCalledWith("skipped");
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});
