// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerNativeCapabilities } from "@/lib/native-capabilities";
import type { Visit } from "@/lib/account";
import { ClaimVisitPanel } from "./claim-visit-panel";

const place = { id: "provincial-juan-de-fuca-park", name: "Forest Park", category: "provincial" as const, latitude: 49, longitude: -124, region: "South Island", description: "Forest", sourceUrl: "https://example.test", sourceName: "BC Parks" };
const location = { latitude: 49, longitude: -124, accuracyMeters: 8, capturedAtEpochMs: Date.now() };
const recommendation = { status: "recommended" as const, recommendationToken: "token", expiresAt: new Date(Date.now() + 60_000).toISOString(), candidate: { placeId: place.id, matchKind: "exact" as const, distanceMeters: 0 } };
const confirmation = { placeId: place.id, visited: true as const, visitedCount: 1, visitedAt: "2026-09-08T12:00:00Z", claim: { claimedAt: "2026-09-08T12:00:00Z", capturedAt: "2026-09-08T12:00:00Z", coordinates: { latitude: 49, longitude: -124 }, accuracyMeters: 8, boundaryVersion: "v1", matchKind: "exact" as const, distanceMeters: 0, hasPhoto: false } };
let restore: () => void = () => undefined;

afterEach(() => { cleanup(); restore(); vi.restoreAllMocks(); });

function props() {
  return { place, busy: false, recommendClaim: vi.fn().mockResolvedValue(recommendation), createClaim: vi.fn().mockResolvedValue(confirmation), uploadPhoto: vi.fn().mockResolvedValue(undefined), loadPhoto: vi.fn(), removePhoto: vi.fn() };
}

