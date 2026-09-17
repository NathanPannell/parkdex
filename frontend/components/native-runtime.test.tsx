// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const app = vi.hoisted(() => ({ addListener: vi.fn(), getState: vi.fn(), minimizeApp: vi.fn() }));
const systemBars = vi.hoisted(() => ({ setStyle: vi.fn() }));
const storage = vi.hoisted(() => ({ getPlatformStorage: vi.fn(), registerNativePlatformStorage: vi.fn() }));
const native = vi.hoisted(() => ({ publishNativeAppState: vi.fn(), registerNativeCapabilities: vi.fn(() => vi.fn()) }));

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
vi.mock("@/lib/native-capabilities", () => native);

import { NativeRuntime } from "./native-runtime";

beforeEach(() => {
  storage.getPlatformStorage.mockReset();
  systemBars.setStyle.mockReset();
  app.addListener.mockReset();
  app.getState.mockReset();
  app.getState.mockResolvedValue({ isActive: true });
  app.minimizeApp.mockReset();
  native.publishNativeAppState.mockReset();
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

  it("forwards native lifecycle events and removes every location listener on unmount", async () => {
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const removals = new Map<string, ReturnType<typeof vi.fn>>();
    storage.getPlatformStorage.mockResolvedValue({});
    systemBars.setStyle.mockResolvedValue(undefined);
    app.addListener.mockImplementation((event: string, callback: (...args: unknown[]) => void) => {
      listeners.set(event, callback);
      const remove = vi.fn();
      removals.set(event, remove);
      return Promise.resolve({ remove });
    });

    const rendered = render(<NativeRuntime enabled><p>Journal ready</p></NativeRuntime>);
    expect(await screen.findByText("Journal ready")).toBeTruthy();
    await waitFor(() => expect(listeners.has("appStateChange") && listeners.has("pause") && listeners.has("resume")).toBe(true));
    await waitFor(() => expect(app.getState).toHaveBeenCalledTimes(2));
    listeners.get("appStateChange")?.({ isActive: false });
    expect(native.publishNativeAppState).toHaveBeenLastCalledWith(false);
    listeners.get("appStateChange")?.({ isActive: true });
    expect(native.publishNativeAppState).toHaveBeenLastCalledWith(true);
    listeners.get("pause")?.();
    expect(native.publishNativeAppState).toHaveBeenLastCalledWith(false);
    listeners.get("resume")?.();
    expect(native.publishNativeAppState).toHaveBeenLastCalledWith(true);
    rendered.unmount();
    await waitFor(() => {
      expect(removals.get("appStateChange")).toHaveBeenCalledTimes(1);
      expect(removals.get("pause")).toHaveBeenCalledTimes(1);
      expect(removals.get("resume")).toHaveBeenCalledTimes(1);
    });
  });

  it("keeps native location fail-closed until the initial app state resolves", async () => {
    const state = Promise.withResolvers<{ isActive: boolean }>();
    storage.getPlatformStorage.mockResolvedValue({});
    systemBars.setStyle.mockResolvedValue(undefined);
    app.getState.mockReturnValue(state.promise);
    app.addListener.mockResolvedValue({ remove: vi.fn() });

    render(<NativeRuntime enabled><p>Journal ready</p></NativeRuntime>);
    expect(await screen.findByText("Journal ready")).toBeTruthy();
    expect(native.publishNativeAppState).toHaveBeenNthCalledWith(1, false);
    expect(native.publishNativeAppState).not.toHaveBeenCalledWith(true);
    state.resolve({ isActive: false });
    await waitFor(() => expect(app.getState).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(native.publishNativeAppState).toHaveBeenLastCalledWith(false));
  });

  it("resolves the initial app state without waiting for listener registration", async () => {
    const listener = Promise.withResolvers<{ remove: ReturnType<typeof vi.fn> }>();
    storage.getPlatformStorage.mockResolvedValue({});
    systemBars.setStyle.mockResolvedValue(undefined);
    app.addListener.mockReturnValue(listener.promise);

    render(<NativeRuntime enabled><p>Journal ready</p></NativeRuntime>);

    expect(await screen.findByText("Journal ready")).toBeTruthy();
    await waitFor(() => expect(app.getState).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(native.publishNativeAppState).toHaveBeenLastCalledWith(true));
    listener.resolve({ remove: vi.fn() });
  });

  it("reconciles a lifecycle transition that occurs while listeners attach", async () => {
    const listener = Promise.withResolvers<{ remove: ReturnType<typeof vi.fn> }>();
    storage.getPlatformStorage.mockResolvedValue({});
    systemBars.setStyle.mockResolvedValue(undefined);
    app.addListener.mockReturnValue(listener.promise);
    app.getState.mockResolvedValueOnce({ isActive: true }).mockResolvedValueOnce({ isActive: false });

    render(<NativeRuntime enabled><p>Journal ready</p></NativeRuntime>);

    expect(await screen.findByText("Journal ready")).toBeTruthy();
    await waitFor(() => expect(native.publishNativeAppState).toHaveBeenLastCalledWith(true));
    listener.resolve({ remove: vi.fn() });
    await waitFor(() => expect(app.getState).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(native.publishNativeAppState).toHaveBeenLastCalledWith(false));
  });

  it("does not let an older lifecycle snapshot overwrite a newer result", async () => {
    const firstState = Promise.withResolvers<{ isActive: boolean }>();
    const secondState = Promise.withResolvers<{ isActive: boolean }>();
    storage.getPlatformStorage.mockResolvedValue({});
    systemBars.setStyle.mockResolvedValue(undefined);
    app.addListener.mockResolvedValue({ remove: vi.fn() });
    app.getState.mockReturnValueOnce(firstState.promise).mockReturnValueOnce(secondState.promise);

    render(<NativeRuntime enabled><p>Journal ready</p></NativeRuntime>);

    expect(await screen.findByText("Journal ready")).toBeTruthy();
    await waitFor(() => expect(app.getState).toHaveBeenCalledTimes(2));
    secondState.resolve({ isActive: false });
    await waitFor(() => expect(native.publishNativeAppState).toHaveBeenLastCalledWith(false));
    firstState.resolve({ isActive: true });
    await Promise.resolve();
    expect(native.publishNativeAppState).toHaveBeenLastCalledWith(false);
  });

  it("uses the first lifecycle snapshot when the later reconciliation rejects", async () => {
    const firstState = Promise.withResolvers<{ isActive: boolean }>();
    storage.getPlatformStorage.mockResolvedValue({});
    systemBars.setStyle.mockResolvedValue(undefined);
    app.addListener.mockResolvedValue({ remove: vi.fn() });
    app.getState.mockReturnValueOnce(firstState.promise).mockRejectedValueOnce(new Error("state unavailable"));

    render(<NativeRuntime enabled><p>Journal ready</p></NativeRuntime>);

    expect(await screen.findByText("Journal ready")).toBeTruthy();
    await waitFor(() => expect(app.getState).toHaveBeenCalledTimes(2));
    firstState.resolve({ isActive: true });
    await waitFor(() => expect(native.publishNativeAppState).toHaveBeenLastCalledWith(true));
  });

  it("uses the first lifecycle snapshot while the later reconciliation is still pending", async () => {
    const firstState = Promise.withResolvers<{ isActive: boolean }>();
    const secondState = Promise.withResolvers<{ isActive: boolean }>();
    storage.getPlatformStorage.mockResolvedValue({});
    systemBars.setStyle.mockResolvedValue(undefined);
    app.addListener.mockResolvedValue({ remove: vi.fn() });
    app.getState.mockReturnValueOnce(firstState.promise).mockReturnValueOnce(secondState.promise);

    render(<NativeRuntime enabled><p>Journal ready</p></NativeRuntime>);

    expect(await screen.findByText("Journal ready")).toBeTruthy();
    await waitFor(() => expect(app.getState).toHaveBeenCalledTimes(2));
    firstState.resolve({ isActive: true });
    await waitFor(() => expect(native.publishNativeAppState).toHaveBeenLastCalledWith(true));
  });
});
