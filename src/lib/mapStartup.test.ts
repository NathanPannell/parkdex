import { afterEach, describe, expect, it, vi } from "vitest";
import type { Map as MapLibreMap } from "maplibre-gl";
import { prewarmBundledOverview } from "./offlineTiles";
import { watchBundledOverviewReadiness } from "./mapStartup";

type MapEvent = "render" | "error";
type Listener = (event?: unknown) => void;

class MockMapEvents {
  private readonly listeners = new Map<MapEvent, Set<Listener>>();
  loadedOverview = false;
  readonly isSourceLoaded = vi.fn((sourceId: string) => sourceId === "islandOverview" && this.loadedOverview);

  on(event: MapEvent, listener: Listener): this {
    const listeners = this.listeners.get(event) ?? new Set<Listener>();
    listeners.add(listener);
    this.listeners.set(event, listeners);
    return this;
  }

  off(event: MapEvent, listener: Listener): this {
    this.listeners.get(event)?.delete(listener);
    return this;
  }

  emit(event: MapEvent, data: unknown = {}): void {
    for (const listener of this.listeners.get(event) ?? []) listener(data);
  }

  listenerCount(event: MapEvent): number {
    return this.listeners.get(event)?.size ?? 0;
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("bundled overview startup", () => {
  it("shares a pending archive read and retries after a failed preload", async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error("temporary local read failure"))
      .mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => new Uint8Array(256).buffer,
      });
    vi.stubGlobal("fetch", fetchMock);

    const first = prewarmBundledOverview();
    const concurrent = prewarmBundledOverview();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await expect(first).rejects.toThrow("temporary local read failure");
    await expect(concurrent).rejects.toThrow("temporary local read failure");

    await prewarmBundledOverview();
    await prewarmBundledOverview();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("opens the marker gate only after a render sees the overview source loaded", () => {
    const mapEvents = new MockMapEvents();
    const ready = vi.fn();
    watchBundledOverviewReadiness(mapEvents as unknown as Pick<MapLibreMap, "isSourceLoaded" | "on" | "off">, ready);

    mapEvents.emit("error", { sourceId: "protomaps" });
    mapEvents.emit("render");
    expect(ready).not.toHaveBeenCalled();

    mapEvents.loadedOverview = true;
    mapEvents.emit("render");
    expect(mapEvents.isSourceLoaded).toHaveBeenCalledWith("islandOverview");
    expect(ready).toHaveBeenCalledTimes(1);
    expect(mapEvents.listenerCount("render")).toBe(0);
    expect(mapEvents.listenerCount("error")).toBe(0);
  });

  it("releases pins on an overview error or bounded timeout and cleans up on unmount", () => {
    vi.useFakeTimers();
    const failedOverview = new MockMapEvents();
    const failedReady = vi.fn();
    watchBundledOverviewReadiness(
      failedOverview as unknown as Pick<MapLibreMap, "isSourceLoaded" | "on" | "off">,
      failedReady,
      800,
    );
    failedOverview.emit("error", { sourceId: "islandOverview" });
    expect(failedReady).toHaveBeenCalledTimes(1);
    expect(failedOverview.listenerCount("render")).toBe(0);
    expect(failedOverview.listenerCount("error")).toBe(0);

    const timedOutOverview = new MockMapEvents();
    const timedOutReady = vi.fn();
    const stop = watchBundledOverviewReadiness(
      timedOutOverview as unknown as Pick<MapLibreMap, "isSourceLoaded" | "on" | "off">,
      timedOutReady,
      800,
    );
    timedOutOverview.emit("error", { sourceId: "protomaps" });
    vi.advanceTimersByTime(799);
    expect(timedOutReady).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(timedOutReady).toHaveBeenCalledTimes(1);
    expect(timedOutOverview.listenerCount("render")).toBe(0);
    expect(timedOutOverview.listenerCount("error")).toBe(0);

    const unmountedOverview = new MockMapEvents();
    const unmountedReady = vi.fn();
    const cleanup = watchBundledOverviewReadiness(
      unmountedOverview as unknown as Pick<MapLibreMap, "isSourceLoaded" | "on" | "off">,
      unmountedReady,
      800,
    );
    cleanup();
    vi.advanceTimersByTime(800);
    expect(unmountedReady).not.toHaveBeenCalled();
    expect(unmountedOverview.listenerCount("render")).toBe(0);
    expect(unmountedOverview.listenerCount("error")).toBe(0);
  });
});
