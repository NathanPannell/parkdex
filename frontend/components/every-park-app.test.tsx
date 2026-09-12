// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Place } from "@/lib/places";
import { ParkdexApp } from "./every-park-app";

const place: Place = { id: "provincial-juan-de-fuca-park", name: "Forest Park", category: "provincial", latitude: 49, longitude: -124, region: "South Island", description: "A forest park.", sourceUrl: "https://example.test", sourceName: "BC Parks" };
const rathtrevor: Place = { id: "provincial-rathtrevor-beach-park", name: "Rathtrevor Beach Park", category: "provincial", latitude: 49.31, longitude: -124.27, region: "Central Island", description: "A beach park.", sourceUrl: "https://example.test/rathtrevor", sourceName: "BC Parks" };
const national: Place = { id: "national-pacific-rim-national-park-reserve", name: "Pacific Rim National Park Reserve", category: "national", latitude: 49.05, longitude: -125.7, region: "West Coast", description: "A national park reserve.", sourceUrl: "https://example.test/pacific-rim", sourceName: "Parks Canada" };
const artlish: Place = { ...place, id: "provincial-artlish-caves-park", name: "Artlish Caves Park" };
const goldstream: Place = { ...place, id: "provincial-goldstream-park", name: "Goldstream Park" };
const woss: Place = { ...place, id: "provincial-woss-lake-park", name: "Woss Lake Park", region: "North Island" };
const defaultPlaces = [place, rathtrevor, national];
const journal = {
  places: defaultPlaces.slice(), visited: new Set<string>(), visitTimestamps: {}, completedTrails: new Set<string>(), coverageNote: "Coverage",
  account: null as { id: string; email: string; emailVerified?: boolean; hasPassword?: boolean } | null, authenticated: false, loading: false, loadError: "", syncMessage: "", storageUnavailable: false,
  guestProgressAvailable: false, transitionBusy: false, toggleVisit: vi.fn(), toggleTrail: vi.fn(), retrySync: vi.fn(),
  authenticate: vi.fn(), authenticateWithGoogle: vi.fn(), requestEmailVerification: vi.fn(), confirmEmailVerification: vi.fn(),
  logout: vi.fn(), importGuest: vi.fn(), resetProgress: vi.fn(async () => undefined),
};
const groupState = {
  groups: [] as Array<{ id: string; name: string; isWishlist?: boolean; places: Place[] }>, selectedGroupId: null as string | null,
  loading: false, error: "", busy: false, retry: vi.fn(async () => undefined), selectGroup: vi.fn(), create: vi.fn(async () => null), rename: vi.fn(async () => undefined), remove: vi.fn(async () => undefined), addPlace: vi.fn(async () => undefined), removePlace: vi.fn(async () => undefined),
};

vi.mock("@/lib/use-field-journal", () => ({ useFieldJournal: () => journal }));
vi.mock("@/lib/use-groups", () => ({ useGroups: () => groupState }));
vi.mock("@/components/park-map", () => ({ ParkMap: ({ places, selectedIds = new Set(), showResetControl = true, onSelect, onBoundaryLoadState }: { places: Place[]; selectedIds?: ReadonlySet<string>; showResetControl?: boolean; onSelect: (id: string) => void; onBoundaryLoadState?: (state: { status: "failed"; placeIds: Set<string> }) => void }) => { const [moved, setMoved] = useState(false); return <div data-testid="park-map" data-place-ids={places.map((item) => item.id).join(",")} data-selected-ids={[...selectedIds].join(",")}><button onClick={() => onSelect("provincial-juan-de-fuca-park")}>Test map marker</button><button onClick={() => onBoundaryLoadState?.({ status: "failed", placeIds: new Set() })}>Fail boundary load</button><button onClick={() => setMoved(true)}>Displace map</button>{moved && showResetControl && <button onClick={() => setMoved(false)}>Reset map view</button>}</div>; } }));
beforeEach(() => { HTMLElement.prototype.scrollTo = vi.fn(); });

afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.history.replaceState({}, "", "/"); window.sessionStorage.clear(); journal.places = defaultPlaces.slice(); journal.visited = new Set<string>(); journal.visitTimestamps = {}; journal.authenticated = false; journal.account = null; journal.loading = false; journal.loadError = ""; journal.toggleVisit.mockClear(); journal.resetProgress.mockClear(); journal.logout.mockClear(); journal.authenticateWithGoogle.mockClear(); journal.confirmEmailVerification.mockClear(); groupState.groups = []; groupState.selectedGroupId = null; Object.values(groupState).forEach((value) => { if (typeof value === "function" && "mockClear" in value) value.mockClear(); }); });

