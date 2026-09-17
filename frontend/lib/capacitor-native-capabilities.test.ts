// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const camera = vi.hoisted(() => ({ takePhoto: vi.fn() }));
const geolocation = vi.hoisted(() => ({
  checkPermissions: vi.fn(),
  clearWatch: vi.fn(),
  getCurrentPosition: vi.fn(),
  requestPermissions: vi.fn(),
  watchPosition: vi.fn(),
}));

vi.mock("@capacitor/camera", () => ({ Camera: camera, CameraDirection: { Rear: "REAR" } }));
vi.mock("@capacitor/geolocation", () => ({ Geolocation: geolocation }));

import {
  clearRestoredCameraPhoto,
  createCapacitorNativeCapabilities,
  queueRestoredCameraPhoto,
} from "./capacitor-native-capabilities";
import type { LocationCapabilityError } from "./native-capabilities";

beforeEach(() => {
  vi.restoreAllMocks();
  camera.takePhoto.mockReset();
  geolocation.checkPermissions.mockReset();
  geolocation.clearWatch.mockReset();
  geolocation.clearWatch.mockResolvedValue(undefined);
  geolocation.getCurrentPosition.mockReset();
  geolocation.getCurrentPosition.mockRejectedValue(new Error("No cached location"));
  geolocation.requestPermissions.mockReset();
  geolocation.watchPosition.mockReset();
  clearRestoredCameraPhoto();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Capacitor native capabilities", () => {
  it("returns the shared location shape and preserves request constraints", async () => {
    geolocation.checkPermissions.mockResolvedValue({ location: "granted" });
    geolocation.getCurrentPosition.mockResolvedValue({
      coords: { latitude: 48.4284, longitude: -123.3656, accuracy: 12 },
      timestamp: 1_780_000_000_000,
    });

    const location = await createCapacitorNativeCapabilities().getCurrentLocation({
      highAccuracy: true,
      timeoutMs: 12_000,
      maxAgeMs: 60_000,
    });

    expect(location).toEqual({
      latitude: 48.4284,
      longitude: -123.3656,
      accuracyMeters: 12,
      capturedAtEpochMs: 1_780_000_000_000,
    });
    expect(geolocation.getCurrentPosition).toHaveBeenCalledWith({
      enableHighAccuracy: true,
      timeout: 12_000,
      maximumAge: 60_000,
    });
  });

  it("requests precise Android location when only approximate access is granted", async () => {
    geolocation.checkPermissions.mockResolvedValue({ location: "denied", coarseLocation: "granted" });
    geolocation.requestPermissions.mockResolvedValue({ location: "denied", coarseLocation: "granted" });
    geolocation.getCurrentPosition.mockResolvedValue({
      coords: { latitude: 48.4, longitude: -123.4, accuracy: 1_200 },
      timestamp: 1_780_000_000_001,
    });

    const capabilities = createCapacitorNativeCapabilities();
    await expect(capabilities.getCurrentLocation({
      highAccuracy: true,
      timeoutMs: 12_000,
      maxAgeMs: 60_000,
    })).resolves.toMatchObject({ accuracyMeters: 1_200 });
    expect(geolocation.requestPermissions).toHaveBeenCalledWith({ permissions: ["location"] });
    expect(geolocation.getCurrentPosition).toHaveBeenCalledWith({
      enableHighAccuracy: false,
      timeout: 12_000,
      maximumAge: 60_000,
    });
  });

  it("maps denied permission and location timeout failures", async () => {
    geolocation.checkPermissions.mockResolvedValue({ location: "denied" });
    geolocation.requestPermissions.mockResolvedValue({ location: "denied" });
    await expect(createCapacitorNativeCapabilities().getCurrentLocation({
      highAccuracy: true,
      timeoutMs: 1,
      maxAgeMs: 0,
    })).rejects.toMatchObject({ code: "permission-denied" } satisfies Partial<LocationCapabilityError>);

    geolocation.checkPermissions.mockResolvedValue({ location: "granted" });
    geolocation.getCurrentPosition.mockRejectedValue({ code: "OS-PLUG-GLOC-0010" });
    await expect(createCapacitorNativeCapabilities().getCurrentLocation({
      highAccuracy: true,
      timeoutMs: 1,
      maxAgeMs: 0,
    })).rejects.toMatchObject({ code: "timeout" } satisfies Partial<LocationCapabilityError>);
  });

  it("streams high-accuracy foreground locations faster than 30 seconds and clears the native watch", async () => {
    geolocation.checkPermissions.mockResolvedValue({ location: "granted" });
    geolocation.getCurrentPosition.mockResolvedValue({
      coords: { latitude: 49.09186, longitude: -123.06008, accuracy: 9 },
      timestamp: 1_780_000_000_001,
    });
    geolocation.watchPosition.mockImplementation(async (_options, callback) => {
      callback({
        coords: { latitude: 49.09187, longitude: -123.06009, accuracy: 6 },
        timestamp: 1_780_000_000_002,
      });
      return "watch-1";
    });
    const onLocation = vi.fn();
    const onError = vi.fn();

    const stop = createCapacitorNativeCapabilities().watchLocation?.({
      highAccuracy: true,
      timeoutMs: 30_000,
      maxAgeMs: 5_000,
      updateIntervalMs: 5_000,
      minimumUpdateIntervalMs: 2_000,
    }, onLocation, onError);
    await vi.waitFor(() => expect(onLocation).toHaveBeenCalledOnce());

    expect(geolocation.getCurrentPosition).toHaveBeenCalledWith({
      enableHighAccuracy: true,
      timeout: 12_000,
      maximumAge: 60_000,
    });

    expect(geolocation.watchPosition).toHaveBeenCalledWith({
      enableHighAccuracy: true,
      timeout: 30_000,
      maximumAge: 5_000,
      interval: 5_000,
      minimumUpdateInterval: 2_000,
    }, expect.any(Function));
    expect(onLocation).toHaveBeenCalledWith({
      latitude: 49.09187,
      longitude: -123.06009,
      accuracyMeters: 6,
      capturedAtEpochMs: 1_780_000_000_002,
    });
    expect(onError).not.toHaveBeenCalled();

    stop?.();
    expect(geolocation.clearWatch).toHaveBeenCalledWith({ id: "watch-1" });
  });

  it("publishes a cached fix while a live watch is still warming up", async () => {
    geolocation.checkPermissions.mockResolvedValue({ location: "granted" });
    geolocation.getCurrentPosition.mockResolvedValue({
      coords: { latitude: 49.09186, longitude: -123.06008, accuracy: 9 },
      timestamp: 1_780_000_000_001,
    });
    geolocation.watchPosition.mockResolvedValue("watch-warming");
    const onLocation = vi.fn();

    const stop = createCapacitorNativeCapabilities().watchLocation?.({
      highAccuracy: true,
      timeoutMs: 30_000,
      maxAgeMs: 5_000,
      updateIntervalMs: 5_000,
      minimumUpdateIntervalMs: 2_000,
    }, onLocation);

    await vi.waitFor(() => expect(onLocation).toHaveBeenCalledWith({
      latitude: 49.09186,
      longitude: -123.06008,
      accuracyMeters: 9,
      capturedAtEpochMs: 1_780_000_000_001,
    }));
    stop?.();
  });

  it("clears a native watch that resolves after its lifecycle has already stopped", async () => {
    geolocation.checkPermissions.mockResolvedValue({ location: "granted" });
    let resolveWatch!: (id: string) => void;
    geolocation.watchPosition.mockReturnValue(new Promise((resolve) => { resolveWatch = resolve; }));

    const stop = createCapacitorNativeCapabilities().watchLocation?.({
      highAccuracy: true,
      timeoutMs: 30_000,
      maxAgeMs: 0,
      updateIntervalMs: 30_000,
    }, vi.fn());
    await vi.waitFor(() => expect(geolocation.watchPosition).toHaveBeenCalledOnce());
    stop?.();
    resolveWatch("late-watch");
    await vi.waitFor(() => expect(geolocation.clearWatch).toHaveBeenCalledWith({ id: "late-watch" }));
  });

  it("reports permission and native watch failures through the foreground callback", async () => {
    geolocation.checkPermissions.mockResolvedValueOnce({ location: "denied" });
    geolocation.requestPermissions.mockResolvedValueOnce({ location: "denied" });
    const denied = vi.fn();
    createCapacitorNativeCapabilities().watchLocation?.({
      highAccuracy: true,
      timeoutMs: 30_000,
      maxAgeMs: 0,
      updateIntervalMs: 30_000,
    }, vi.fn(), denied);
    await vi.waitFor(() => expect(denied).toHaveBeenCalledWith(expect.objectContaining({ code: "permission-denied" })));

    geolocation.checkPermissions.mockResolvedValueOnce({ location: "granted" });
    geolocation.watchPosition.mockImplementationOnce(async (_options, callback) => {
      callback(null, { code: "OS-PLUG-GLOC-0010" });
      return "watch-error";
    });
    const timedOut = vi.fn();
    const stop = createCapacitorNativeCapabilities().watchLocation?.({
      highAccuracy: true,
      timeoutMs: 30_000,
      maxAgeMs: 0,
      updateIntervalMs: 30_000,
    }, vi.fn(), timedOut);
    await vi.waitFor(() => expect(timedOut).toHaveBeenCalledWith(expect.objectContaining({ code: "timeout" })));
    stop?.();
  });

  it("returns an uploadable File, does not save to the gallery, and treats cancellation as no selection", async () => {
    camera.takePhoto.mockResolvedValue({ webPath: "capacitor://photo", metadata: { format: "jpeg" } });
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      blob: async () => new Blob(["photo"], { type: "image/jpeg" }),
    })));

    const result = await createCapacitorNativeCapabilities().getPhoto();

    expect(result?.mimeType).toBe("image/jpeg");
    expect(result?.file).toBeInstanceOf(File);
    expect(result?.file.name).toMatch(/\.jpg$/);
    expect(camera.takePhoto).toHaveBeenCalledWith(expect.objectContaining({
      editable: "no",
      includeMetadata: false,
      saveToGallery: false,
    }));

    camera.takePhoto.mockRejectedValue({ code: "OS-PLUG-CAMR-0006" });
    await expect(createCapacitorNativeCapabilities().getPhoto()).resolves.toBeNull();
  });

  it("hands a restored Android camera result to the next photo request", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      blob: async () => new Blob(["restored"], { type: "image/jpeg" }),
    })));

    expect(queueRestoredCameraPhoto({
      pluginId: "OtherPlugin",
      methodName: "takePhoto",
      success: true,
      data: { webPath: "capacitor://other-photo" },
    })).toBe(false);
    expect(queueRestoredCameraPhoto({
      pluginId: "Camera",
      methodName: "takePhoto",
      success: true,
      data: { webPath: "capacitor://restored-photo", metadata: { format: "jpeg" } },
    })).toBe(true);

    const result = await createCapacitorNativeCapabilities().getPhoto();

    expect(result?.file).toBeInstanceOf(File);
    expect(result?.mimeType).toBe("image/jpeg");
    expect(camera.takePhoto).not.toHaveBeenCalled();
  });

  it("can clear a restored result before a different journal owner requests a photo", async () => {
    camera.takePhoto.mockResolvedValue({ webPath: "capacitor://fresh-photo", metadata: { format: "jpeg" } });
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      blob: async () => new Blob(["fresh"], { type: "image/jpeg" }),
    })));
    queueRestoredCameraPhoto({
      pluginId: "Camera",
      methodName: "takePhoto",
      success: true,
      data: { webPath: "capacitor://previous-owner-photo", metadata: { format: "jpeg" } },
    });

    clearRestoredCameraPhoto();
    await createCapacitorNativeCapabilities().getPhoto();

    expect(camera.takePhoto).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledWith("capacitor://fresh-photo");
  });

  it("ignores cancelled or malformed restored results and opens a fresh camera request", async () => {
    camera.takePhoto.mockResolvedValue({ webPath: "capacitor://fresh-photo", metadata: { format: "jpeg" } });
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      blob: async () => new Blob(["fresh"], { type: "image/jpeg" }),
    })));

    expect(queueRestoredCameraPhoto({
      pluginId: "Camera",
      methodName: "takePhoto",
      success: false,
      data: { webPath: "capacitor://cancelled-photo" },
    })).toBe(false);
    expect(queueRestoredCameraPhoto({
      pluginId: "Camera",
      methodName: "takePhoto",
      success: true,
      data: {},
    })).toBe(false);

    await expect(createCapacitorNativeCapabilities().getPhoto()).resolves.toMatchObject({
      mimeType: "image/jpeg",
    });
    expect(camera.takePhoto).toHaveBeenCalledOnce();
  });
});
