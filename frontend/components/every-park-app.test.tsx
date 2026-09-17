// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Place } from "@/lib/places";
import { publishNativeAppState, registerNativeCapabilities, type LocationSample } from "@/lib/native-capabilities";
import { dispatchNativeBack } from "@/lib/native-back";
import { createBrowserPhotoRetryStore } from "@/lib/photo-retry";
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
  offline: false, syncStatus: "idle" as "idle" | "syncing" | "offline" | "error", syncMessage: "", pendingMemberships: 0,
  loading: false, error: "", busy: false, retry: vi.fn(async () => undefined), refreshAfterReset: vi.fn(async () => undefined), selectGroup: vi.fn(), create: vi.fn(async () => null), rename: vi.fn(async () => undefined), remove: vi.fn(async () => undefined), addPlace: vi.fn(async () => undefined), removePlace: vi.fn(async () => undefined),
};
let restoreNative: () => void = () => undefined;

vi.mock("@/lib/use-field-journal", () => ({ useFieldJournal: () => journal }));
vi.mock("@/lib/use-groups", () => ({ useGroups: () => groupState }));
vi.mock("@/components/park-map", () => ({ ParkMap: ({ places, selectedIds = new Set(), showResetControl = true, currentLocation, onSelect, onBoundaryLoadState }: { places: Place[]; selectedIds?: ReadonlySet<string>; showResetControl?: boolean; currentLocation?: LocationSample | null; onSelect: (id: string) => void; onBoundaryLoadState?: (state: { status: "failed"; placeIds: Set<string> }) => void }) => { const [moved, setMoved] = useState(false); return <div data-testid="park-map" data-place-ids={places.map((item) => item.id).join(",")} data-selected-ids={[...selectedIds].join(",")} data-current-location={currentLocation ? `${currentLocation.latitude},${currentLocation.longitude}` : ""}><button onClick={() => onSelect("provincial-juan-de-fuca-park")}>Test map marker</button><button onClick={() => onBoundaryLoadState?.({ status: "failed", placeIds: new Set() })}>Fail boundary load</button><button onClick={() => setMoved(true)}>Displace map</button>{moved && showResetControl && <button onClick={() => setMoved(false)}>Reset map view</button>}</div>; } }));
beforeEach(() => { HTMLElement.prototype.scrollTo = vi.fn(); });

afterEach(() => { cleanup(); restoreNative(); restoreNative = () => undefined; publishNativeAppState(true); vi.unstubAllGlobals(); window.history.replaceState({}, "", "/"); window.sessionStorage.clear(); journal.places = defaultPlaces.slice(); journal.visited = new Set<string>(); journal.visitTimestamps = {}; journal.authenticated = false; journal.account = null; journal.loading = false; journal.loadError = ""; journal.toggleVisit.mockClear(); journal.resetProgress.mockClear(); journal.logout.mockClear(); journal.authenticateWithGoogle.mockClear(); journal.confirmEmailVerification.mockClear(); for (const key of ["visitMetadata", "visitClaimMode", "recommendClaim", "createClaim", "reconcileClaim", "uploadVisitPhoto", "loadVisitPhoto", "removeVisitPhoto"]) delete (journal as Record<string, unknown>)[key]; groupState.groups = []; groupState.selectedGroupId = null; groupState.offline = false; groupState.syncStatus = "idle"; groupState.syncMessage = ""; groupState.pendingMemberships = 0; groupState.loading = false; groupState.error = ""; groupState.busy = false; Object.values(groupState).forEach((value) => { if (typeof value === "function" && "mockClear" in value) value.mockClear(); }); });

