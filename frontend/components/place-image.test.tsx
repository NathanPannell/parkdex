// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import type { ImgHTMLAttributes } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PlaceImage } from "./place-image";

vi.mock("next/image", () => ({
  default: ({ preload, alt = "", ...props }: ImgHTMLAttributes<HTMLImageElement> & { preload?: boolean }) => (
    // eslint-disable-next-line @next/next/no-img-element
    <img alt={alt} data-preload={preload ? "true" : undefined} {...props} />
  ),
}));

afterEach(cleanup);

describe("PlaceImage", () => {
  it("uses the compact lazy thumbnail without attribution clutter", () => {
    const { container } = render(
      <PlaceImage
        place={{ id: "provincial-artlish-caves-park", name: "Artlish Caves Park" }}
        variant="thumbnail"
      />,
    );

    const image = screen.getByRole("img", { name: /rocky entrance/i });
    expect(image.getAttribute("src")).toBe("/places/artlish-caves-thumb.webp");
    expect(image.getAttribute("loading")).toBe("lazy");
    expect(image.getAttribute("sizes")).toBe("72px");
    expect(container.querySelector("figcaption")).toBeNull();
  });

  it("uses the detail variant and exposes source, original, and license links", () => {
    render(
      <PlaceImage
        place={{ id: "provincial-artlish-caves-park", name: "Artlish Caves Park" }}
        variant="card"
      />,
    );

    expect(screen.getByRole("img", { name: /rocky entrance/i }).getAttribute("src")).toBe(
      "/places/artlish-caves.webp",
    );
    expect(screen.getByRole("link", { name: "Ian mckenzie" }).getAttribute("href")).toContain("commons.wikimedia.org");
    expect(screen.getByRole("link", { name: "Original" }).getAttribute("href")).toContain("upload.wikimedia.org");
    expect(screen.getByRole("link", { name: "CC BY-SA 3.0" }).getAttribute("href")).toContain("creativecommons.org");
  });

  it("states honestly when no verified photo exists", () => {
    render(
      <PlaceImage place={{ id: "provincial-woss-lake-park", name: "Woss Lake Park" }} variant="card" />,
    );

    expect(screen.getByRole("img", { name: "Photo unavailable for Woss Lake Park" }).textContent).toContain("Photo unavailable");
  });
});
