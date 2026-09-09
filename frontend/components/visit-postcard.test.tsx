// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { VisitPostcard } from "./visit-postcard";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it("loads a private photo into a temporary object URL and revokes it", async () => {
  const place = { id: "park-1", name: "Forest Park", category: "provincial" as const, latitude: 49, longitude: -124, region: "South", description: "Forest", sourceUrl: "https://example.test", sourceName: "BC Parks" };
  const visit = { placeId: place.id, visitedAt: "2026-09-08T12:00:00Z", claim: { claimedAt: "2026-09-08T12:00:00Z", capturedAt: "2026-09-08T12:00:00Z", coordinates: { latitude: 49, longitude: -124 }, accuracyMeters: 8, boundaryVersion: "v1", matchKind: "exact" as const, distanceMeters: 0, hasPhoto: true } };
  const create = vi.fn(() => "blob:private-photo"), revoke = vi.fn(); Object.defineProperty(URL, "createObjectURL", { configurable: true, value: create }); Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revoke });
  const loadPhoto = vi.fn().mockResolvedValue(new Blob(["photo"], { type: "image/jpeg" }));
  const view = render(<VisitPostcard place={place} visit={visit} loadPhoto={loadPhoto} />);
  expect((await screen.findByAltText("Private visit photo from Forest Park")).getAttribute("src")).toBe("blob:private-photo");
  expect(loadPhoto).toHaveBeenCalledWith(place.id); expect(create).toHaveBeenCalled();
  view.unmount(); await waitFor(() => expect(revoke).toHaveBeenCalledWith("blob:private-photo"));
});
