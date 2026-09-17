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
const preferences = vi.hoisted(() => ({ get: vi.fn(), remove: vi.fn(), set: vi.fn() }));

vi.mock("@capacitor/camera", () => ({ Camera: camera, CameraDirection: { Rear: "REAR" } }));
vi.mock("@capacitor/geolocation", () => ({ Geolocation: geolocation }));
vi.mock("@capacitor/preferences", () => ({ Preferences: preferences }));

import {
  clearRestoredCameraPhoto,
  createCapacitorNativeCapabilities,
  queueRestoredCameraPhoto,
} from "./capacitor-native-capabilities";
import type { LocationCapabilityError } from "./native-capabilities";

beforeEach(async () => {
  vi.restoreAllMocks();
  camera.takePhoto.mockReset();
  geolocation.checkPermissions.mockReset();
  geolocation.clearWatch.mockReset();
  geolocation.clearWatch.mockResolvedValue(undefined);
  geolocation.getCurrentPosition.mockReset();
  geolocation.getCurrentPosition.mockRejectedValue(new Error("No cached location"));
  geolocation.requestPermissions.mockReset();
  geolocation.watchPosition.mockReset();
  preferences.get.mockReset();
  preferences.remove.mockReset();
  preferences.set.mockReset();
  let storedValue: string | null = null;
  preferences.get.mockImplementation(async () => ({ value: storedValue }));
  preferences.set.mockImplementation(async ({ value }: { value: string }) => { storedValue = value; });
  preferences.remove.mockImplementation(async () => { storedValue = null; });
  await clearRestoredCameraPhoto();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const captureScope = (captureAttemptId = "attempt-a", ownerKey = "account:user-1", placeId = "bell-park") => ({ ownerKey, placeId, captureAttemptId });
const persistedScope = (captureAttemptId = "attempt-a", ownerKey = "account:user-1", placeId = "bell-park", startedAtEpochMs = Date.now()) => ({ ...captureScope(captureAttemptId, ownerKey, placeId), startedAtEpochMs });

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

  it("uses approximate Android location without reopening the precise permission flow", async () => {
    geolocation.checkPermissions.mockResolvedValue({ location: "denied", coarseLocation: "granted" });
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
    expect(geolocation.requestPermissions).not.toHaveBeenCalled();
    expect(geolocation.getCurrentPosition).toHaveBeenCalledWith({
      enableHighAccuracy: false,
      timeout: 12_000,
      maximumAge: 60_000,
    });
  });

  it("starts an approximate-only foreground watch without prompting again", async () => {
    geolocation.checkPermissions.mockResolvedValue({ location: "denied", coarseLocation: "granted" });
    geolocation.watchPosition.mockResolvedValue("coarse-watch");

    const stop = createCapacitorNativeCapabilities().watchLocation?.({
      highAccuracy: true,
      timeoutMs: 30_000,
      maxAgeMs: 300_000,
      updateIntervalMs: 5_000,
    }, vi.fn());
    await vi.waitFor(() => expect(geolocation.watchPosition).toHaveBeenCalledOnce());

    expect(geolocation.requestPermissions).not.toHaveBeenCalled();
    expect(geolocation.watchPosition).toHaveBeenCalledWith(expect.objectContaining({ enableHighAccuracy: false }), expect.any(Function));
    stop?.();
  });

  it("stops a downgraded precise watch without reopening Android permission", async () => {
    geolocation.checkPermissions.mockResolvedValue({ location: "denied", coarseLocation: "granted" });
    const onError = vi.fn();

    const stop = createCapacitorNativeCapabilities().watchLocation?.({
      highAccuracy: true,
      timeoutMs: 30_000,
      maxAgeMs: 300_000,
      updateIntervalMs: 5_000,
      requirePrecise: true,
    }, vi.fn(), onError);
    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: "precise-required" })));

    expect(geolocation.requestPermissions).not.toHaveBeenCalled();
    expect(geolocation.watchPosition).not.toHaveBeenCalled();
    stop?.();

    geolocation.watchPosition.mockResolvedValue("coarse-watch");
    const coarseStop = createCapacitorNativeCapabilities().watchLocation?.({
      highAccuracy: true,
      timeoutMs: 30_000,
      maxAgeMs: 300_000,
      updateIntervalMs: 5_000,
    }, vi.fn(), onError);
    await vi.waitFor(() => expect(geolocation.watchPosition).toHaveBeenCalledOnce());
    expect(geolocation.watchPosition).toHaveBeenCalledWith(expect.objectContaining({ enableHighAccuracy: false }), expect.any(Function));
    expect(geolocation.requestPermissions).not.toHaveBeenCalled();
    coarseStop?.();
  });

  it("requests a precise-location upgrade only for an accuracy-sensitive claim", async () => {
    geolocation.checkPermissions.mockResolvedValue({ location: "denied", coarseLocation: "granted" });
    geolocation.requestPermissions.mockResolvedValue({ location: "granted", coarseLocation: "granted" });
    geolocation.getCurrentPosition.mockResolvedValue({
      coords: { latitude: 49.09187, longitude: -123.06009, accuracy: 7 },
      timestamp: 1_780_000_000_002,
    });

    await expect(createCapacitorNativeCapabilities().getCurrentLocation({
      highAccuracy: true,
      timeoutMs: 12_000,
      maxAgeMs: 0,
      requirePrecise: true,
    })).resolves.toMatchObject({ accuracyMeters: 7 });

    expect(geolocation.requestPermissions).toHaveBeenCalledOnce();
    expect(geolocation.requestPermissions).toHaveBeenCalledWith({ permissions: ["location"] });
    expect(geolocation.getCurrentPosition).toHaveBeenCalledWith({
      enableHighAccuracy: true,
      timeout: 12_000,
      maximumAge: 0,
    });
  });

  it("returns an actionable claim error when Android remains approximate-only", async () => {
    geolocation.checkPermissions.mockResolvedValue({ location: "denied", coarseLocation: "granted" });
    geolocation.requestPermissions.mockResolvedValue({ location: "denied", coarseLocation: "granted" });

    await expect(createCapacitorNativeCapabilities().getCurrentLocation({
      highAccuracy: true,
      timeoutMs: 12_000,
      maxAgeMs: 0,
      requirePrecise: true,
    })).rejects.toMatchObject({
      code: "precise-required",
      message: expect.stringMatching(/Turn on precise location for Parkdex in Android settings/i),
    });
    expect(geolocation.getCurrentPosition).not.toHaveBeenCalled();
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
      enableHighAccuracy: false,
      timeout: 12_000,
      maximumAge: 300_000,
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

  it("does not start a late watch after a deferred permission check is stopped", async () => {
    const permission = Promise.withResolvers<{ location: "granted" }>();
    geolocation.checkPermissions.mockReturnValue(permission.promise);
    const stop = createCapacitorNativeCapabilities().watchLocation?.({
      highAccuracy: true,
      timeoutMs: 30_000,
      maxAgeMs: 5_000,
      updateIntervalMs: 5_000,
    }, vi.fn());

    stop?.();
    permission.resolve({ location: "granted" });
    await permission.promise;
    await Promise.resolve();

    expect(geolocation.getCurrentPosition).not.toHaveBeenCalled();
    expect(geolocation.watchPosition).not.toHaveBeenCalled();
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

    const result = await createCapacitorNativeCapabilities().getPhoto(captureScope());

    expect(result?.mimeType).toBe("image/jpeg");
    expect(result?.file).toBeInstanceOf(File);
    expect(result?.file.name).toMatch(/\.jpg$/);
    expect(camera.takePhoto).toHaveBeenCalledWith(expect.objectContaining({
      editable: "no",
      includeMetadata: false,
      saveToGallery: false,
    }));

    camera.takePhoto.mockRejectedValue({ code: "OS-PLUG-CAMR-0006" });
    await expect(createCapacitorNativeCapabilities().getPhoto(captureScope())).resolves.toBeNull();
  });

  it("hands a restored Android camera result only to its original claim scope", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      blob: async () => new Blob(["restored"], { type: "image/jpeg" }),
    })));

    await expect(queueRestoredCameraPhoto({
      pluginId: "OtherPlugin",
      methodName: "takePhoto",
      success: true,
      data: { webPath: "capacitor://other-photo" },
    })).resolves.toBe(false);
    await preferences.set({ key: "pending", value: JSON.stringify(persistedScope()) });
    await expect(queueRestoredCameraPhoto({
      pluginId: "Camera",
      methodName: "takePhoto",
      success: true,
      data: { webPath: "capacitor://restored-photo", metadata: { format: "jpeg" } },
    })).resolves.toBe(true);

    const result = await createCapacitorNativeCapabilities().getPhoto(captureScope());

    expect(result?.file).toBeInstanceOf(File);
    expect(result?.mimeType).toBe("image/jpeg");
    expect(camera.takePhoto).not.toHaveBeenCalled();
  });

  it("requires explicit adoption before stale attempt A can satisfy later attempt B for the same claim", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      blob: async () => new Blob(["attempt-a"], { type: "image/jpeg" }),
    })));
    await preferences.set({ key: "pending", value: JSON.stringify(persistedScope("attempt-a")) });
    await queueRestoredCameraPhoto({
      pluginId: "Camera",
      methodName: "takePhoto",
      success: true,
      data: { webPath: "capacitor://attempt-a", metadata: { format: "jpeg" } },
    });

    await expect(createCapacitorNativeCapabilities().getPhoto(captureScope("attempt-b"))).rejects.toMatchObject({
      name: "RestoredPhotoAwaitingAdoptionError",
      captureAttemptId: "attempt-a",
    });
    expect(camera.takePhoto).not.toHaveBeenCalled();

    await expect(createCapacitorNativeCapabilities().getPhoto(captureScope("attempt-a"))).resolves.toMatchObject({ mimeType: "image/jpeg" });
    expect(fetch).toHaveBeenCalledWith("capacitor://attempt-a");
  });

  it("expires an old restored attempt instead of attaching it to a later camera flow", async () => {
    camera.takePhoto.mockResolvedValue({ webPath: "capacitor://fresh-photo", metadata: { format: "jpeg" } });
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      blob: async () => new Blob(["fresh"], { type: "image/jpeg" }),
    })));
    await preferences.set({ key: "pending", value: JSON.stringify(persistedScope("attempt-a", "account:user-1", "bell-park", Date.now() - 31 * 60_000)) });

    await expect(queueRestoredCameraPhoto({
      pluginId: "Camera",
      methodName: "takePhoto",
      success: true,
      data: { webPath: "capacitor://expired-photo", metadata: { format: "jpeg" } },
    })).resolves.toBe(false);
    await expect(createCapacitorNativeCapabilities().getPhoto(captureScope("attempt-b"))).resolves.toMatchObject({ mimeType: "image/jpeg" });
    expect(camera.takePhoto).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledWith("capacitor://fresh-photo");
  });

  it("does not attach a restored photo to another park or owner and still resumes the intended flow", async () => {
    camera.takePhoto.mockResolvedValue({ webPath: "capacitor://fresh-photo", metadata: { format: "jpeg" } });
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      blob: async () => new Blob(["fresh"], { type: "image/jpeg" }),
    })));
    await preferences.set({ key: "pending", value: JSON.stringify(persistedScope()) });
    await queueRestoredCameraPhoto({
      pluginId: "Camera",
      methodName: "takePhoto",
      success: true,
      data: { webPath: "capacitor://previous-owner-photo", metadata: { format: "jpeg" } },
    });

    await createCapacitorNativeCapabilities().getPhoto(captureScope("other-place-attempt", "account:user-1", "other-park"));
    await createCapacitorNativeCapabilities().getPhoto(captureScope("other-owner-attempt", "account:user-2"));
    const restored = await createCapacitorNativeCapabilities().getPhoto(captureScope());

    expect(camera.takePhoto).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenNthCalledWith(1, "capacitor://fresh-photo");
    expect(fetch).toHaveBeenNthCalledWith(2, "capacitor://fresh-photo");
    expect(fetch).toHaveBeenNthCalledWith(3, "capacitor://previous-owner-photo");
    expect(await restored?.file.text()).toBe("fresh");
  });

  it("retains a restored photo while the same account session is adopted and clears it for another owner", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      blob: async () => new Blob(["restored"], { type: "image/jpeg" }),
    })));
    await preferences.set({ key: "pending", value: JSON.stringify(persistedScope()) });
    await queueRestoredCameraPhoto({
      pluginId: "Camera",
      methodName: "takePhoto",
      success: true,
      data: { webPath: "capacitor://restored-photo", metadata: { format: "jpeg" } },
    });

    await clearRestoredCameraPhoto("account:user-1");
    await expect(createCapacitorNativeCapabilities().getPhoto(captureScope())).resolves.toMatchObject({ mimeType: "image/jpeg" });

    await preferences.set({ key: "pending", value: JSON.stringify(persistedScope()) });
    await queueRestoredCameraPhoto({
      pluginId: "Camera",
      methodName: "takePhoto",
      success: true,
      data: { webPath: "capacitor://discarded-photo", metadata: { format: "jpeg" } },
    });
    await clearRestoredCameraPhoto("account:user-2");
    camera.takePhoto.mockRejectedValue({ code: "OS-PLUG-CAMR-0006" });
    await expect(createCapacitorNativeCapabilities().getPhoto(captureScope())).resolves.toBeNull();
  });

  it("ignores cancelled or malformed restored results and opens a fresh camera request", async () => {
    camera.takePhoto.mockResolvedValue({ webPath: "capacitor://fresh-photo", metadata: { format: "jpeg" } });
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      blob: async () => new Blob(["fresh"], { type: "image/jpeg" }),
    })));

    await expect(queueRestoredCameraPhoto({
      pluginId: "Camera",
      methodName: "takePhoto",
      success: false,
      data: { webPath: "capacitor://cancelled-photo" },
    })).resolves.toBe(false);
    await expect(queueRestoredCameraPhoto({
      pluginId: "Camera",
      methodName: "takePhoto",
      success: true,
      data: {},
    })).resolves.toBe(false);

    await expect(createCapacitorNativeCapabilities().getPhoto(captureScope())).resolves.toMatchObject({
      mimeType: "image/jpeg",
    });
    expect(camera.takePhoto).toHaveBeenCalledOnce();
  });
});