describe("Parkdex navigation", () => {
  it("clears an expired Google callback without a verifier and leaves navigation usable", async () => {
    window.history.replaceState({ framework: "preserved" }, "", "/?code=expired&state=expired");
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(JSON.stringify({ googleEnabled: true, emailEnabled: false })))));
    render(<ParkdexApp apiBaseUrl="" />);
    expect((await screen.findByRole("alert")).textContent).toBe("Google sign-in expired. Please try again.");
    expect(window.location.search).toBe("?view=account");
    expect(window.history.state.framework).toBe("preserved");
    expect(journal.authenticateWithGoogle).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Map" }));
    expect(screen.getByRole("button", { name: "Find places" })).toBeTruthy();
    expect(new URLSearchParams(window.location.search).get("view")).toBe("map");
  });

  it("keeps the previous owner cleanup retry visible across logout", async () => {
    const store = createBrowserPhotoRetryStore();
    const clearOwner = vi.fn().mockRejectedValueOnce(new Error("storage busy")).mockResolvedValueOnce(undefined);
    store.clearOwner = clearOwner;
    restoreNative = registerNativeCapabilities({ getCurrentLocation: vi.fn(), getPhoto: vi.fn(), photoRetry: store });
    journal.authenticated = true;
    journal.account = { id: "owner", email: "owner@example.test" };
    const { rerender } = render(<ParkdexApp apiBaseUrl="" />);

    journal.authenticated = false;
    journal.account = null;
    rerender(<ParkdexApp apiBaseUrl="" />);
    expect(await screen.findByRole("button", { name: "Retry private photo cleanup" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry private photo cleanup" }));
    await waitFor(() => expect(clearOwner).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Retry private photo cleanup" })).toBeNull());
    expect(clearOwner.mock.calls[0]).toEqual(["account:owner"]);
    expect(clearOwner.mock.calls[1]).toEqual(["account:owner"]);
  });

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
    if (wasVisited) expect(screen.getByRole("button", { name: "Undo visited place" })).toBeTruthy();
    else expect(screen.queryByRole("button", { name: "Mark as visited" })).toBeNull();
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

  it("shows existing group membership and only adds to an empty-circle group", async () => {
    journal.authenticated = true;
    groupState.groups = [
      { id: "wishlist", name: "Wishlist", isWishlist: true, places: [place] },
      { id: "coast", name: "Coast days", places: [place] },
      { id: "later", name: "Later trips", places: [] },
    ];
    render(<ParkdexApp apiBaseUrl="" />);
    fireEvent.click(screen.getByRole("button", { name: "Test map marker" }));
    fireEvent.click(screen.getByRole("button", { name: "Add this place to a group" }));

    const picker = screen.getByRole("dialog", { name: place.name });
    const member = screen.getByText("Coast days").closest(".group-picker-option")!;
    const available = screen.getByRole("button", { name: `Add ${place.name} to Later trips` });
    expect(picker.textContent).not.toContain("Wishlist");
    expect(member.tagName).toBe("DIV");
    expect(screen.queryByRole("button", { name: /already in Coast days/ })).toBeNull();
    expect(member.textContent).toContain("Already added");
    expect(member.querySelector("svg")?.getAttribute("fill")).toBe("currentColor");
    expect(available.querySelector("svg")?.getAttribute("fill")).toBe("none");

    fireEvent.click(available);
    await waitFor(() => expect(groupState.addPlace).toHaveBeenCalledWith("later", place.id));
    expect(groupState.addPlace).toHaveBeenCalledTimes(1);
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

  it("starts signed-out location only after the user requests Near Me", async () => {
    const watchLocation = vi.fn(() => vi.fn());
    restoreNative = registerNativeCapabilities({ getCurrentLocation: vi.fn(), getPhoto: vi.fn(), watchLocation });
    render(<ParkdexApp apiBaseUrl="" />);
    expect(watchLocation).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Show my current location" }));
    await waitFor(() => expect(watchLocation).toHaveBeenCalledTimes(1));
  });

  it("automatically tracks only a signed-in Android-build session", () => {
    const watchLocation = vi.fn(() => vi.fn());
    restoreNative = registerNativeCapabilities({ getCurrentLocation: vi.fn(), getPhoto: vi.fn(), watchLocation });
    journal.authenticated = true;
    journal.account = { id: "owner", email: "owner@example.test" };
    const { rerender } = render(<ParkdexApp apiBaseUrl="" />);
    expect(watchLocation).not.toHaveBeenCalled();
    rerender(<ParkdexApp apiBaseUrl="" automaticLocationAllowed />);
    expect(watchLocation).toHaveBeenCalledTimes(1);
  });

  it("keeps a manual location request alive through native startup and account hydration", async () => {
    let publish: ((location: LocationSample) => void) | undefined;
    const watchLocation = vi.fn((_options, onLocation: (location: LocationSample) => void) => {
      publish = onLocation;
      return vi.fn();
    });
    restoreNative = registerNativeCapabilities({ getCurrentLocation: vi.fn(), getPhoto: vi.fn(), watchLocation });
    publishNativeAppState(false);
    journal.loading = true;
    const { rerender } = render(<ParkdexApp apiBaseUrl="" />);

    fireEvent.click(screen.getByRole("button", { name: "Show my current location" }));
    expect(await screen.findByText("Finding your location…")).toBeTruthy();
    expect(watchLocation).not.toHaveBeenCalled();

    act(() => publishNativeAppState(true));
    await waitFor(() => expect(watchLocation).toHaveBeenCalledTimes(1));
    act(() => publish?.({ latitude: 49, longitude: -124, accuracyMeters: 6, capturedAtEpochMs: Date.now() }));
    expect(await screen.findByText("Forest Park")).toBeTruthy();
    expect(screen.getByTestId("park-map").dataset.currentLocation).toBe("49,-124");

    journal.authenticated = true;
    journal.account = null;
    rerender(<ParkdexApp apiBaseUrl="" />);
    journal.loading = false;
    journal.account = { id: "owner", email: "owner@example.test" };
    rerender(<ParkdexApp apiBaseUrl="" />);

    expect(watchLocation).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("park-map").dataset.currentLocation).toBe("49,-124");
  });

  it("restarts automatic Android tracking when Locate Me is tapped", async () => {
    const watchLocation = vi.fn(() => vi.fn());
    restoreNative = registerNativeCapabilities({ getCurrentLocation: vi.fn(), getPhoto: vi.fn(), watchLocation });
    journal.authenticated = true;
    journal.account = { id: "owner", email: "owner@example.test" };
    render(<ParkdexApp apiBaseUrl="" automaticLocationAllowed />);
    expect(watchLocation).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Show my current location" }));

    await waitFor(() => expect(watchLocation).toHaveBeenCalledTimes(2));
  });

  it("clears manual location when the authoritative account changes", async () => {
    let publish: ((location: LocationSample) => void) | undefined;
    const stop = vi.fn();
    const watchLocation = vi.fn((_options, onLocation: (location: LocationSample) => void) => {
      publish = onLocation;
      return stop;
    });
    restoreNative = registerNativeCapabilities({ getCurrentLocation: vi.fn(), getPhoto: vi.fn(), watchLocation });
    journal.authenticated = true;
    journal.account = { id: "owner-a", email: "a@example.test" };
    const { rerender } = render(<ParkdexApp apiBaseUrl="" />);
    fireEvent.click(screen.getByRole("button", { name: "Show my current location" }));
    await waitFor(() => expect(watchLocation).toHaveBeenCalledTimes(1));
    act(() => publish?.({ latitude: 49, longitude: -124, accuracyMeters: 6, capturedAtEpochMs: Date.now() }));
    expect(screen.getByTestId("park-map").dataset.currentLocation).toBe("49,-124");

    journal.authenticated = false;
    journal.account = null;
    rerender(<ParkdexApp apiBaseUrl="" />);
    await waitFor(() => expect(stop).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByTestId("park-map").dataset.currentLocation).toBe(""));

    journal.authenticated = true;
    journal.account = { id: "owner-b", email: "b@example.test" };
    rerender(<ParkdexApp apiBaseUrl="" />);
    expect(watchLocation).toHaveBeenCalledTimes(1);
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

  it("dismisses Near Me after a delayed location timeout", async () => {
    let failLocation: PositionErrorCallback = () => undefined;
    Object.defineProperty(navigator, "geolocation", { configurable: true, value: { getCurrentPosition: (_success: PositionCallback, failure: PositionErrorCallback) => { failLocation = failure; } } });
    render(<ParkdexApp apiBaseUrl="" />);
    fireEvent.click(screen.getByRole("button", { name: "Find places" }));
    fireEvent.click(screen.getByRole("button", { name: "Show my current location" }));
    expect(screen.getByRole("dialog", { name: "Near Me" })).toBeTruthy();
    act(() => failLocation({ code: 3, message: "Timed out", PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 }));
    expect(await screen.findByText("Your location is unavailable right now. Search the map instead.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close nearby places" }));
    expect(screen.queryByRole("dialog", { name: "Near Me" })).toBeNull();
  });

  it("dismisses Near Me while the browser location request is still pending", async () => {
    let failLocation: PositionErrorCallback = () => undefined;
    Object.defineProperty(navigator, "geolocation", { configurable: true, value: { getCurrentPosition: (_success: PositionCallback, failure: PositionErrorCallback) => { failLocation = failure; } } });
    render(<ParkdexApp apiBaseUrl="" />);
    fireEvent.click(screen.getByRole("button", { name: "Show my current location" }));
    expect(await screen.findByText("Finding your location…")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close nearby places" }));
    expect(screen.queryByRole("dialog", { name: "Near Me" })).toBeNull();
    act(() => failLocation({ code: 3, message: "Timed out", PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 }));
    expect(screen.queryByRole("dialog", { name: "Near Me" })).toBeNull();
  });

  it("claims the first-visit badge and keeps Escape from claiming it", async () => {
    journal.authenticated = true;
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
    journal.authenticated = true;
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
    await waitFor(() => expect(groupState.refreshAfterReset).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("does not clear the group cache when account reset fails", async () => {
    journal.authenticated = true;
    journal.account = { id: "account-1", email: "ranger@example.test" };
    journal.resetProgress.mockRejectedValueOnce(new Error("Reset failed."));
    render(<ParkdexApp apiBaseUrl="" />);
    fireEvent.click(screen.getByRole("button", { name: "Account" }));
    fireEvent.click(screen.getByRole("button", { name: "Reset my progress" }));
    fireEvent.click(screen.getByRole("button", { name: "Reset everything" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Reset failed.");
    expect(groupState.refreshAfterReset).not.toHaveBeenCalled();
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

  it("omits deferred native features from the Android build while keeping email accounts", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(JSON.stringify({ googleEnabled: true, emailEnabled: true }), { headers: { "Content-Type": "application/json" } }))));
    render(<ParkdexApp apiBaseUrl="https://api.example.test" googleAuthAllowed={false} geolocationAllowed={false} />);
    expect(screen.queryByRole("button", { name: "Show my current location" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Account" }));
    expect(screen.getByRole("heading", { name: "Keep your field journal" })).toBeTruthy();
    expect(screen.getByLabelText("Email")).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole("button", { name: "Continue with Google" })).toBeNull());
    expect(screen.queryByText("Google sign-in unavailable")).toBeNull();
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

  it("keeps collection search expanded in a bottom dock and exposes mixed category progress", () => {
    journal.authenticated = true; journal.visited = new Set([place.id, national.id]);
    render(<ParkdexApp apiBaseUrl="" />); fireEvent.click(screen.getByRole("button", { name: "Places" }));
    expect(screen.getByRole("progressbar", { name: "2 of 3 places collected" }).getAttribute("aria-valuenow")).toBe("2");
    const progress = screen.getByLabelText("Collection progress");
    expect(progress.textContent).toContain("2 of 3 collected");
    expect(progress.textContent).not.toContain("%");
    expect(progress.querySelector("li.category-provincial")?.textContent).toContain("1/2");
    expect(screen.queryByText("tracked", { exact: false })).toBeNull();
    const search = screen.getByRole("textbox", { name: "Search collection" });
    fireEvent.change(search, { target: { value: "Pacific" } });
    expect(screen.getByRole("button", { name: /Pacific Rim National Park Reserve/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clear collection search" }));
    expect(screen.getByRole("textbox", { name: "Search collection" })).toBe(search);
    expect((search as HTMLInputElement).value).toBe("");
  });

  it("gates global percentage on the last badge claim, ticks numerically, and settles ARIA once", () => {
    journal.authenticated = true;
    const frames: FrameRequestCallback[] = [];
    const requestFrame = vi.fn((callback: FrameRequestCallback) => { frames.push(callback); return frames.length; });
    vi.stubGlobal("requestAnimationFrame", requestFrame);
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
    const { rerender } = render(<ParkdexApp apiBaseUrl="" />);
    const progress = screen.getByRole("progressbar", { name: "Parkdex progress" });
    expect(progress.textContent).toBe("0.0%");
    expect(progress.children).toHaveLength(1);
    expect(progress.getAttribute("aria-valuetext")).toContain("0.0%");
    fireEvent.click(screen.getByRole("button", { name: "Test map marker" }));
    fireEvent.click(screen.getByRole("button", { name: "Mark as visited" }));
    journal.visited = new Set([place.id]);
    journal.visitTimestamps = { [place.id]: "2026-09-12T12:00:00Z" };
    rerender(<ParkdexApp apiBaseUrl="" />);
    expect(progress.getAttribute("aria-valuetext")).toContain("0.0%");
    fireEvent.click(screen.getByRole("button", { name: "Claim my badge" }));
    expect(requestFrame).toHaveBeenCalledTimes(1);
    expect(progress.textContent).toBe("0.0%");
    expect(progress.getAttribute("aria-valuetext")).toContain("0.0%");
    act(() => frames.shift()?.(0));
    act(() => frames.shift()?.(325));
    const midpoint = Number(progress.textContent?.replace("%", ""));
    expect(midpoint).toBeGreaterThan(0);
    expect(midpoint).toBeLessThan(33.3);
    expect(progress.getAttribute("aria-valuetext")).toContain("0.0%");
    act(() => frames.shift()?.(700));
    expect(progress.textContent).toBe("33.3%");
    expect(Number(progress.getAttribute("aria-valuenow"))).toBeCloseTo(33.33333333333333);
    expect(progress.getAttribute("aria-valuetext")).toBe("33.3% · 1 of 3 places visited");
  });

  it("settles global percentage immediately for reduced motion", () => {
    const requestFrame = vi.fn();
    vi.stubGlobal("requestAnimationFrame", requestFrame);
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
    const { rerender } = render(<ParkdexApp apiBaseUrl="" />);
    journal.visited = new Set([rathtrevor.id]);
    rerender(<ParkdexApp apiBaseUrl="" />);
    const progress = screen.getByRole("progressbar", { name: "Parkdex progress" });
    expect(progress.textContent).toBe("33.3%");
    expect(progress.getAttribute("aria-valuetext")).toBe("33.3% · 1 of 3 places visited");
    expect(requestFrame).not.toHaveBeenCalled();
  });

  it("ignores stale visited ids and keeps percentage ARIA bounded to 100", () => {
    journal.visited = new Set(["removed-place", ...defaultPlaces.map((item) => item.id)]);
    render(<ParkdexApp apiBaseUrl="" />);
    const progress = screen.getByRole("progressbar", { name: "Parkdex progress" });
    expect(progress.textContent).toBe("100.0%");
    expect(progress.getAttribute("aria-valuemin")).toBe("0");
    expect(progress.getAttribute("aria-valuemax")).toBe("100");
    expect(progress.getAttribute("aria-valuenow")).toBe("100");
    expect(progress.getAttribute("aria-valuetext")).toBe("100.0% · 3 of 3 places visited");
  });

  it("keeps the percentage in the header on My Map and hides it everywhere else", () => {
    journal.authenticated = true;
    journal.visited = new Set([place.id]);
    groupState.groups = [{ id: "coast", name: "Coast days", places: [place] }];
    const { container, rerender } = render(<ParkdexApp apiBaseUrl="" />);
    const assertMyMapProgress = () => {
      const progress = screen.getByRole("progressbar", { name: "Parkdex progress" });
      expect(progress.textContent).toBe("33.3%");
      expect(progress.closest(".expedition-header")).toBeTruthy();
      expect(container.querySelectorAll(".global-progress")).toHaveLength(1);
    };
    assertMyMapProgress();
    fireEvent.click(screen.getByRole("button", { name: "Find places" }));
    expect(screen.queryByRole("progressbar", { name: "Parkdex progress" })).toBeNull();
    expect(container.querySelector(".global-progress")?.hasAttribute("hidden")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "My map" }));
    assertMyMapProgress();
    for (const name of ["Places tab", "Groups tab", "Badges tab", "Account tab"]) {
      fireEvent.click(screen.getByRole("button", { name }));
      expect(screen.queryByRole("progressbar", { name: "Parkdex progress" })).toBeNull();
    }
    fireEvent.click(screen.getByRole("button", { name: "Map tab" }));
    assertMyMapProgress();
    fireEvent.click(screen.getByRole("button", { name: "Groups tab" }));
    groupState.selectedGroupId = "coast";
    rerender(<ParkdexApp apiBaseUrl="" />);
    fireEvent.click(screen.getByRole("button", { name: "View on map" }));
    expect(screen.queryByRole("progressbar", { name: "Parkdex progress" })).toBeNull();
    expect(container.querySelector(".global-progress")).toBeNull();
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

  it("renders nearby places with the same category row treatment as Places", async () => {
    Object.defineProperty(navigator, "geolocation", { configurable: true, value: { getCurrentPosition: (success: PositionCallback) => success({ coords: { latitude: 49, longitude: -124, accuracy: 5, altitude: null, altitudeAccuracy: null, heading: null, speed: null, toJSON: () => ({}) }, timestamp: Date.now(), toJSON: () => ({}) }) } });
    render(<ParkdexApp apiBaseUrl="" />);
    fireEvent.click(screen.getByRole("button", { name: "Show my current location" }));
    const row = await screen.findByRole("button", { name: /Forest Park/ });
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

  it("keeps signed-out park details informational instead of offering an invalid visit checkoff", () => {
    Object.assign(journal, {
      visitClaimMode: "required",
      recommendClaim: vi.fn(),
      createClaim: vi.fn(),
      reconcileClaim: vi.fn(),
      uploadVisitPhoto: vi.fn(),
      loadVisitPhoto: vi.fn(),
      removeVisitPhoto: vi.fn(),
    });
    render(<ParkdexApp apiBaseUrl="" />);

    fireEvent.click(screen.getByRole("button", { name: "Test map marker" }));

    expect(screen.queryByRole("button", { name: "Mark as visited" })).toBeNull();
    expect(screen.getByText("Visit claims belong to your account.")).toBeTruthy();
    expect(journal.toggleVisit).not.toHaveBeenCalled();
  });

  it("offers legacy account marking only after an old API is positively identified", () => {
    journal.authenticated = true;
    journal.account = { id: "owner", email: "owner@example.test" };
    (journal as Record<string, unknown>).visitClaimMode = "unknown";
    render(<ParkdexApp apiBaseUrl="" />);
    fireEvent.click(screen.getByRole("button", { name: "Test map marker" }));
    expect(screen.queryByRole("button", { name: "Mark as visited" })).toBeNull();

    cleanup();
    (journal as Record<string, unknown>).visitClaimMode = "legacy";
    render(<ParkdexApp apiBaseUrl="" />);
    fireEvent.click(screen.getByRole("button", { name: "Test map marker" }));
    expect(screen.getByRole("button", { name: "Mark as visited" })).toBeTruthy();
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

  it("lets Android Back close transient search state before browser history", () => {
    render(<ParkdexApp apiBaseUrl="" />);
    fireEvent.click(screen.getByRole("button", { name: "Search places" }));
    fireEvent.click(screen.getByRole("button", { name: "Filter places" }));
    expect(document.querySelector(".filter-tray")).toBeTruthy();

    act(() => { expect(dispatchNativeBack()).toBe(false); });
    expect(document.querySelector(".filter-tray")).toBeNull();
    expect(screen.getByRole("textbox", { name: "Search places" })).toBeTruthy();

    act(() => { expect(dispatchNativeBack()).toBe(false); });
    expect(screen.queryByRole("textbox", { name: "Search places" })).toBeNull();
  });

  it("lets Android Back dismiss dialogs and selected group state", () => {
    journal.authenticated = true;
    groupState.groups = [{ id: "coast", name: "Coast days", places: [place] }];
    render(<ParkdexApp apiBaseUrl="" />);
    fireEvent.click(screen.getByRole("button", { name: "Test map marker" }));
    fireEvent.click(screen.getByRole("button", { name: "Add this place to a group" }));
    expect(screen.getByRole("dialog", { name: "Forest Park" })).toBeTruthy();

    act(() => { expect(dispatchNativeBack()).toBe(false); });
    expect(screen.queryByRole("dialog", { name: "Forest Park" })).toBeNull();

    cleanup();
    groupState.selectedGroupId = "coast";
    render(<ParkdexApp apiBaseUrl="" />);
    fireEvent.click(screen.getByRole("button", { name: "Groups" }));
    act(() => { expect(dispatchNativeBack()).toBe(false); });
    expect(groupState.selectGroup).toHaveBeenCalledWith(null);
  });

  it("automatically offers an in-park claim and creates the postcard only after a photo is accepted", async () => {
    const confirmation = { placeId: place.id, visited: true as const, visitedCount: 1, visitedAt: "2026-09-08T12:00:00Z", claim: { claimedAt: "2026-09-08T12:00:00Z", capturedAt: "2026-09-08T12:00:00Z", coordinates: { latitude: place.latitude, longitude: place.longitude }, accuracyMeters: 8, boundaryVersion: "v1", matchKind: "exact" as const, distanceMeters: 0, hasPhoto: false } };
    journal.authenticated = true;
    journal.account = { id: "owner", email: "owner@example.test" };
    const createClaim = vi.fn().mockImplementation(async () => { (journal as Record<string, unknown>).visitMetadata = { [place.id]: confirmation }; journal.visited = new Set([place.id]); return confirmation; });
    Object.assign(journal, {
      visitClaimMode: "compatible",
      visitMetadata: {},
      recommendClaim: vi.fn().mockResolvedValue({ status: "recommended", recommendationToken: "signed", expiresAt: new Date(Date.now() + 60_000).toISOString(), candidate: { placeId: place.id, matchKind: "exact", distanceMeters: 0 } }),
      createClaim,
      reconcileClaim: vi.fn().mockResolvedValue(null),
      uploadVisitPhoto: vi.fn().mockResolvedValue(undefined),
      loadVisitPhoto: vi.fn().mockResolvedValue(new Blob(["photo"])),
      removeVisitPhoto: vi.fn().mockResolvedValue(undefined),
    });
    const photo = new File(["photo"], "forest.jpg", { type: "image/jpeg" });
    const photoRetry = { save: vi.fn().mockResolvedValue(undefined), load: vi.fn().mockResolvedValue(null), remove: vi.fn().mockResolvedValue(undefined), clearOwner: vi.fn().mockResolvedValue(undefined) };
    restoreNative = registerNativeCapabilities({ getCurrentLocation: vi.fn().mockResolvedValue({ latitude: place.latitude, longitude: place.longitude, accuracyMeters: 8, capturedAtEpochMs: Date.now() }), getPhoto: vi.fn().mockResolvedValue({ file: photo, mimeType: photo.type }), photoRetry });
    render(<ParkdexApp apiBaseUrl="" automaticLocationAllowed />);
    expect(await screen.findByText("You’re in Forest Park")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Test map marker" }));
    expect(screen.queryByRole("button", { name: "Mark as visited" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Check if I can claim a park" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Take an optional visit photo" })).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: "Claim + photo" }));
    await waitFor(() => expect(createClaim).toHaveBeenCalledWith({ recommendationToken: "signed", expectedPlaceId: place.id }));
    expect(await screen.findByRole("article", { name: /Inspect postcard from Forest Park/ })).toBeTruthy();
  });

  it("keeps a failed post-camera location check visible until it is dismissed", async () => {
    journal.authenticated = true;
    journal.account = { id: "owner", email: "owner@example.test" };
    const recommendation = { status: "recommended" as const, recommendationToken: "signed", expiresAt: new Date(Date.now() + 60_000).toISOString(), candidate: { placeId: place.id, matchKind: "exact" as const, distanceMeters: 0 } };
    const createClaim = vi.fn();
    Object.assign(journal, {
      visitClaimMode: "compatible",
      visitMetadata: {},
      recommendClaim: vi.fn().mockResolvedValueOnce(recommendation).mockResolvedValueOnce({ status: "no_candidate" }),
      createClaim,
      reconcileClaim: vi.fn().mockResolvedValue(null),
      uploadVisitPhoto: vi.fn(),
      loadVisitPhoto: vi.fn(),
      removeVisitPhoto: vi.fn(),
    });
    const photo = new File(["photo"], "forest.jpg", { type: "image/jpeg" });
    const photoRetry = { save: vi.fn().mockResolvedValue(undefined), load: vi.fn().mockResolvedValue(null), remove: vi.fn().mockResolvedValue(undefined), clearOwner: vi.fn().mockResolvedValue(undefined) };
    restoreNative = registerNativeCapabilities({ getCurrentLocation: vi.fn().mockResolvedValue({ latitude: place.latitude, longitude: place.longitude, accuracyMeters: 8, capturedAtEpochMs: Date.now() }), getPhoto: vi.fn().mockResolvedValue({ file: photo, mimeType: photo.type }), photoRetry });

    render(<ParkdexApp apiBaseUrl="" automaticLocationAllowed />);
    expect(await screen.findByText("You’re in Forest Park")).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "Claim + photo" }));
    expect(await screen.findByText(/could not confirm that you are still in this park/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(screen.queryByText(/could not confirm that you are still in this park/)).toBeNull());
    expect(createClaim).not.toHaveBeenCalled();
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

  it("keeps queued group membership available offline while disabling server-only edits", async () => {
    journal.authenticated = true;
    groupState.groups = [
      { id: "wishlist", name: "Wishlist", isWishlist: true, places: [] },
      { id: "coast", name: "Coast days", places: [place] },
    ];
    groupState.selectedGroupId = null;
    groupState.offline = true;
    groupState.syncStatus = "offline";
    groupState.syncMessage = "Your group changes are saved on this device and waiting to sync.";
    groupState.pendingMemberships = 2;
    render(<ParkdexApp apiBaseUrl="" />);

    fireEvent.click(screen.getByRole("button", { name: "Groups" }));
    expect(screen.getByText("Working offline")).toBeTruthy();
    expect(screen.getByText("Your group changes are saved on this device and waiting to sync.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "New group" }) as HTMLButtonElement).disabled).toBe(true);

    cleanup();
    groupState.selectedGroupId = "coast";
    render(<ParkdexApp apiBaseUrl="" />);
    expect((screen.getByRole("button", { name: "Rename Coast days" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Delete Coast days" }) as HTMLButtonElement).disabled).toBe(true);

    const removeMember = screen.getByRole("button", { name: "Remove Forest Park from Coast days" });
    expect((removeMember as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(removeMember);
    await waitFor(() => expect(groupState.removePlace).toHaveBeenCalledWith("coast", place.id));

    fireEvent.change(screen.getByPlaceholderText("Search places to add"), { target: { value: "Rathtrevor" } });
    const addMember = screen.getByRole("button", { name: /Rathtrevor Beach Park/ });
    expect((addMember as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(addMember);
    await waitFor(() => expect(groupState.addPlace).toHaveBeenCalledWith("coast", rathtrevor.id));

    cleanup();
    groupState.selectedGroupId = null;
    groupState.groups = [
      { id: "wishlist", name: "Wishlist", isWishlist: true, places: [] },
      { id: "coast", name: "Coast days", places: [] },
    ];
    groupState.addPlace.mockClear();
    render(<ParkdexApp apiBaseUrl="" />);
    fireEvent.click(screen.getByRole("button", { name: "Map" }));
    fireEvent.click(screen.getByRole("button", { name: "Test map marker" }));
    const wishlistToggle = screen.getByRole("button", { name: "Add this place to Wishlist" });
    expect((wishlistToggle as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(wishlistToggle);
    await waitFor(() => expect(groupState.addPlace).toHaveBeenCalledWith("wishlist", place.id));

    fireEvent.click(screen.getByRole("button", { name: "Add this place to a group" }));
    expect((screen.getByRole("button", { name: "Create group" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: /Coast days/ }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByText("Reconnect to create a group. You can still save this place to an existing group.")).toBeTruthy();
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
    fireEvent.change(screen.getByRole("textbox", { name: "Search collection" }), { target: { value: "Pacific" } });
    expect(screen.getByText("National Parks").closest("details")?.hasAttribute("open")).toBe(true);
    expect(screen.getByRole("button", { name: /Pacific Rim National Park Reserve/ })).toBeTruthy();
  });

  it("shows account place photography and filters visited parks from Nearby", async () => {
    journal.authenticated = true; journal.account = { id: "account-1", email: "ranger@example.test" }; journal.visited = new Set([place.id]); journal.visitTimestamps = { [place.id]: "2026-09-07T12:00:00Z" };
    const location = { latitude: 49, longitude: -124, accuracy: 5, altitude: null, altitudeAccuracy: null, heading: null, speed: null, toJSON: () => ({}) };
    Object.defineProperty(navigator, "geolocation", { configurable: true, value: { getCurrentPosition: (success: PositionCallback) => success({ coords: location, timestamp: Date.now(), toJSON: () => ({}) }) } });
    render(<ParkdexApp apiBaseUrl="" />);
    fireEvent.click(screen.getByRole("button", { name: "Account" }));
    expect(screen.getByRole("button", { name: "Open Forest Park" }).querySelector("img")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Map" }));
    fireEvent.click(screen.getByRole("button", { name: "Show my current location" }));
    expect(screen.getByRole("heading", { name: "Near Me" })).toBeTruthy();
    expect(await screen.findByText("Closest places you have not visited yet")).toBeTruthy();
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