describe("Parkdex navigation", () => {
  it.each([false, true])("restores a bookmarked place after catalogue initialization (visited: %s)", async (wasVisited) => {
    window.history.replaceState({ framework: "preserved" }, "", `/?view=map&place=${place.id}`);
    journal.loading = true; journal.places = [];
    const { rerender } = render(<ParkdexApp apiBaseUrl="" />);
    expect(window.location.search).toContain(place.id);
    expect(screen.queryByText(/no longer in the catalogue/)).toBeNull();
    journal.loading = false; journal.places = defaultPlaces;
    journal.visited = new Set(wasVisited ? [place.id] : []);
    rerender(<ParkdexApp apiBaseUrl="" />);
    expect(await screen.findByRole("heading", { name: "Forest Park" })).toBeTruthy();
    expect(screen.getByRole("button", { name: wasVisited ? "Undo visited place" : "Mark as visited" })).toBeTruthy();
    expect(window.history.state.framework).toBe("preserved");
  });

  it("restores public views and independent filters through real Back/Forward entries", async () => {
    journal.authenticated = true;
    window.history.replaceState({}, "", "/?view=collection&mapQuery=beach&placesQuery=Forest");
    render(<ParkdexApp apiBaseUrl="" />);
    fireEvent.click(screen.getByRole("button", { name: /Forest Park/ }));
    expect(window.location.search).toContain(`place=${place.id}`);
    expect(screen.getByTestId("park-map").dataset.placeIds).toContain(place.id);
    fireEvent.click(screen.getByRole("button", { name: "Account" }));
    expect(new URLSearchParams(window.location.search).get("view")).toBe("account");
    act(() => window.history.back());
    expect(await screen.findByRole("heading", { name: "Forest Park" })).toBeTruthy();
    act(() => window.history.back());
    expect(await screen.findByRole("heading", { name: "Places" })).toBeTruthy();
    expect((screen.getByRole("textbox", { name: "Search collection" }) as HTMLInputElement).value).toBe("Forest");
    expect(new URLSearchParams(window.location.search).get("mapQuery")).toBe("beach");
    act(() => window.history.forward());
    expect(await screen.findByRole("heading", { name: "Forest Park" })).toBeTruthy();
  });

  it("does not add duplicate history for the current tab", () => {
    render(<ParkdexApp apiBaseUrl="" />);
    fireEvent.click(screen.getByRole("button", { name: "Account" }));
    const length = window.history.length;
    fireEvent.click(screen.getByRole("button", { name: "Account" }));
    expect(window.history.length).toBe(length);
  });

  it("recovers from an unknown place only after a successful catalogue load", async () => {
    window.history.replaceState({}, "", "/?place=removed-place");
    journal.loading = true; journal.places = [];
    const { rerender } = render(<ParkdexApp apiBaseUrl="" />);
    expect(window.location.search).toContain("removed-place");
    journal.loading = false; journal.loadError = "Offline";
    rerender(<ParkdexApp apiBaseUrl="" />);
    expect(window.location.search).toContain("removed-place");
    journal.loadError = ""; journal.places = defaultPlaces;
    rerender(<ParkdexApp apiBaseUrl="" />);
    expect(await screen.findByText(/This place is no longer in the catalogue/)).toBeTruthy();
    expect(new URLSearchParams(window.location.search).has("place")).toBe(false);
    expect(screen.getByRole("button", { name: "Search places" })).toBeTruthy();
  });

  it("auth-gates a direct Groups tab and resumes after account initialization", () => {
    window.history.replaceState({}, "", "/?view=groups");
    groupState.groups = [{ id: "private-id", name: "Private camping plan", places: [place] }];
    const { rerender } = render(<ParkdexApp apiBaseUrl="" />);
    expect(screen.getByRole("heading", { name: "Keep your field journal" })).toBeTruthy();
    expect(screen.queryByText("Private camping plan")).toBeNull();
    journal.authenticated = true; journal.account = { id: "owner", email: "owner@example.test" };
    rerender(<ParkdexApp apiBaseUrl="" />);
    expect(screen.getByRole("heading", { name: "Groups" })).toBeTruthy();
    expect(window.location.href).not.toMatch(/private-id|Private/);
  });

  it.each(["Enter", "Apply"])("keeps a zero-result applied query and category readable after %s", (method) => {
    render(<ParkdexApp apiBaseUrl="" />);
    fireEvent.click(screen.getByRole("button", { name: "Search places" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Search places" }), { target: { value: "zzzz-no-such-park" } });
    fireEvent.click(screen.getByRole("button", { name: "Filter places" }));
    fireEvent.click(screen.getByRole("button", { name: "Provincial" }));
    if (method === "Enter") fireEvent.keyDown(screen.getByRole("textbox", { name: "Search places" }), { key: "Enter" });
    else fireEvent.click(screen.getByRole("button", { name: "Apply search" }));
    const status = screen.getByRole("status");
    expect(status.textContent).toContain("No places match");
    expect(status.textContent).toContain("zzzz-no-such-park");
    expect(status.textContent).toContain("Provincial");
    fireEvent.click(screen.getByRole("button", { name: "Clear map search and filters" }));
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByTestId("park-map").dataset.placeIds).toContain(place.id);
  });

  it("shows internal browsing and official visitor information as distinct actions", () => {
    journal.places = [goldstream];
    window.history.replaceState({}, "", `/?place=${goldstream.id}`);
    render(<ParkdexApp apiBaseUrl="" />);
    expect(screen.getByRole("link", { name: "Official visitor information" }).getAttribute("href")).toBe("https://bcparks.ca/goldstream-park/");
    expect(screen.getByRole("link", { name: "Place source" }).getAttribute("href")).toBe(goldstream.sourceUrl);
    fireEvent.click(screen.getByRole("button", { name: "Browse Provincial Parks" }));
    expect(screen.getByRole("heading", { name: "Places" })).toBeTruthy();
    expect(new URLSearchParams(window.location.search).get("view")).toBe("collection");
  });

  it.each([false, true])("focuses reset entry and return headings without sending email (authenticated: %s)", async (signedIn) => {
    journal.authenticated = signedIn;
    if (signedIn) journal.account = { id: "account", email: "ranger@example.test", emailVerified: true };
    const fetchMock = vi.fn((url: string) => { expect(url).toContain("/auth/config"); return Promise.resolve(new Response(JSON.stringify({ emailEnabled: true, googleEnabled: false }))); });
    vi.stubGlobal("fetch", fetchMock);
    render(<ParkdexApp apiBaseUrl="" />);
    fireEvent.click(screen.getByRole("button", { name: "Account" }));
    if (!signedIn) fireEvent.click(screen.getByRole("button", { name: "Log in" }));
    const origin = screen.getByRole("button", { name: signedIn ? "Reset password by email" : "Forgot password?" });
    origin.focus(); fireEvent.click(origin);
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Reset your password" }));
    fireEvent.click(screen.getByRole("button", { name: signedIn ? "Back to account" : "Back to log in" }));
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: signedIn ? "Your account" : "Keep your field journal" }));
    await act(async () => {});
    expect(fetchMock.mock.calls.every(([url]) => String(url).endsWith("/auth/config"))).toBe(true);
  });

  it("provides a short focus round trip from the first badge through visible navigation", () => {
    journal.authenticated = true;
    render(<ParkdexApp apiBaseUrl="" />);
    const desktop = screen.getByRole("navigation", { name: "Primary navigation" });
    desktop.style.display = "none";
    fireEvent.click(screen.getByRole("button", { name: "Badges" }));
    const badge = screen.getByRole("button", { name: /Banana Slug Rainwalk/ });
    badge.focus(); fireEvent.click(badge);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(document.activeElement).toBe(badge);
    fireEvent.click(document.querySelector<HTMLButtonElement>(".content-skip")!);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Badges" }));
    fireEvent.click(document.querySelector<HTMLButtonElement>(".thumb-nav .navigation-skip")!);
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Your badges" }));
  });

  it("announces a successful addition once outside the compact action column", async () => {
    journal.authenticated = true;
    const name = "Places to return to with family on long summer weekends and holidays";
    groupState.groups = [{ id: "wishlist", name: "Wishlist", isWishlist: true, places: [] }, { id: "return-group", name, places: [] }];
    render(<ParkdexApp apiBaseUrl="" />);
    fireEvent.click(screen.getByRole("button", { name: "Test map marker" }));
    fireEvent.click(screen.getByRole("button", { name: "Add this place to a group" }));
    fireEvent.click(screen.getByRole("button", { name: new RegExp(name) }));
    const status = await screen.findByRole("status");
    expect(status.textContent).toBe(`Added to ${name}.`);
    expect(status.closest(".sheet-actions")).toBeNull();
    expect(groupState.addPlace).toHaveBeenCalledTimes(1);
    expect(groupState.addPlace).toHaveBeenCalledWith("return-group", place.id);
    expect(screen.getByRole("button", { name: "Mark as visited" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add this place to Wishlist" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add this place to a group" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Close place details" }).closest(".place-sheet-content")).toBeNull();
  });

  it("spells out the actual regional authorities inside their collection summaries", () => {
    journal.authenticated = true;
    journal.places = ["Capital Regional District", "Cowichan Valley Regional District", "Regional District of Nanaimo", "Regional District of Mount Waddington"].map((sourceName, index) => ({ ...place, id: `regional-${index}`, category: "regional", sourceName }));
    window.history.replaceState({}, "", "/?view=collection");
    render(<ParkdexApp apiBaseUrl="" />);
    for (const item of journal.places) expect(screen.getByText(item.sourceName).closest("summary")).toBeTruthy();
    expect(screen.queryByText(/Comox/)).toBeNull();
  });

  it("renders the authenticated desktop primary navigation beside the brand", () => {
    journal.authenticated = true;
    render(<ParkdexApp apiBaseUrl="" />);
    const navigation = screen.getByRole("navigation", { name: "Primary navigation" });
    expect(navigation).toBeTruthy();
    expect(screen.getByRole("button", { name: "Map tab" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Places tab" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Badges tab" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Account tab" })).toBeTruthy();
  });

  it("keeps map modes, location, and search in one utility toolbar", () => {
    render(<ParkdexApp apiBaseUrl="" />);
    const toolbar = screen.getByRole("toolbar", { name: "Map utilities" });
    expect(toolbar.querySelectorAll("button")).toHaveLength(4);
    expect(toolbar.contains(screen.getByRole("button", { name: "My map" }))).toBe(true);
    expect(toolbar.contains(screen.getByRole("button", { name: "Find places" }))).toBe(true);
    expect(toolbar.contains(screen.getByRole("button", { name: "Show my current location" }))).toBe(true);
    expect(toolbar.contains(screen.getByRole("button", { name: "Search places" }))).toBe(true);
  });

  it("resets active feature tabs without leaving them", () => {
    journal.authenticated = true;
    render(<ParkdexApp apiBaseUrl="" />);
    fireEvent.click(screen.getByRole("button", { name: "Places" }));
    expect(screen.getByRole("heading", { name: "Places" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Places" }));
    expect(screen.getByRole("heading", { name: "Places" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Badges" }));
    expect(screen.getByRole("heading", { name: "Your badges" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Badges" }));
    expect(screen.getByRole("heading", { name: "Your badges" })).toBeTruthy();
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
    expect(screen.getByRole("dialog", { name: "Near Me" })).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Near Me" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Badges" }));
    fireEvent.click(screen.getByRole("button", { name: /Banana Slug Rainwalk/ }));
    expect(screen.getByRole("dialog", { name: "Banana Slug Rainwalk" })).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Banana Slug Rainwalk" })).toBeNull();
  });

  it("dismisses Near Me after a delayed location timeout", () => {
    let failLocation: PositionErrorCallback = () => undefined;
    Object.defineProperty(navigator, "geolocation", { configurable: true, value: { getCurrentPosition: (_success: PositionCallback, failure: PositionErrorCallback) => { failLocation = failure; } } });
    render(<ParkdexApp apiBaseUrl="" />);
    fireEvent.click(screen.getByRole("button", { name: "Find places" }));
    fireEvent.click(screen.getByRole("button", { name: "Show my current location" }));
    expect(screen.getByRole("dialog", { name: "Near Me" })).toBeTruthy();
    act(() => failLocation({ code: 3, message: "Timed out", PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 }));
    expect(screen.getByText("Your location is unavailable right now. Search the map instead.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close nearby places" }));
    expect(screen.queryByRole("dialog", { name: "Near Me" })).toBeNull();
  });

  it("dismisses Near Me while the browser location request is still pending", () => {
    let failLocation: PositionErrorCallback = () => undefined;
    Object.defineProperty(navigator, "geolocation", { configurable: true, value: { getCurrentPosition: (_success: PositionCallback, failure: PositionErrorCallback) => { failLocation = failure; } } });
    render(<ParkdexApp apiBaseUrl="" />);
    fireEvent.click(screen.getByRole("button", { name: "Show my current location" }));
    expect(screen.getByText("Finding your location…")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close nearby places" }));
    expect(screen.queryByRole("dialog", { name: "Near Me" })).toBeNull();
    act(() => failLocation({ code: 3, message: "Timed out", PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 }));
    expect(screen.queryByRole("dialog", { name: "Near Me" })).toBeNull();
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
    expect(screen.getByRole("button", { name: "Browse Provincial places" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Browse Provincial Parks" })).toBeTruthy();
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
    expect(screen.queryByRole("toolbar", { name: "Map utilities" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Close place details" }));
    const toolbar = screen.getByRole("toolbar", { name: "Map utilities" });
    expect(toolbar.classList.contains("search-open")).toBe(false);
    expect(screen.getByLabelText("Map filter active")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Search places" }));
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
    fireEvent.click(screen.getByRole("button", { name: "Close place details" }));
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

  it("offers an email-only reset request from login and shows a generic inbox state", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ googleEnabled: false, emailEnabled: true }), { headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ detail: "If an account exists, password reset instructions have been sent." }), { status: 202, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    render(<ParkdexApp apiBaseUrl="https://api.example.test" />);
    fireEvent.click(screen.getByRole("button", { name: "Account" }));
    fireEvent.click(screen.getByRole("button", { name: "Log in" }));
    fireEvent.click(screen.getByRole("button", { name: "Forgot password?" }));
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "ranger@example.test" } });
    await waitFor(() => expect(screen.getByRole("button", { name: "Send reset link" }).hasAttribute("disabled")).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Send reset link" }));
    expect(await screen.findByRole("heading", { name: "Check your inbox" })).toBeTruthy();
    expect(screen.getByText(/If that email is connected to a Parkdex account/)).toBeTruthy();
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toEqual({ email: "ranger@example.test" });
  });

  it("turns an invalid reset token into a recoverable request state", async () => {
    window.history.replaceState({}, "", "/#resetToken=expired-token");
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ googleEnabled: false, emailEnabled: true }), { headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ detail: "Invalid or expired password reset token" }), { status: 400, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    render(<ParkdexApp apiBaseUrl="https://api.example.test" />);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Choose a new password" })).toBeTruthy());
    fireEvent.change(screen.getByLabelText(/^New password/), { target: { value: "a long secure password" } });
    fireEvent.change(screen.getByLabelText("Confirm new password"), { target: { value: "a long secure password" } });
    fireEvent.click(screen.getByRole("button", { name: "Reset password" }));
    expect(await screen.findByRole("heading", { name: "That reset link is no longer valid" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Request a new link" }));
    expect(screen.getByRole("heading", { name: "Reset your password" })).toBeTruthy();
    expect(window.location.hash).toBe("");
  });

  it("restores a signed-in account when a reset-link journey is abandoned", async () => {
    journal.authenticated = true; journal.account = { id: "account-1", email: "ranger@example.test", emailVerified: true };
    window.history.replaceState({}, "", "/#resetToken=abandoned-token");
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(JSON.stringify({ googleEnabled: false, emailEnabled: true }), { headers: { "Content-Type": "application/json" } }))));
    render(<ParkdexApp apiBaseUrl="https://api.example.test" />);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Choose a new password" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Back to log in" }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "Your account" })).toBeTruthy());
    expect(screen.getByRole("button", { name: "Reset password by email" })).toBeTruthy();
  });

  it("replaces direct account password changes with the email reset journey", async () => {
    journal.authenticated = true; journal.account = { id: "account-1", email: "ranger@example.test", emailVerified: true };
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(JSON.stringify({ googleEnabled: false, emailEnabled: true }), { headers: { "Content-Type": "application/json" } }))));
    render(<ParkdexApp apiBaseUrl="https://api.example.test" />);
    fireEvent.click(screen.getByRole("button", { name: "Account" }));
    expect(screen.queryByRole("button", { name: "Change password" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Reset password by email" }));
    expect(screen.getByRole("heading", { name: "Reset your password" })).toBeTruthy();
    expect(screen.getByLabelText(/^Email/).getAttribute("readonly")).not.toBeNull();
  });

  it("shows a retryable Google cancellation and clears callback state", async () => {
    window.sessionStorage.setItem("parkdex:google-code-verifier:v1", "verifier");
    window.history.replaceState({}, "", "/?error=access_denied&state=oauth-state");
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(JSON.stringify({ googleEnabled: true, emailEnabled: false }), { headers: { "Content-Type": "application/json" } }))));
    render(<ParkdexApp apiBaseUrl="https://api.example.test" />);
    expect((await screen.findByRole("alert")).textContent).toBe("Google sign-in was cancelled. You can try again.");
    expect(window.location.search).toBe("?view=account");
    expect(window.sessionStorage.getItem("parkdex:google-code-verifier:v1")).toBeNull();
    expect(screen.getByRole("button", { name: "Continue with Google" })).toBeTruthy();
  });

  it("completes Google PKCE sign-in and clears one-use callback values", async () => {
    window.sessionStorage.setItem("parkdex:google-code-verifier:v1", "verifier");
    window.history.replaceState({}, "", "/?code=google-code&state=oauth-state");
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(JSON.stringify({ googleEnabled: true, emailEnabled: false }), { headers: { "Content-Type": "application/json" } }))));
    render(<ParkdexApp apiBaseUrl="https://api.example.test" />);
    await waitFor(() => expect(journal.authenticateWithGoogle).toHaveBeenCalledWith("google-code", "oauth-state", "verifier"));
    expect(window.location.search).toBe("?view=account");
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
    fireEvent.click(screen.getByRole("button", { name: "Search collection" }));
    expect((screen.getByRole("textbox", { name: "Search collection" }) as HTMLInputElement).value).toBe("Pacific");
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

  it("applies an exhaustive map search while retaining the collapsed query", () => {
    render(<ParkdexApp apiBaseUrl="" />);
    fireEvent.click(screen.getByRole("button", { name: "Search places" }));
    const input = screen.getByRole("textbox", { name: "Search places" });
    fireEvent.change(input, { target: { value: "Park" } });
    expect(screen.getByText("3 places found")).toBeTruthy();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.queryByRole("textbox", { name: "Search places" })).toBeNull();
    expect(screen.getByTestId("park-map").getAttribute("data-place-ids")?.split(",")).toHaveLength(3);
    expect(screen.getByLabelText("Map filter active")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Search places" }));
    expect((screen.getByRole("textbox", { name: "Search places" }) as HTMLInputElement).value).toBe("Park");
  });

  it("keeps the moved-map reset control off non-map panels and restores its behavior on Map", () => {
    journal.authenticated = true;
    render(<ParkdexApp apiBaseUrl="" />);
    fireEvent.click(screen.getByRole("button", { name: "Displace map" }));
    expect(screen.getByRole("button", { name: "Reset map view" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Groups tab" }));
    expect(screen.queryByRole("button", { name: "Reset map view" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Account tab" }));
    expect(screen.queryByRole("button", { name: "Reset map view" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Map tab" }));
    fireEvent.click(screen.getByRole("button", { name: "Reset map view" }));
    expect(screen.queryByRole("button", { name: "Reset map view" })).toBeNull();
  });

  it("keeps location in the mode row and closes filters when search regains focus", () => {
    render(<ParkdexApp apiBaseUrl="" />);
    const location = screen.getByRole("button", { name: "Show my current location" });
    expect(location.closest(".map-mode-switch")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Search places" }));
    fireEvent.click(screen.getByRole("button", { name: "Filter places" }));
    expect(document.querySelector(".filter-tray")).toBeTruthy();
    fireEvent.click(screen.getByRole("textbox", { name: "Search places" }));
    expect(document.querySelector(".filter-tray")).toBeNull();
  });

  it("collapses search after a result detail closes while retaining the applied query", () => {
    render(<ParkdexApp apiBaseUrl="" />);
    fireEvent.click(screen.getByRole("button", { name: "Search places" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Search places" }), { target: { value: "Rathtrevor" } });
    fireEvent.click(screen.getByRole("button", { name: /Rathtrevor Beach Park/ }));
    fireEvent.click(screen.getByRole("button", { name: "Close place details" }));
    expect(screen.getByRole("toolbar", { name: "Map utilities" }).classList.contains("search-open")).toBe(false);
    expect(screen.getByLabelText("Map filter active")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Search places" }));
    expect((screen.getByRole("textbox", { name: "Search places" }) as HTMLInputElement).value).toBe("Rathtrevor");
  });

  it("hides map utilities behind a detail card with three named actions", () => {
    journal.authenticated = true;
    groupState.groups = [{ id: "wishlist", name: "Wishlist", isWishlist: true, places: [] }];
    render(<ParkdexApp apiBaseUrl="" />);
    fireEvent.click(screen.getByRole("button", { name: "Test map marker" }));
    expect(screen.queryByRole("toolbar", { name: "Map utilities" })).toBeNull();
    expect(screen.getByRole("button", { name: "Mark as visited" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add this place to Wishlist" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add this place to a group" })).toBeTruthy();
  });

  it("creates a name-only group and uses a styled delete confirmation", async () => {
    journal.authenticated = true;
    render(<ParkdexApp apiBaseUrl="" />);
    fireEvent.click(screen.getByRole("button", { name: "Groups" }));
    fireEvent.click(screen.getByRole("button", { name: "New group" }));
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
    fireEvent.change(screen.getByRole("textbox", { name: "Group name" }), { target: { value: "Coast days" } });
    fireEvent.click(screen.getByRole("button", { name: "Save group" }));
    await waitFor(() => expect(groupState.create).toHaveBeenCalledWith("Coast days", []));

    cleanup();
    groupState.groups = [{ id: "coast", name: "Coast days", places: [place] }];
    groupState.selectedGroupId = "coast";
    render(<ParkdexApp apiBaseUrl="" />);
    fireEvent.click(screen.getByRole("button", { name: "Groups" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete Coast days" }));
    expect(screen.getByRole("dialog", { name: "Delete Coast days?" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(groupState.remove).not.toHaveBeenCalled();
  });

  it("supports pencil-driven group rename, place search, and title-to-detail", async () => {
    journal.authenticated = true;
    groupState.groups = [{ id: "coast", name: "Coast days", places: [place] }];
    groupState.selectedGroupId = "coast";
    render(<ParkdexApp apiBaseUrl="" />);
    fireEvent.click(screen.getByRole("button", { name: "Groups" }));
    fireEvent.click(screen.getByRole("button", { name: "Rename Coast days" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Group name" }), { target: { value: "Shore days" } });
    fireEvent.click(screen.getByRole("button", { name: "Save group name" }));
    await waitFor(() => expect(groupState.rename).toHaveBeenCalledWith("coast", "Shore days"));
    fireEvent.change(screen.getByPlaceholderText("Search places to add"), { target: { value: "Rathtrevor" } });
    fireEvent.click(screen.getByRole("button", { name: /Rathtrevor Beach Park/ }));
    await waitFor(() => expect(groupState.addPlace).toHaveBeenCalledWith("coast", rathtrevor.id));
    expect(screen.queryByRole("button", { name: "Pick from map" })).toBeNull();
  });

  it("uses one-photo and four-photo covers for ordinary groups", () => {
    journal.authenticated = true;
    groupState.groups = [
      { id: "solo", name: "Solo", places: [place, woss] },
      { id: "album", name: "Album", places: [place, rathtrevor, national, artlish, goldstream] },
    ];
    render(<ParkdexApp apiBaseUrl="" />);
    fireEvent.click(screen.getByRole("button", { name: "Groups" }));
    expect(screen.getByRole("button", { name: /Solo/ }).querySelectorAll(".group-cover img")).toHaveLength(1);
    const collage = screen.getByRole("button", { name: /Album/ }).querySelector(".group-cover");
    expect(collage?.classList.contains("group-cover-collage")).toBe(true);
    expect(collage?.querySelectorAll("img")).toHaveLength(4);
  });

  it("omits missing group media and clears the group when opening a photographed member", () => {
    journal.authenticated = true;
    journal.places = [place, woss];
    groupState.groups = [{ id: "coast", name: "Coast days", places: [place, woss] }];
    groupState.selectedGroupId = "coast";
    render(<ParkdexApp apiBaseUrl="" />);
    fireEvent.click(screen.getByRole("button", { name: "Groups" }));
    const noPhotoCard = screen.getByText("Woss Lake Park").closest(".group-member-card");
    expect(noPhotoCard?.classList.contains("without-photo")).toBe(true);
    expect(noPhotoCard?.querySelector("img")).toBeNull();
    const photoButton = screen.getByRole("button", { name: "Open Forest Park" });
    expect(photoButton.querySelector("a")).toBeNull();
    groupState.selectGroup.mockClear();
    fireEvent.click(photoButton);
    expect(groupState.selectGroup).toHaveBeenCalledWith(null);
    expect(screen.getByRole("heading", { name: "Forest Park" })).toBeTruthy();
  });

  it("clears the group when opening a member from its title", () => {
    journal.authenticated = true;
    groupState.groups = [{ id: "coast", name: "Coast days", places: [place] }];
    groupState.selectedGroupId = "coast";
    render(<ParkdexApp apiBaseUrl="" />);
    fireEvent.click(screen.getByRole("button", { name: "Groups" }));
    groupState.selectGroup.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Forest Park" }));
    expect(groupState.selectGroup).toHaveBeenCalledWith(null);
    expect(screen.getByRole("heading", { name: "Forest Park" })).toBeTruthy();
  });

  it("moves no-photo place metadata into the media column without duplication", () => {
    journal.authenticated = true;
    journal.places = [woss];
    groupState.groups = [{ id: "north", name: "North", places: [woss] }];
    groupState.selectedGroupId = "north";
    render(<ParkdexApp apiBaseUrl="" />);
    fireEvent.click(screen.getByRole("button", { name: "Groups" }));
    fireEvent.click(screen.getByRole("button", { name: "Woss Lake Park" }));
    const sheet = screen.getByRole("heading", { name: "Woss Lake Park" }).closest(".place-sheet");
    expect(sheet?.classList.contains("without-photo")).toBe(true);
    expect(sheet?.querySelector(".place-sheet-media > img, .place-sheet-media figure")).toBeNull();
    expect(sheet?.querySelector(".place-sheet-metadata")?.textContent).toContain("North Island");
    expect(screen.getAllByRole("button", { name: "Browse Provincial Parks" })).toHaveLength(1);
  });

  it("preserves a group only for View on map and clears it on ordinary navigation", () => {
    journal.authenticated = true;
    groupState.groups = [{ id: "coast", name: "Coast days", places: [place] }];
    groupState.selectedGroupId = "coast";
    render(<ParkdexApp apiBaseUrl="" />);
    fireEvent.click(screen.getByRole("button", { name: "Groups" }));
    groupState.selectGroup.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "View on map" }));
    expect(screen.getByTestId("park-map").getAttribute("data-selected-ids")).toBe(place.id);
    expect(groupState.selectGroup).not.toHaveBeenCalledWith(null);
    fireEvent.click(screen.getByRole("button", { name: "Back to group" }));
    fireEvent.click(screen.getByRole("button", { name: "Account" }));
    expect(groupState.selectGroup).toHaveBeenCalledWith(null);
  });

  it("starts renamed collections closed and keeps search results in their collection", () => {
    journal.authenticated = true;
    render(<ParkdexApp apiBaseUrl="" />);
    fireEvent.click(screen.getByRole("button", { name: "Places" }));
    expect(screen.queryByText("Browse by collection")).toBeNull();
    const nationalCollection = screen.getByText("National Parks").closest("details");
    expect(nationalCollection?.hasAttribute("open")).toBe(false);
    expect(screen.getByText("Provincial Parks")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Search collection" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Search collection" }), { target: { value: "Pacific" } });
    expect(screen.getByText("National Parks").closest("details")?.hasAttribute("open")).toBe(true);
    expect(screen.getByRole("button", { name: /Pacific Rim National Park Reserve/ })).toBeTruthy();
  });

  it("shows account place photography and filters visited parks from Nearby", () => {
    journal.authenticated = true; journal.account = { id: "account-1", email: "ranger@example.test" }; journal.visited = new Set([place.id]); journal.visitTimestamps = { [place.id]: "2026-09-07T12:00:00Z" };
    const location = { latitude: 49, longitude: -124, accuracy: 5, altitude: null, altitudeAccuracy: null, heading: null, speed: null, toJSON: () => ({}) };
    Object.defineProperty(navigator, "geolocation", { configurable: true, value: { getCurrentPosition: (success: PositionCallback) => success({ coords: location, timestamp: Date.now(), toJSON: () => ({}) }) } });
    render(<ParkdexApp apiBaseUrl="" />);
    fireEvent.click(screen.getByRole("button", { name: "Account" }));
    expect(screen.getByRole("button", { name: "Open Forest Park" }).querySelector("img")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Map" }));
    fireEvent.click(screen.getByRole("button", { name: "Show my current location" }));
    expect(screen.getByRole("heading", { name: "Near Me" })).toBeTruthy();
    expect(screen.getByText("Closest places you have not visited yet")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Forest Park/ })).toBeNull();
  });

  it("puts See all in each account shelf header and uses the place placeholder", () => {
    journal.authenticated = true; journal.account = { id: "account-1", email: "ranger@example.test" }; journal.places = [woss]; journal.visited = new Set([woss.id]);
    render(<ParkdexApp apiBaseUrl="" />);
    fireEvent.click(screen.getByRole("button", { name: "Account" }));
    screen.getAllByRole("button", { name: "See all" }).forEach((button) => expect(button.closest("header")).toBeTruthy());
    const image = screen.getByRole("button", { name: "Open Woss Lake Park" }).querySelector("img");
    expect(image?.getAttribute("src")).toContain("place-placeholder.png");
  });

});