describe("ClaimVisitPanel", () => {
  it("shows the one matching recommendation and creates a nonoptimistic claim", async () => {
    restore = registerNativeCapabilities({ getCurrentLocation: vi.fn().mockResolvedValue(location), getPhoto: vi.fn().mockResolvedValue(null) });
    const handlers = props(); render(<ClaimVisitPanel {...handlers} />);
    fireEvent.click(screen.getByRole("button", { name: "Check if I can claim a park" }));
    expect(await screen.findByText("You’re here, claim this park now")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Claim this park" }));
    await waitFor(() => expect(handlers.createClaim).toHaveBeenCalledWith({ recommendationToken: "token", expectedPlaceId: place.id }));
  });

  it("requires explicit confirmation before a recovered photo can attach", async () => {
    const photo = new File(["photo"], "visit.jpg", { type: "image/jpeg" });
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob:preview") }); Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
    restore = registerNativeCapabilities({ getCurrentLocation: vi.fn().mockResolvedValue(location), getPhoto: vi.fn().mockResolvedValue({ file: photo, mimeType: photo.type }) });
    const handlers = props(); render(<ClaimVisitPanel {...handlers} />);
    fireEvent.click(screen.getByRole("button", { name: "Take an optional visit photo" }));
    expect(await screen.findByRole("button", { name: "Use photo" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Check if I can claim a park" }));
    const claimButton = await screen.findByRole("button", { name: "Claim this park" });
    expect((claimButton as HTMLButtonElement).disabled).toBe(true); expect(handlers.uploadPhoto).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Use photo" })); fireEvent.click(claimButton);
    await waitFor(() => expect(handlers.uploadPhoto).toHaveBeenCalledWith(place.id, photo));
  });

  it("keeps the confirmed visit when photo upload fails and offers retry", async () => {
    const photo = new File(["photo"], "visit.jpg", { type: "image/jpeg" });
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob:preview") }); Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
    restore = registerNativeCapabilities({ getCurrentLocation: vi.fn().mockResolvedValue(location), getPhoto: vi.fn().mockResolvedValue({ file: photo, mimeType: photo.type }) });
    const handlers = props(); handlers.uploadPhoto.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(undefined);
    function Parent() {
      const [selected, setSelected] = useState(place);
      const [visit, setVisit] = useState<Visit | undefined>();
      const openClaimedOther = () => { setSelected({ ...place, id: "provincial-goldstream-park", name: "Goldstream Provincial Park" }); setVisit({ ...confirmation, placeId: "provincial-goldstream-park" }); };
      return <><button onClick={openClaimedOther}>Open claimed Goldstream</button><ClaimVisitPanel {...handlers} place={selected} visit={visit} onClaimed={(created) => setVisit(created)} /></>;
    }
    render(<Parent />);
    fireEvent.click(screen.getByRole("button", { name: "Take an optional visit photo" })); await screen.findByRole("button", { name: "Use photo" }); fireEvent.click(screen.getByRole("button", { name: "Use photo" }));
    fireEvent.click(screen.getByRole("button", { name: "Check if I can claim a park" })); await screen.findByText("You’re here, claim this park now"); fireEvent.click(screen.getByRole("button", { name: "Claim this park" }));
    expect(await screen.findByText(/visit is saved, but the photo did not upload/i)).toBeTruthy(); expect(screen.getByLabelText(/Inspect postcard/)).toBeTruthy(); expect(handlers.createClaim).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Open claimed Goldstream" }));
    fireEvent.click(screen.getByRole("button", { name: "Retry photo upload" })); await waitFor(() => expect(handlers.uploadPhoto).toHaveBeenCalledTimes(2)); expect(handlers.createClaim).toHaveBeenCalledTimes(1);
    expect(handlers.uploadPhoto.mock.calls[1]).toEqual([place.id, photo]);
  });

  it("names and opens the recommended park when the current sheet does not match", async () => {
    const other = { ...recommendation, candidate: { ...recommendation.candidate, placeId: "provincial-goldstream-park" } };
    restore = registerNativeCapabilities({ getCurrentLocation: vi.fn().mockResolvedValue(location), getPhoto: vi.fn().mockResolvedValue(null) });
    const handlers = props(); handlers.recommendClaim.mockResolvedValue(other);
    const onOpenPlace = vi.fn();
    render(<ClaimVisitPanel {...handlers} placeNameForId={(id) => id === other.candidate.placeId ? "Goldstream Provincial Park" : undefined} onOpenPlace={onOpenPlace} />);
    fireEvent.click(screen.getByRole("button", { name: "Check if I can claim a park" }));
    const open = await screen.findByRole("button", { name: "Open Goldstream Provincial Park" });
    fireEvent.click(open);
    expect(onOpenPlace).toHaveBeenCalledWith(other.candidate.placeId);
  });

  it("requires photo reconfirmation when opening a different recommended park", async () => {
    const otherPlace = { ...place, id: "provincial-goldstream-park", name: "Goldstream Provincial Park" };
    const photo = new File(["photo"], "visit.jpg", { type: "image/jpeg" });
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob:preview") }); Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
    restore = registerNativeCapabilities({ getCurrentLocation: vi.fn().mockResolvedValue(location), getPhoto: vi.fn().mockResolvedValue({ file: photo, mimeType: photo.type }) });
    const handlers = props(); handlers.recommendClaim.mockResolvedValue({ ...recommendation, candidate: { ...recommendation.candidate, placeId: otherPlace.id } });
    function Parent() { const [selected, setSelected] = useState(place); return <ClaimVisitPanel {...handlers} place={selected} placeNameForId={(id) => id === otherPlace.id ? otherPlace.name : undefined} onOpenPlace={() => setSelected(otherPlace)} />; }
    render(<Parent />); fireEvent.click(screen.getByRole("button", { name: "Take an optional visit photo" })); await screen.findByRole("button", { name: "Use photo" }); fireEvent.click(screen.getByRole("button", { name: "Use photo" }));
    fireEvent.click(screen.getByRole("button", { name: "Check if I can claim a park" })); fireEvent.click(await screen.findByRole("button", { name: `Open ${otherPlace.name}` }));
    const claimButton = screen.getByRole("button", { name: "Claim this park" }) as HTMLButtonElement; expect(claimButton.disabled).toBe(true); expect(screen.getByText(`Use this photo for ${otherPlace.name}?`)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Use photo" })); expect(claimButton.disabled).toBe(false); expect(handlers.uploadPhoto).not.toHaveBeenCalled();
  });
});
