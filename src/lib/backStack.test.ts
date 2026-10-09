import { describe, expect, it, vi } from "vitest";
import { handleBack, pushBackHandler } from "./backStack";

describe("back stack", () => {
  it("runs the newest handler first and passes through when empty", () => {
    expect(handleBack()).toBe(false);
    const flow = vi.fn();
    const review = vi.fn();
    const removeFlow = pushBackHandler(flow);
    const removeReview = pushBackHandler(review);
    expect(handleBack()).toBe(true);
    expect(review).toHaveBeenCalledTimes(1);
    expect(flow).not.toHaveBeenCalled();
    removeReview();
    expect(handleBack()).toBe(true);
    expect(flow).toHaveBeenCalledTimes(1);
    removeFlow();
    expect(handleBack()).toBe(false);
  });

  it("removes only its own handler", () => {
    const a = vi.fn();
    const b = vi.fn();
    const removeA = pushBackHandler(a);
    const removeB = pushBackHandler(b);
    removeA();
    handleBack();
    expect(b).toHaveBeenCalledTimes(1);
    expect(a).not.toHaveBeenCalled();
    removeB();
  });
});
