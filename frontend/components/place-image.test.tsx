// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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
    expect(screen.getByRole("link", { name: "Source image" }).getAttribute("href")).toContain("upload.wikimedia.org");
    expect(screen.getByRole("link", { name: "CC BY-SA 3.0" }).getAttribute("href")).toContain("creativecommons.org");
    expect(screen.getByText(/Changes: Resized without upscaling, converted to WebP/)).toBeTruthy();
  });

  it("uses the text-free tree placeholder when no verified photo exists", () => {
    render(
      <PlaceImage place={{ id: "provincial-woss-lake-park", name: "Woss Lake Park" }} variant="card" />,
    );

    const placeholder = screen.getByRole("img", { name: "Placeholder artwork for Woss Lake Park" });
    expect(placeholder.querySelector("img")?.getAttribute("src")).toBe("/places/place-placeholder.png");
    expect(placeholder.textContent).toBe("");
  });

  it("lets a detail view select each approved photo and updates its attribution", () => {
    const onSelectedIndexChange = vi.fn();
    const { container, rerender } = render(
      <PlaceImage
        place={{ id: "provincial-bear-creek-park", name: "Bear Creek Park" }}
        variant="card"
        gallery
        selectedIndex={0}
        onSelectedIndexChange={onSelectedIndexChange}
      />,
    );

    const firstPhoto = screen.getByRole("img").getAttribute("src");
    const firstSource = container.querySelector("figcaption a")?.getAttribute("href");
    expect(screen.getByText("1 / 2")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /show photo/i })).toHaveLength(2);

    fireEvent.click(screen.getByRole("button", { name: "Next photo of Bear Creek Park" }));
    expect(onSelectedIndexChange).toHaveBeenCalledWith(1);

    rerender(
      <PlaceImage
        place={{ id: "provincial-bear-creek-park", name: "Bear Creek Park" }}
        variant="card"
        gallery
        selectedIndex={1}
        onSelectedIndexChange={onSelectedIndexChange}
      />,
    );

    expect(screen.getByText("2 / 2")).toBeTruthy();
    expect(screen.getByRole("img").getAttribute("src")).not.toBe(firstPhoto);
    expect(container.querySelector("figcaption a")?.getAttribute("href")).not.toBe(firstSource);
  });

  it("keeps gallery controls out of single-photo cards", () => {
    render(
      <PlaceImage
        place={{ id: "provincial-artlish-caves-park", name: "Artlish Caves Park" }}
        variant="card"
        gallery
      />,
    );

    expect(screen.queryByRole("button", { name: /photo of Artlish Caves Park/ })).toBeNull();
    expect(screen.queryByText(/1 \/ 1/)).toBeNull();
  });
});
