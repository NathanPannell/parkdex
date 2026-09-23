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
  it.each([
    ["/?view=account", true],
    ["/?place=provincial-goldstream-park", true],
    ["/field-guide", true],
    ["/#account", true],
    ["/", false],
  ])("recognizes whether %s has browser history state to consume", (href, expected) => {
    window.history.replaceState(null, "", href);
    expect(hasNativeBackHistory(window.location)).toBe(expected);
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
