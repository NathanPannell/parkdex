// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  addNativeBackConsumer,
  dispatchNativeBack,
  hasNativeBackHistory,
} from "./native-back";

afterEach(() => {
  window.history.replaceState(null, "", "/");
});

describe("native Android Back", () => {
  it.each(["/", "/map", "/parks/goldstream-park", "/settings", "/map?query=river"])(
    "does not attempt browser Back after a direct load of %s",
    (href) => {
      window.history.replaceState(null, "", href);
      expect(hasNativeBackHistory(window.location)).toBe(false);
    },
  );

  it("uses the app-owned route depth to recognize navigable history", () => {
    window.history.replaceState({ parkdexRouteDepth: 0 }, "", "/map");
    expect(hasNativeBackHistory(window.location)).toBe(false);
    window.history.pushState({ parkdexRouteDepth: 1 }, "", "/settings");
    expect(hasNativeBackHistory(window.location)).toBe(true);
    window.history.pushState({ parkdexRouteDepth: 2 }, "", "/parks/goldstream-park");
    expect(hasNativeBackHistory(window.location)).toBe(true);
  });

  it.each([-1, 0, 1.5, "1", Number.NaN])("rejects an invalid route depth of %s", (depth) => {
    window.history.replaceState({ parkdexRouteDepth: depth }, "", "/settings");
    expect(hasNativeBackHistory(window.location)).toBe(false);
  });

  it("lets an active overlay consume Back and unregister cleanly", () => {
    const consumer = vi.fn();
    const remove = addNativeBackConsumer(consumer);

    expect(dispatchNativeBack()).toBe(false);
    expect(consumer).toHaveBeenCalledOnce();

    remove();
    expect(dispatchNativeBack()).toBe(true);
    expect(consumer).toHaveBeenCalledOnce();
  });

  it("gives the topmost active overlay first refusal", () => {
    const underneath = vi.fn(), topmost = vi.fn();
    const removeUnderneath = addNativeBackConsumer(underneath);
    const removeTopmost = addNativeBackConsumer(topmost);

    expect(dispatchNativeBack()).toBe(false);
    expect(topmost).toHaveBeenCalledOnce();
    expect(underneath).not.toHaveBeenCalled();

    removeTopmost();
    expect(dispatchNativeBack()).toBe(false);
    expect(underneath).toHaveBeenCalledOnce();
    removeUnderneath();
  });
});
