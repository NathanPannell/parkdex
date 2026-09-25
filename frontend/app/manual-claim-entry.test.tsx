// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import Home from "./page";
import { ParkdexPage } from "./_components/parkdex-page";
import { ParkdexApp } from "@/components/every-park-app";

vi.mock("@/components/every-park-app", () => ({ ParkdexApp: vi.fn(() => null) }));

afterEach(() => { cleanup(); vi.unstubAllEnvs(); vi.mocked(ParkdexApp).mockClear(); });

it("passes the staging-only manual claim flag through both app entry pages", () => {
  vi.stubEnv("NEXT_PUBLIC_MANUAL_CLAIM_ENABLED", "1");
  render(<Home />);
  render(<ParkdexPage />);
  expect(vi.mocked(ParkdexApp)).toHaveBeenCalledTimes(2);
  for (const [props] of vi.mocked(ParkdexApp).mock.calls) expect(props.manualClaimEnabled).toBe(true);
});

it("keeps the control disabled in a production build", () => {
  vi.stubEnv("NEXT_PUBLIC_MANUAL_CLAIM_ENABLED", "0");
  render(<Home />);
  render(<ParkdexPage />);
  for (const [props] of vi.mocked(ParkdexApp).mock.calls) expect(props.manualClaimEnabled).toBe(false);
});
