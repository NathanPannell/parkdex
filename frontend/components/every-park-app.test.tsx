// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ParkdexApp } from "./every-park-app";

const place = { id: "provincial-juan-de-fuca-park", name: "Forest Park", category: "provincial" as const, latitude: 49, longitude: -124, region: "South Island", description: "A forest park.", sourceUrl: "https://example.test", sourceName: "BC Parks" };
const journal = {
  places: [place], visited: new Set<string>(), visitTimestamps: {}, completedTrails: new Set<string>(), coverageNote: "Coverage",
  account: null, authenticated: false, loading: false, loadError: "", syncMessage: "", storageUnavailable: false,
  guestProgressAvailable: false, transitionBusy: false, toggleVisit: vi.fn(), toggleTrail: vi.fn(), retrySync: vi.fn(),
  authenticate: vi.fn(), logout: vi.fn(), importGuest: vi.fn(),
};

vi.mock("@/lib/use-field-journal", () => ({ useFieldJournal: () => journal }));
vi.mock("@/components/park-map", () => ({ ParkMap: ({ onSelect }: { onSelect: (id: string) => void }) => <button onClick={() => onSelect("provincial-juan-de-fuca-park")}>Test map marker</button> }));
afterEach(() => { cleanup(); journal.visited = new Set<string>(); journal.visitTimestamps = {}; journal.toggleVisit.mockClear(); });

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

  it("dismisses Near you after a delayed location timeout", () => {
    let failLocation: PositionErrorCallback = () => undefined;
    Object.defineProperty(navigator, "geolocation", { configurable: true, value: { getCurrentPosition: (_success: PositionCallback, failure: PositionErrorCallback) => { failLocation = failure; } } });
    render(<ParkdexApp apiBaseUrl="" />);
    fireEvent.click(screen.getByRole("button", { name: "Find places" }));
    fireEvent.click(screen.getByRole("button", { name: "Show my current location" }));
    expect(screen.getByRole("dialog", { name: "Near you" })).toBeTruthy();
    act(() => failLocation({ code: 3, message: "Timed out", PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 }));
    expect(screen.getByText("Your location is unavailable right now. Search the map instead.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close nearby places" }));
    expect(screen.queryByRole("dialog", { name: "Near you" })).toBeNull();
  });

  it("claims each badge from a multi-award visit in order and focuses the next claim", async () => {
    render(<ParkdexApp apiBaseUrl="" />);
    fireEvent.click(screen.getByRole("button", { name: "Find places" }));
    fireEvent.click(screen.getByRole("button", { name: "Test map marker" }));
    fireEvent.click(screen.getByRole("button", { name: "Mark as visited" }));
    expect(screen.getByRole("dialog", { name: "Banana Slug Medal" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Claim my badge" }));
    expect(screen.getByRole("dialog", { name: "River Otter Rookie" })).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Claim my badge" })));
    fireEvent.click(screen.getByRole("button", { name: "Claim my badge" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("does not celebrate awards loaded from history", () => {
    journal.visited = new Set([place.id]);
    journal.visitTimestamps = { [place.id]: "2026-09-07T12:00:00Z" };
    render(<ParkdexApp apiBaseUrl="" />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
