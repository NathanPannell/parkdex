import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { canGoFullscreen, fullscreenOffer, installOffer, isAppleMobile, portraitPanel, type WebAppEnv } from "./webApp";
import { qrPath } from "./qr";

const androidTab: WebAppEnv = {
  native: false,
  installed: false,
  promptReady: false,
  appleMobile: false,
  coarsePointer: true,
  fullscreenEnabled: true,
  fullscreen: false,
};

describe("installOffer", () => {
  it("offers Chrome's prompt once it has fired", () => {
    expect(installOffer(androidTab)).toBeNull();
    expect(installOffer({ ...androidTab, promptReady: true })).toBe("prompt");
  });

  it("gives iPhones the Add to Home Screen hint", () => {
    expect(installOffer({ ...androidTab, appleMobile: true, fullscreenEnabled: false })).toBe("apple-hint");
  });

  it("leaves desktops out even when Chrome offers the prompt", () => {
    expect(installOffer({ ...androidTab, promptReady: true, coarsePointer: false })).toBeNull();
  });

  it("offers nothing once installed or in a native build", () => {
    expect(installOffer({ ...androidTab, promptReady: true, installed: true })).toBeNull();
    expect(installOffer({ ...androidTab, appleMobile: true, installed: true })).toBeNull();
    expect(installOffer({ ...androidTab, promptReady: true, native: true })).toBeNull();
  });
});

describe("full screen", () => {
  it("goes full screen only in a phone browser tab", () => {
    expect(canGoFullscreen(androidTab)).toBe(true);
    expect(canGoFullscreen({ ...androidTab, coarsePointer: false })).toBe(false);
    expect(canGoFullscreen({ ...androidTab, installed: true })).toBe(false);
    expect(canGoFullscreen({ ...androidTab, native: true })).toBe(false);
    expect(canGoFullscreen({ ...androidTab, appleMobile: true })).toBe(false);
    expect(canGoFullscreen({ ...androidTab, fullscreenEnabled: false })).toBe(false);
  });

  it("offers full screen again in Settings only after leaving it", () => {
    expect(fullscreenOffer({ ...androidTab, fullscreen: true })).toBe(false);
    expect(fullscreenOffer(androidTab)).toBe(true);
  });
});

describe("isAppleMobile", () => {
  it("knows iPhones and iPads, including iPadOS's desktop user agent", () => {
    expect(isAppleMobile("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1", 5)).toBe(true);
    expect(isAppleMobile("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15", 5)).toBe(true);
    expect(isAppleMobile("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15", 0)).toBe(false);
    expect(isAppleMobile("Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 Chrome/141.0 Mobile Safari/537.36", 5)).toBe(false);
  });
});

describe("portraitPanel", () => {
  const web = { native: false, landscapeViewport: true, coarsePointer: false };

  it("shows the desktop panel in a wide desktop window and nothing in a narrow one", () => {
    expect(portraitPanel(web)).toBe("desktop");
    expect(portraitPanel({ ...web, landscapeViewport: false })).toBeNull();
  });

  it("asks a phone held sideways to turn upright, and steps aside when it is upright", () => {
    expect(portraitPanel({ ...web, coarsePointer: true })).toBe("sideways");
    expect(portraitPanel({ ...web, coarsePointer: true, landscapeViewport: false })).toBeNull();
  });

  it("never shows in a native build", () => {
    expect(portraitPanel({ ...web, native: true })).toBeNull();
    expect(portraitPanel({ ...web, native: true, coarsePointer: true })).toBeNull();
  });
});

describe("qrPath", () => {
  it("draws a square code with a quiet border", () => {
    const qr = qrPath("https://web.parkdex.app/");
    // Version 2 (25 modules) with M correction fits this URL; the border adds 2 on each side.
    expect(qr.size).toBe(29);
    expect(qr.d).toMatch(/^M2 2h1v1h-1z/);
    expect(qr.d).not.toMatch(/M0 0h/);
    expect(qrPath("https://web.parkdex.app/")).toEqual(qr);
  });
});

describe("web app files", () => {
  const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url));
  const manifest = JSON.parse(read("public/manifest.webmanifest").toString("utf8"));

  it("has a manifest that Chrome can install, full screen and portrait", () => {
    expect(manifest).toMatchObject({
      name: "Parkdex",
      short_name: "Parkdex",
      start_url: "/",
      scope: "/",
      display: "fullscreen",
      display_override: ["fullscreen", "standalone"],
      orientation: "portrait",
      theme_color: "#FFF8EC",
      background_color: "#FFF8EC",
    });
    expect(manifest.prefer_related_applications).not.toBe(true);
  });

  it("ships 192, 512 and maskable 512 icons at their stated sizes", () => {
    const icons = manifest.icons as { src: string; sizes: string; purpose: string }[];
    expect(icons.map((icon) => `${icon.sizes} ${icon.purpose}`)).toEqual(["192x192 any", "512x512 any", "512x512 maskable"]);
    for (const icon of [...icons, { src: "/icons/apple-touch-icon.png", sizes: "180x180" }]) {
      const png = read(`public${icon.src}`);
      expect(png.subarray(1, 4).toString("ascii")).toBe("PNG");
      expect(`${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`).toBe(icon.sizes);
    }
  });

  it("links the manifest and iPhone tags from index.html", () => {
    const html = read("index.html").toString("utf8");
    expect(html).toContain('<link rel="manifest" href="/manifest.webmanifest"');
    expect(html).toContain('name="apple-mobile-web-app-capable" content="yes"');
    expect(html).toContain('name="apple-mobile-web-app-status-bar-style"');
    expect(html).toContain('rel="apple-touch-icon" href="/icons/apple-touch-icon.png"');
    expect(html).toContain('<meta name="theme-color" content="#FFF8EC" />');
  });

  it("keeps the service worker free of caches, so it never serves stale app or content files", () => {
    const worker = read("public/sw.js").toString("utf8");
    expect(worker).not.toMatch(/\bcaches\.|CacheStorage|importScripts|indexedDB/);
    expect(worker).toContain('request.mode !== "navigate"');
    expect(worker).toContain('path.startsWith("/api/")');
  });
});
