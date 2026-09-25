// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PlaceVisualEntry } from "@/lib/place-visuals";
import { PlaceVisualsModal } from "./place-visuals-modal";

vi.mock("./place-visuals-3d", () => ({
  default: ({ src, label }: { src: string; label: string }) => (
    <div role="region" aria-label={label} data-model-src={src}>
      <button type="button">Reset view</button>
    </div>
  ),
}));

const placeId = "provincial-juan-de-fuca-park";
const entry: PlaceVisualEntry = {
  placeId,
  satellite: `${placeId}/satellite.avif`,
  relief: `${placeId}/relief.avif`,
  model: `${placeId}/${placeId}-terrain.glb`,
  attribution: ["Contains modified Copernicus Sentinel data 2025"],
  acquired: ["2025-06-01"],
  needsReview: true,
  reviewFlags: ["Satellite source footprint is partial"],
};

afterEach(cleanup);

describe("PlaceVisualsModal", () => {
  it("switches between imagery and lazy 3D, shows source dates, and closes accessibly", async () => {
    function Harness() {
      const [open, setOpen] = useState(false);
      return <>
        <button type="button" onClick={() => setOpen(true)}>Map views</button>
        {open && <PlaceVisualsModal placeName="Forest Park" entry={entry} baseUrl="/park-visuals-fixture" onClose={() => setOpen(false)} />}
      </>;
    }

    render(<Harness />);
    const launcher = screen.getByRole("button", { name: "Map views" });
    launcher.focus();
    fireEvent.click(launcher);
    const dialog = await screen.findByRole("dialog", { name: "Map views Forest Park" });
    expect(screen.getByRole("tab", { name: "Satellite" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("img", { name: "Satellite view of Forest Park" }).getAttribute("src"))
      .toBe(`${window.location.origin}/park-visuals-fixture/${placeId}/satellite.avif`);
    expect(screen.queryByRole("region", { name: "Forest Park 3D terrain" })).toBeNull();
    expect(dialog.textContent).toContain("Contains modified Copernicus Sentinel data 2025");
    expect(dialog.textContent).toContain("2025-06-01");
    expect(dialog.textContent).toContain("Satellite source footprint is partial");
    expect(dialog.querySelector("a")).toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: "Relief" }));
    expect(screen.getByRole("tab", { name: "Relief" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("img", { name: "Relief view of Forest Park" }).getAttribute("src"))
      .toBe(`${window.location.origin}/park-visuals-fixture/${placeId}/relief.avif`);

    fireEvent.click(screen.getByRole("tab", { name: "3D" }));
    const terrain = await screen.findByRole("region", { name: "Forest Park 3D terrain" });
    expect(terrain.getAttribute("data-model-src"))
      .toBe(`${window.location.origin}/park-visuals-fixture/${placeId}/${placeId}-terrain.glb`);
    expect(screen.getByRole("button", { name: "Reset view" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Close map views" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Map views Forest Park" })).toBeNull());
    expect(document.activeElement).toBe(launcher);
  });
});
