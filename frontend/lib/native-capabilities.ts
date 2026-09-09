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

export type PhotoAsset = {
  file: File;
  mimeType: string;
};

export type NativeCapabilities = {
  getCurrentLocation(options: {
    highAccuracy: true;
    timeoutMs: number;
    maxAgeMs: number;
  }): Promise<LocationSample>;
  getPhoto(): Promise<PhotoAsset | null>;
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
  getPhoto: browserPhoto,
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
