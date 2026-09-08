// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ParkdexApp } from "./every-park-app";

const place = { id: "park-one", name: "Forest Park", category: "regional" as const, latitude: 49, longitude: -124, region: "South Island", description: "A forest park.", sourceUrl: "https://example.test", sourceName: "Capital Regional District" };
const journal = {
  places: [place], visited: new Set<string>(), visitTimestamps: {}, completedTrails: new Set<string>(), coverageNote: "Coverage",
  account: null, authenticated: false, loading: false, loadError: "", syncMessage: "", storageUnavailable: false,
  guestProgressAvailable: false, transitionBusy: false, toggleVisit: vi.fn(), toggleTrail: vi.fn(), retrySync: vi.fn(),
  authenticate: vi.fn(), logout: vi.fn(), importGuest: vi.fn(),
};

vi.mock("@/lib/use-field-journal", () => ({ useFieldJournal: () => journal }));
vi.mock("@/components/park-map", () => ({ ParkMap: ({ onSelect }: { onSelect: (id: string) => void }) => <button onClick={() => onSelect("park-one")}>Test map marker</button> }));
afterEach(() => cleanup());

describe("Parkdex navigation", () => {
  it("toggles active Places and Badges tabs back to the full map", () => {
    render(<ParkdexApp apiBaseUrl="" />);
    fireEvent.click(screen.getByRole("button", { name: "Places" }));
    expect(screen.getByRole("heading", { name: "Your places" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close Places and return to map" }));
    expect(screen.queryByRole("heading", { name: "Your places" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Badges" }));
    expect(screen.getByRole("heading", { name: "Your badges" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close Badges and return to map" }));
    expect(screen.queryByRole("heading", { name: "Your badges" })).toBeNull();
  });

  it("clears a place popup when opening another bottom tab", () => {
    render(<ParkdexApp apiBaseUrl="" />);
    fireEvent.click(screen.getByRole("button", { name: "Test map marker" }));
    expect(screen.getByRole("heading", { name: "Forest Park" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Badges" }));
    expect(screen.queryByRole("heading", { name: "Forest Park" })).toBeNull();
  });

  it("closes modal surfaces with Escape", () => {
    Object.defineProperty(navigator, "geolocation", { configurable: true, value: undefined });
    render(<ParkdexApp apiBaseUrl="" />);
    fireEvent.click(screen.getByRole("button", { name: "Find places" }));
    fireEvent.click(screen.getByRole("button", { name: "Show my current location" }));
    expect(screen.getByRole("dialog", { name: "Near you" })).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Near you" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Badges" }));
    fireEvent.click(screen.getByRole("button", { name: /Banana Slug Medal/ }));
    expect(screen.getByRole("dialog", { name: "Banana Slug Medal" })).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Banana Slug Medal" })).toBeNull();
  });
});
