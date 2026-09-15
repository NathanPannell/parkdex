// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const app = vi.hoisted(() => ({ addListener: vi.fn(), minimizeApp: vi.fn() }));
const systemBars = vi.hoisted(() => ({ setStyle: vi.fn() }));
const storage = vi.hoisted(() => ({ getPlatformStorage: vi.fn(), registerNativePlatformStorage: vi.fn() }));

vi.mock("@capacitor/app", () => ({ App: app }));
vi.mock("@capacitor/core", () => ({
  registerPlugin: vi.fn(() => ({})),
  SystemBars: systemBars,
  SystemBarsStyle: { Light: "LIGHT" },
}));
vi.mock("@capacitor/preferences", () => ({ Preferences: {} }));
vi.mock("@/lib/platform-storage", () => ({
  getPlatformStorage: storage.getPlatformStorage,
  registerNativePlatformStorage: storage.registerNativePlatformStorage,
}));
vi.mock("@/lib/capacitor-native-capabilities", () => ({
  createCapacitorNativeCapabilities: vi.fn(() => ({ getCurrentLocation: vi.fn(), getPhoto: vi.fn() })),
  queueRestoredCameraPhoto: vi.fn(),
}));
vi.mock("@/lib/native-capabilities", () => ({ registerNativeCapabilities: vi.fn(() => vi.fn()) }));

import { NativeRuntime } from "./native-runtime";

beforeEach(() => {
  storage.getPlatformStorage.mockReset();
  systemBars.setStyle.mockReset();
  app.addListener.mockReset();
  app.minimizeApp.mockReset();
});

afterEach(cleanup);

describe("NativeRuntime", () => {
  it("renders after storage opens even when optional native integrations fail", async () => {
    storage.getPlatformStorage.mockResolvedValue({});
    systemBars.setStyle.mockRejectedValue(new Error("unsupported system bars"));
    app.addListener.mockRejectedValue(new Error("unsupported listener"));

    render(<NativeRuntime enabled><p>Journal ready</p></NativeRuntime>);

    expect(await screen.findByText("Journal ready")).toBeTruthy();
  });

  it("keeps the journal gated when required native storage cannot open", async () => {
    storage.getPlatformStorage.mockRejectedValue(new Error("Secure storage is locked."));
    systemBars.setStyle.mockResolvedValue(undefined);
    app.addListener.mockResolvedValue({ remove: vi.fn() });

    render(<NativeRuntime enabled><p>Journal ready</p></NativeRuntime>);

    expect((await screen.findByRole("alert")).textContent).toContain("Secure storage is locked.");
    expect(screen.queryByText("Journal ready")).toBeNull();
  });
});
