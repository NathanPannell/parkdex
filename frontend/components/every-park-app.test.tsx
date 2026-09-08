// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ParkdexApp } from "./every-park-app";

const place = { id: "provincial-juan-de-fuca-park", name: "Forest Park", category: "provincial" as const, latitude: 49, longitude: -124, region: "South Island", description: "A forest park.", sourceUrl: "https://example.test", sourceName: "BC Parks" };
const rathtrevor = { id: "provincial-rathtrevor-beach-park", name: "Rathtrevor Beach Park", category: "provincial" as const, latitude: 49.31, longitude: -124.27, region: "Central Island", description: "A beach park.", sourceUrl: "https://example.test/rathtrevor", sourceName: "BC Parks" };
const national = { id: "national-pacific-rim-national-park-reserve", name: "Pacific Rim National Park Reserve", category: "national" as const, latitude: 49.05, longitude: -125.7, region: "West Coast", description: "A national park reserve.", sourceUrl: "https://example.test/pacific-rim", sourceName: "Parks Canada" };
const journal = {
  places: [place, rathtrevor, national], visited: new Set<string>(), visitTimestamps: {}, completedTrails: new Set<string>(), coverageNote: "Coverage",
  account: null as { id: string; email: string; emailVerified?: boolean } | null, authenticated: false, loading: false, loadError: "", syncMessage: "", storageUnavailable: false,
  guestProgressAvailable: false, transitionBusy: false, toggleVisit: vi.fn(), toggleTrail: vi.fn(), retrySync: vi.fn(),
  authenticate: vi.fn(), authenticateWithGoogle: vi.fn(), changePassword: vi.fn(), requestEmailVerification: vi.fn(), confirmEmailVerification: vi.fn(),
  logout: vi.fn(), importGuest: vi.fn(), resetProgress: vi.fn(async () => undefined),
};

vi.mock("@/lib/use-field-journal", () => ({ useFieldJournal: () => journal }));
vi.mock("@/components/park-map", () => ({ ParkMap: ({ onSelect, onBoundaryLoadState }: { onSelect: (id: string) => void; onBoundaryLoadState?: (state: { status: "failed"; placeIds: Set<string> }) => void }) => <><button onClick={() => onSelect("provincial-juan-de-fuca-park")}>Test map marker</button><button onClick={() => onBoundaryLoadState?.({ status: "failed", placeIds: new Set() })}>Fail boundary load</button></> }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.history.replaceState({}, "", "/"); window.sessionStorage.clear(); journal.visited = new Set<string>(); journal.visitTimestamps = {}; journal.authenticated = false; journal.account = null; journal.toggleVisit.mockClear(); journal.resetProgress.mockClear(); journal.logout.mockClear(); journal.authenticateWithGoogle.mockClear(); journal.confirmEmailVerification.mockClear(); });

