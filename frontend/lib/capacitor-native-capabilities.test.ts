// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";

const camera = vi.hoisted(() => ({ takePhoto: vi.fn() }));
const geolocation = vi.hoisted(() => ({
  checkPermissions: vi.fn(),
  getCurrentPosition: vi.fn(),
  requestPermissions: vi.fn(),
}));

vi.mock("@capacitor/camera", () => ({ Camera: camera, CameraDirection: { Rear: "REAR" } }));
vi.mock("@capacitor/geolocation", () => ({ Geolocation: geolocation }));

import {
  createCapacitorNativeCapabilities,
} from "./capacitor-native-capabilities";
import { type LocationCapabilityError } from "./native-capabilities";

beforeEach(() => {
  vi.restoreAllMocks();
  camera.takePhoto.mockReset();
  geolocation.checkPermissions.mockReset();
  geolocation.getCurrentPosition.mockReset();
  geolocation.requestPermissions.mockReset();
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

  it("normalizes native permission and timeout failures", async () => {
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

  it("returns an uploadable File and treats camera cancellation as no selection", async () => {
    camera.takePhoto.mockResolvedValue({ webPath: "capacitor://photo", metadata: { format: "jpeg" } });
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      blob: async () => new Blob(["photo"], { type: "image/jpeg" }),
    })));

    const result = await createCapacitorNativeCapabilities().getPhoto();

    expect(result?.mimeType).toBe("image/jpeg");
    expect(result?.file).toBeInstanceOf(File);
    expect(result?.file.name).toMatch(/\.jpg$/);

    camera.takePhoto.mockRejectedValue({ code: "OS-PLUG-CAMR-0006" });
    await expect(createCapacitorNativeCapabilities().getPhoto()).resolves.toBeNull();
  });
});
