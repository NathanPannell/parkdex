// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { resetParkSealBoundaryCache } from "./park-seal";
import { PostcardPrint } from "./postcard-print";

const place = { id: "park-1", name: "Forest Park", category: "provincial" as const, latitude: 49, longitude: -124, region: "South", description: "Forest", sourceUrl: "https://example.test", sourceName: "BC Parks" };

beforeEach(() => vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404 })));
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); resetParkSealBoundaryCache(); });

it("renders an outline-only recorded visit without inventing a user photo", () => {
  render(<PostcardPrint place={place} visitedAt="2026-09-08T12:00:00Z" sealed />);
  expect(screen.getByText("Visit recorded")).toBeTruthy();
  expect(screen.queryByRole("img", { name: "Private visit photo from Forest Park" })).toBeNull();
  expect(document.querySelector(".impression-print[data-sealed='true']")).toBeTruthy();
});

it("renders the caller's private photo URL and compact presentation state", () => {
  render(<PostcardPrint place={place} photoUrl="blob:private-photo" visitedAt="2026-09-08T12:00:00Z" compact />);
  expect(screen.getByRole("img", { name: "Private visit photo from Forest Park" }).getAttribute("src")).toBe("blob:private-photo");
  expect(document.querySelector(".impression-print.impression-print--compact")).toBeTruthy();
});
