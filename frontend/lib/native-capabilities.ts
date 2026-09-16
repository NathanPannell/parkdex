import { createBrowserPhotoRetryStore, type PhotoRetryStore } from "./photo-retry";

export type LocationErrorCode = "permission-denied" | "unavailable" | "timeout";

export class LocationCapabilityError extends Error {
  constructor(readonly code: LocationErrorCode, message: string) {
    super(message);
    this.name = "LocationCapabilityError";
  }
}

export type LocationSample = {
  latitude: number;
  longitude: number;
  accuracyMeters: number;
  capturedAtEpochMs: number;
};

export type LocationRequestOptions = {
  highAccuracy: true;
  timeoutMs: number;
  maxAgeMs: number;
};

export type LocationWatchOptions = LocationRequestOptions & {
  /** Preferred cadence while the app is open. Native GPS may report sooner. */
  updateIntervalMs: number;
  /** Do not emit native samples more frequently than this interval. */
  minimumUpdateIntervalMs?: number;
};

export type StopLocationWatch = () => void;

/** NativeRuntime mirrors Capacitor App lifecycle changes through this DOM event. */
export const NATIVE_APP_STATE_EVENT = "parkdex:native-app-state";
let nativeAppActive = true;

export function publishNativeAppState(isActive: boolean) {
  nativeAppActive = isActive;
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(NATIVE_APP_STATE_EVENT, { detail: { isActive } }));
  }
}

export function currentNativeAppState() {
  return nativeAppActive;
}

export const FOREGROUND_LOCATION_WATCH_OPTIONS: LocationWatchOptions = {
  highAccuracy: true,
  timeoutMs: 30_000,
  maxAgeMs: 5_000,
  updateIntervalMs: 5_000,
  minimumUpdateIntervalMs: 2_000,
};

export type PhotoAsset = {
  file: File;
  mimeType: string;
};

export type NativeCapabilities = {
  getCurrentLocation(options: LocationRequestOptions): Promise<LocationSample>;
  /** Foreground-only location updates. The returned function immediately stops the watch. */
  watchLocation?(
    options: LocationWatchOptions,
    onLocation: (location: LocationSample) => void,
    onError?: (error: LocationCapabilityError) => void,
  ): StopLocationWatch;
  getPhoto(): Promise<PhotoAsset | null>;
  /** App-private binary storage for a photo whose upload needs a later retry. */
  photoRetry?: PhotoRetryStore;
  openExternalAuth?(url: string): Promise<void>;
};

function browserLocationError(error: GeolocationPositionError): LocationCapabilityError {
  if (error.code === error.PERMISSION_DENIED) {
    return new LocationCapabilityError("permission-denied", "Location permission was denied.");
  }
  if (error.code === error.TIMEOUT) {
    return new LocationCapabilityError("timeout", "Could not get your location in time.");
  }
  return new LocationCapabilityError("unavailable", "Location is unavailable.");
}

function browserPhoto(): Promise<PhotoAsset | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.capture = "environment";

    let settled = false;
    const finish = (photo: PhotoAsset | null) => {
      if (settled) return;
      settled = true;
      window.removeEventListener("focus", handleFocus);
      resolve(photo);
    };
    const handleFocus = () => {
      window.setTimeout(() => {
        const file = input.files?.[0];
        finish(file ? { file, mimeType: file.type || "application/octet-stream" } : null);
      });
    };

    input.addEventListener("change", () => {
      const file = input.files?.[0];
      finish(file ? { file, mimeType: file.type || "application/octet-stream" } : null);
    }, { once: true });
    input.addEventListener("cancel", () => finish(null), { once: true });
    window.addEventListener("focus", handleFocus, { once: true });
    input.click();
  });
}

function pollLocation(
  provider: Pick<NativeCapabilities, "getCurrentLocation">,
  options: LocationWatchOptions,
  onLocation: (location: LocationSample) => void,
  onError?: (error: LocationCapabilityError) => void,
): StopLocationWatch {
  let active = true;
  let nextPoll: ReturnType<typeof setTimeout> | undefined;
  const poll = async () => {
    try {
      const location = await provider.getCurrentLocation(options);
      if (active) onLocation(location);
    } catch (error) {
      if (active) {
        onError?.(error instanceof LocationCapabilityError
          ? error
          : new LocationCapabilityError("unavailable", "Location is unavailable."));
      }
    } finally {
      if (active) nextPoll = setTimeout(poll, Math.min(options.updateIntervalMs, 30_000));
    }
  };
  void poll();
  return () => {
    active = false;
    if (nextPoll !== undefined) clearTimeout(nextPoll);
  };
}

const browserCapabilities: NativeCapabilities = {
  getCurrentLocation(options) {
    if (!navigator.geolocation) {
      return Promise.reject(new LocationCapabilityError("unavailable", "Location is unavailable."));
    }
    return new Promise((resolve, reject) => {
      navigator.geolocation.getCurrentPosition(
        ({ coords, timestamp }) => resolve({
          latitude: coords.latitude,
          longitude: coords.longitude,
          accuracyMeters: coords.accuracy,
          capturedAtEpochMs: timestamp,
        }),
        (error) => reject(browserLocationError(error)),
        {
          enableHighAccuracy: options.highAccuracy,
          timeout: options.timeoutMs,
          maximumAge: options.maxAgeMs,
        },
      );
    });
  },
  watchLocation(options, onLocation, onError) {
    if (!navigator.geolocation) {
      onError?.(new LocationCapabilityError("unavailable", "Location is unavailable."));
      return () => undefined;
    }
    if (typeof navigator.geolocation.watchPosition !== "function") {
      return pollLocation(browserCapabilities, options, onLocation, onError);
    }
    const watchId = navigator.geolocation.watchPosition(
      ({ coords, timestamp }) => onLocation({
        latitude: coords.latitude,
        longitude: coords.longitude,
        accuracyMeters: coords.accuracy,
        capturedAtEpochMs: timestamp,
      }),
      (error) => onError?.(browserLocationError(error)),
      {
        enableHighAccuracy: options.highAccuracy,
        timeout: options.timeoutMs,
        maximumAge: options.maxAgeMs,
      },
    );
    return () => navigator.geolocation.clearWatch(watchId);
  },
  getPhoto: browserPhoto,
  photoRetry: createBrowserPhotoRetryStore(),
};

let activeCapabilities = browserCapabilities;

export function getNativeCapabilities(): NativeCapabilities {
  return activeCapabilities;
}

export function registerNativeCapabilities(provider: NativeCapabilities): () => void {
  activeCapabilities = provider;
  return () => {
    if (activeCapabilities === provider) activeCapabilities = browserCapabilities;
  };
}

/**
 * Start foreground updates using the active platform provider. Older injected
 * providers fall back to a bounded poll so existing test and embed integrations
 * retain the same contract.
 */
export function watchCurrentLocation(
  options: LocationWatchOptions,
  onLocation: (location: LocationSample) => void,
  onError?: (error: LocationCapabilityError) => void,
): StopLocationWatch {
  if (activeCapabilities.watchLocation) {
    return activeCapabilities.watchLocation(options, onLocation, onError);
  }
  return pollLocation(activeCapabilities, options, onLocation, onError);
}

/** Remove all durable retry photos for an account owner (including on logout). */
export function clearPhotoRetryOwner(ownerKey: string | undefined): Promise<void> {
  if (!ownerKey || !activeCapabilities.photoRetry) return Promise.resolve();
  return activeCapabilities.photoRetry.clearOwner(ownerKey);
}