describe("Parkdex navigation", () => {
  it("keeps map modes, location, and search in one utility toolbar", () => {
    render(<ParkdexApp apiBaseUrl="" />);
    const toolbar = screen.getByRole("toolbar", { name: "Map utilities" });
    expect(toolbar.querySelectorAll("button")).toHaveLength(4);
    expect(toolbar.contains(screen.getByRole("button", { name: "My map" }))).toBe(true);
    expect(toolbar.contains(screen.getByRole("button", { name: "Find places" }))).toBe(true);
    expect(toolbar.contains(screen.getByRole("button", { name: "Show my current location" }))).toBe(true);
    expect(toolbar.contains(screen.getByRole("button", { name: "Search places" }))).toBe(true);
  });

  it("toggles active Places and Badges tabs back to the full map", () => {
    journal.authenticated = true;
    render(<ParkdexApp apiBaseUrl="" />);
    fireEvent.click(screen.getByRole("button", { name: "Places" }));
    expect(screen.getByRole("heading", { name: "Places" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close Places and return to map" }));
    expect(screen.queryByRole("heading", { name: "Places" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Badges" }));
    expect(screen.getByRole("heading", { name: "Your badges" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close Badges and return to map" }));
    expect(screen.queryByRole("heading", { name: "Your badges" })).toBeNull();
  });

  it("clears a place popup when opening another bottom tab", () => {
    journal.authenticated = true;
    render(<ParkdexApp apiBaseUrl="" />);
    fireEvent.click(screen.getByRole("button", { name: "Test map marker" }));
    expect(screen.getByRole("heading", { name: "Forest Park" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Badges" }));
    expect(screen.queryByRole("heading", { name: "Forest Park" })).toBeNull();
  });

  it("closes modal surfaces with Escape", () => {
    journal.authenticated = true;
    Object.defineProperty(navigator, "geolocation", { configurable: true, value: undefined });
    render(<ParkdexApp apiBaseUrl="" />);
    fireEvent.click(screen.getByRole("button", { name: "Find places" }));
    fireEvent.click(screen.getByRole("button", { name: "Show my current location" }));
    expect(screen.getByRole("dialog", { name: "Near you" })).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Near you" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Badges" }));
    fireEvent.click(screen.getByRole("button", { name: /Banana Slug Rainwalk/ }));
    expect(screen.getByRole("dialog", { name: "Banana Slug Rainwalk" })).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Banana Slug Rainwalk" })).toBeNull();
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

  it("dismisses Near you while the browser location request is still pending", () => {
    let failLocation: PositionErrorCallback = () => undefined;
    Object.defineProperty(navigator, "geolocation", { configurable: true, value: { getCurrentPosition: (_success: PositionCallback, failure: PositionErrorCallback) => { failLocation = failure; } } });
    render(<ParkdexApp apiBaseUrl="" />);
    fireEvent.click(screen.getByRole("button", { name: "Show my current location" }));
    expect(screen.getByText("Finding your location…")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close nearby places" }));
    expect(screen.queryByRole("dialog", { name: "Near you" })).toBeNull();
    act(() => failLocation({ code: 3, message: "Timed out", PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 }));
    expect(screen.queryByRole("dialog", { name: "Near you" })).toBeNull();
  });

  it("claims the first-visit badge and keeps Escape from claiming it", async () => {
    render(<ParkdexApp apiBaseUrl="" />);
    fireEvent.click(screen.getByRole("button", { name: "Find places" }));
    fireEvent.click(screen.getByRole("button", { name: "Test map marker" }));
    fireEvent.click(screen.getByRole("button", { name: "Mark as visited" }));
    expect(screen.getByRole("dialog", { name: "River Otter Rookie" })).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
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

  it("uses varied tree, mushroom, and bear confetti without leaves", () => {
    const { container } = render(<ParkdexApp apiBaseUrl="" />);
    fireEvent.click(screen.getByRole("button", { name: "Find places" }));
    fireEvent.click(screen.getByRole("button", { name: "Test map marker" }));
    fireEvent.click(screen.getByRole("button", { name: "Mark as visited" }));
    const pieces = [...container.querySelectorAll<HTMLElement>("[data-confetti-kind]")];
    expect(new Set(pieces.map((piece) => piece.dataset.confettiKind))).toEqual(new Set(["tree", "mushroom", "bear"]));
    expect(new Set(pieces.map((piece) => piece.style.getPropertyValue("--x"))).size).toBe(pieces.length);
  });

  it("keeps signed-out navigation focused on the map and account", () => {
    render(<ParkdexApp apiBaseUrl="" />);
    expect(screen.queryByRole("button", { name: "Places" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Badges" })).toBeNull();
    expect(screen.getByRole("button", { name: "Map" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Account" })).toBeTruthy();
  });

  it("links place categories, collections, and published boundaries from the place card", () => {
    render(<ParkdexApp apiBaseUrl="" />);
    fireEvent.click(screen.getByRole("button", { name: "Test map marker" }));
    expect(screen.getByRole("button", { name: /Provincial/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /BC Parks/ })).toBeTruthy();
  });

  it("keeps the official place source available when boundary geometry fails", () => {
    render(<ParkdexApp apiBaseUrl="" />);
    fireEvent.click(screen.getByRole("button", { name: "Fail boundary load" }));
    fireEvent.click(screen.getByRole("button", { name: "Test map marker" }));
    expect(screen.getByText("Boundary display unavailable.")).toBeTruthy();
    const source = screen.getByRole("link", { name: "Place source" });
    expect(source.getAttribute("href")).toBe(place.sourceUrl);
  });

  it("confirms account progress reset, supports cancel, and clears queued celebrations", async () => {
    journal.authenticated = true;
    journal.account = { id: "account-1", email: "ranger@example.test" };
    render(<ParkdexApp apiBaseUrl="" />);
    fireEvent.click(screen.getByRole("button", { name: "Find places" }));
    fireEvent.click(screen.getByRole("button", { name: "Test map marker" }));
    fireEvent.click(screen.getByRole("button", { name: "Mark as visited" }));
    expect(screen.getByRole("dialog", { name: "River Otter Rookie" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Account" }));
    fireEvent.click(screen.getByRole("button", { name: "Reset my progress" }));
    expect(screen.getByRole("dialog", { name: "Reset all progress?" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Keep my progress" }));
    expect(journal.resetProgress).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Reset my progress" }));
    fireEvent.click(screen.getByRole("button", { name: "Reset everything" }));
    await waitFor(() => expect(journal.resetProgress).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("clears collection restrictions when opening global map search", () => {
    journal.authenticated = true;
    render(<ParkdexApp apiBaseUrl="" />);
    fireEvent.click(screen.getByRole("button", { name: "Places" }));
    fireEvent.click(screen.getByRole("button", { name: "National" }));
    expect(screen.getByRole("button", { name: /Pacific Rim National Park Reserve/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Map" }));
    fireEvent.click(screen.getByRole("button", { name: "Search places" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Search places" }), { target: { value: "Rathtrevor" } });
    expect(screen.getByRole("button", { name: /Rathtrevor Beach Park/ })).toBeTruthy();
  });

  it("preserves active map filters when the tray closes and while opening a Places result", () => {
    journal.authenticated = true;
    render(<ParkdexApp apiBaseUrl="" />);
    fireEvent.click(screen.getByRole("button", { name: "Search places" }));
    fireEvent.click(screen.getByRole("button", { name: "Filter places" }));
    fireEvent.click(screen.getByRole("button", { name: "National" }));
    fireEvent.click(screen.getByRole("button", { name: "Close filters" }));
    expect(screen.getByRole("button", { name: "Filter places, 1 active" }).classList.contains("active")).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Places" }));
    fireEvent.click(screen.getByRole("button", { name: "Provincial" }));
    fireEvent.click(screen.getByRole("button", { name: /Rathtrevor Beach Park/ }));
    const filterButton = screen.getByRole("button", { name: "Filter places, 1 active" });
    expect(filterButton.classList.contains("active")).toBe(true);
    fireEvent.click(filterButton);
    expect(screen.getByRole("button", { name: "National" }).classList.contains("selected")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(screen.getByRole("button", { name: "Filter places" }).classList.contains("active")).toBe(false);
  });

  it("does not apply Places filters to an unfiltered map", () => {
    journal.authenticated = true;
    render(<ParkdexApp apiBaseUrl="" />);
    fireEvent.click(screen.getByRole("button", { name: "Places" }));
    fireEvent.click(screen.getByRole("button", { name: "National" }));
    fireEvent.click(screen.getByRole("button", { name: /Pacific Rim National Park Reserve/ }));
    fireEvent.click(screen.getByRole("button", { name: "Search places" }));
    expect(screen.getByRole("button", { name: "Filter places" }).classList.contains("active")).toBe(false);
  });

  it("consumes a reset token from the fragment before submitting it securely", async () => {
    journal.authenticated = true; journal.account = { id: "account-1", email: "ranger@example.test", emailVerified: true };
    window.history.replaceState({}, "", "/#resetToken=secret-token");
    const fetchMock = vi.fn((url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      void init;
      return String(url).endsWith("/api/auth/config")
        ? Promise.resolve(new Response(JSON.stringify({ googleEnabled: false, emailEnabled: true }), { headers: { "Content-Type": "application/json" } }))
        : Promise.resolve(new Response(null, { status: 204 }));
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<ParkdexApp apiBaseUrl="https://api.example.test" />);
    expect(await screen.findByRole("heading", { name: "Choose a new password" })).toBeTruthy();
    await waitFor(() => expect(window.location.hash).toBe(""));
    fireEvent.change(screen.getByLabelText(/^New password/), { target: { value: "a long secure password" } });
    fireEvent.change(screen.getByLabelText(/^Confirm new password/), { target: { value: "a long secure password" } });
    fireEvent.click(screen.getByRole("button", { name: "Reset password" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("https://api.example.test/api/auth/password-reset/confirm", expect.anything()));
    const resetCall = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/password-reset/confirm"));
    expect(JSON.parse(String(resetCall?.[1]?.body))).toMatchObject({ token: "secret-token" });
    expect(journal.logout).toHaveBeenCalledTimes(1);
  });

  it("shows a retryable Google cancellation and clears callback state", async () => {
    window.sessionStorage.setItem("parkdex:google-code-verifier:v1", "verifier");
    window.history.replaceState({}, "", "/?error=access_denied&state=oauth-state");
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(JSON.stringify({ googleEnabled: true, emailEnabled: false }), { headers: { "Content-Type": "application/json" } }))));
    render(<ParkdexApp apiBaseUrl="https://api.example.test" />);
    expect((await screen.findByRole("alert")).textContent).toBe("Google sign-in was cancelled. You can try again.");
    expect(window.location.search).toBe("");
    expect(window.sessionStorage.getItem("parkdex:google-code-verifier:v1")).toBeNull();
    expect(screen.getByRole("button", { name: "Continue with Google" })).toBeTruthy();
  });

  it("completes Google PKCE sign-in and clears one-use callback values", async () => {
    window.sessionStorage.setItem("parkdex:google-code-verifier:v1", "verifier");
    window.history.replaceState({}, "", "/?code=google-code&state=oauth-state");
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(JSON.stringify({ googleEnabled: true, emailEnabled: false }), { headers: { "Content-Type": "application/json" } }))));
    render(<ParkdexApp apiBaseUrl="https://api.example.test" />);
    await waitFor(() => expect(journal.authenticateWithGoogle).toHaveBeenCalledWith("google-code", "oauth-state", "verifier"));
    expect(window.location.search).toBe("");
    expect(window.sessionStorage.getItem("parkdex:google-code-verifier:v1")).toBeNull();
    expect(await screen.findByText("Signed in with Google.")).toBeTruthy();
  });

  it("confirms an email token from the fragment and removes it immediately", async () => {
    window.history.replaceState({}, "", "/#verificationToken=verify-me");
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(JSON.stringify({ googleEnabled: false, emailEnabled: true }), { headers: { "Content-Type": "application/json" } }))));
    render(<ParkdexApp apiBaseUrl="https://api.example.test" />);
    await waitFor(() => expect(journal.confirmEmailVerification).toHaveBeenCalledWith("verify-me"));
    expect(window.location.hash).toBe("");
    expect(await screen.findByText("Email verified. Your field journal is ready.")).toBeTruthy();
  });

  it("keeps collection search in a bottom dock and exposes mixed category progress", () => {
    journal.authenticated = true; journal.visited = new Set([place.id, national.id]);
    render(<ParkdexApp apiBaseUrl="" />); fireEvent.click(screen.getByRole("button", { name: "Places" }));
    expect(screen.getByRole("progressbar", { name: "2 of 3 places collected" }).getAttribute("aria-valuenow")).toBe("2");
    const progress = screen.getByLabelText("Collection progress");
    expect(progress.querySelector("li.category-provincial")?.textContent).toContain("1/2");
    fireEvent.click(screen.getByRole("button", { name: "Search collection" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Search collection" }), { target: { value: "Pacific" } });
    expect(screen.getByRole("button", { name: /Pacific Rim National Park Reserve/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close collection search" }));
    expect(screen.queryByRole("textbox", { name: "Search collection" })).toBeNull();
  });

  it("groups badges into collected and uncollected sections", () => {
    journal.authenticated = true; journal.visited = new Set([place.id]); journal.visitTimestamps = { [place.id]: "2026-09-07T12:00:00Z" };
    render(<ParkdexApp apiBaseUrl="" />); fireEvent.click(screen.getByRole("button", { name: "Badges" }));
    expect(screen.getByRole("heading", { name: "Collected" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Still out there" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /River Otter Rookie/ }));
    expect(screen.getByRole("dialog", { name: "River Otter Rookie" })).toBeTruthy();
  });

  it("keeps credits on the signed-out account and removes map-header attribution", () => {
    const { container } = render(<ParkdexApp apiBaseUrl="" />);
    expect(container.querySelector("#map-attribution-slot")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Account" }));
    fireEvent.click(screen.getByRole("button", { name: "Credits" }));
    expect(screen.getByRole("dialog", { name: "Credits" })).toBeTruthy();
    expect(screen.getByRole("link", { name: /OpenFreeMap/ }).getAttribute("href")).toBe("https://openfreemap.org/");
    expect(screen.getByRole("link", { name: /OpenMapTiles/ }).getAttribute("href")).toBe("https://openmaptiles.org/");
    expect(screen.getByRole("link", { name: /OpenStreetMap contributors/ }).getAttribute("href")).toBe("https://www.openstreetmap.org/copyright");
  });

  it("renders nearby places with the same category row treatment as Places", () => {
    Object.defineProperty(navigator, "geolocation", { configurable: true, value: { getCurrentPosition: (success: PositionCallback) => success({ coords: { latitude: 49, longitude: -124, accuracy: 5, altitude: null, altitudeAccuracy: null, heading: null, speed: null, toJSON: () => ({}) }, timestamp: Date.now(), toJSON: () => ({}) }) } });
    render(<ParkdexApp apiBaseUrl="" />);
    fireEvent.click(screen.getByRole("button", { name: "Show my current location" }));
    const row = screen.getByRole("button", { name: /Forest Park/ });
    expect(row.classList.contains("place-row")).toBe(true);
    expect(row.classList.contains("category-provincial")).toBe(true);
  });

  it("opens account shelf and modal entries at map and badge destinations", () => {
    journal.authenticated = true; journal.account = { id: "account-1", email: "ranger@example.test" }; journal.visited = new Set([place.id]); journal.visitTimestamps = { [place.id]: "2026-09-07T12:00:00Z" };
    render(<ParkdexApp apiBaseUrl="" />); fireEvent.click(screen.getByRole("button", { name: "Account" }));
    fireEvent.click(screen.getByRole("button", { name: "Open Forest Park" }));
    expect(screen.getByRole("heading", { name: "Forest Park" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Account" }));
    fireEvent.click(screen.getAllByRole("button", { name: "See all" })[0]);
    expect(screen.getByRole("button", { name: "Close All badges" }).classList.contains("collection-modal-close")).toBe(true);
    fireEvent.click(screen.getAllByRole("button", { name: "Open River Otter Rookie" }).find((element) => element.classList.contains("collection-modal-row"))!);
    expect(screen.getByRole("dialog", { name: "River Otter Rookie" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close badge details" }));
    fireEvent.click(screen.getAllByRole("button", { name: "See all" })[1]);
    fireEvent.click(screen.getAllByRole("button", { name: "Open Forest Park" }).find((element) => element.classList.contains("collection-modal-row"))!);
    expect(screen.getByRole("heading", { name: "Forest Park" })).toBeTruthy();
  });
});
