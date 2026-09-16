import { Camera, CameraDirection, type MediaResult } from "@capacitor/camera";
import { Geolocation } from "@capacitor/geolocation";
import { Directory, Encoding, Filesystem } from "@capacitor/filesystem";

import {
  LocationCapabilityError,
  type NativeCapabilities,
  type PhotoAsset,
} from "./native-capabilities";
import { createNativePhotoRetryStore } from "./photo-retry";

type PluginError = { code?: unknown; message?: unknown };

function pluginError(error: unknown): PluginError {
  return typeof error === "object" && error !== null ? error as PluginError : {};
}

/** Convert Capacitor's platform-specific location failures into the shared UI vocabulary. */
function locationError(error: unknown): LocationCapabilityError {
  const { code, message } = pluginError(error);
  if (
    code === "OS-PLUG-GLOC-0003" ||
    code === "OS-PLUG-GLOC-0009" ||
    code === "OS-PLUG-GLOC-0018" ||
    code === 1 ||
    code === "PERMISSION_DENIED"
  ) {
    return new LocationCapabilityError("permission-denied", "Location permission was denied.");
  }
  if (
    code === "OS-PLUG-GLOC-0010" ||
    code === "OS-PLUG-GLOC-0011" ||
    code === 3 ||
    code === "TIMEOUT"
  ) {
    return new LocationCapabilityError("timeout", "Could not get your location in time.");
  }
  return new LocationCapabilityError(
    "unavailable",
    typeof message === "string" && message ? message : "Location is unavailable.",
  );
}

function extensionFor(mimeType: string, format?: string) {
  const normalizedMime = mimeType.toLowerCase().split(";", 1)[0];
  if (normalizedMime === "image/jpeg" || normalizedMime === "image/jpg") return "jpg";
  if (normalizedMime === "image/png") return "png";
  const normalizedFormat = format?.toLowerCase();
  if (normalizedFormat === "jpeg" || normalizedFormat === "jpg") return "jpg";
  if (normalizedFormat === "png") return "png";
  return "image";
}

function mimeTypeFor(blob: Blob, photo: MediaResult) {
  const blobType = blob.type.toLowerCase().split(";", 1)[0];
  if (blobType) return blobType;
  const format = photo.metadata?.format?.toLowerCase();
  if (format === "jpg" || format === "jpeg") return "image/jpeg";
  if (format === "png") return "image/png";
  return "image/jpeg";
}

async function photoAsset(photo: MediaResult): Promise<PhotoAsset> {
  if (!photo.webPath) throw new Error("The camera did not return a readable photo.");
  const response = await fetch(photo.webPath);
  if (!response.ok) throw new Error("The captured photo could not be read.");
  const blob = await response.blob();
  const mimeType = mimeTypeFor(blob, photo);
  const file = new File([blob], `parkdex-visit-${Date.now()}.${extensionFor(mimeType, photo.metadata?.format)}`, {
    type: mimeType,
  });
  return { file, mimeType };
}

function hasLocationPermission(permission: { location?: string; coarseLocation?: string }) {
  // Android 12+ can grant approximate location while `location` remains denied.
  return permission.location === "granted" || permission.coarseLocation === "granted";
}

function isMediaResult(value: unknown): value is MediaResult {
  return typeof value === "object" && value !== null
    && typeof (value as { webPath?: unknown }).webPath === "string";
}

/** The result shape emitted by Capacitor App when an external Activity was restored. */
export type RestoredCameraResult = {
  pluginId: string;
  methodName: string;
  success: boolean;
  data?: unknown;
};

let restoredPhoto: MediaResult | undefined;

/** Queue a successful Camera result delivered after Android killed the WebView process. */
export function queueRestoredCameraPhoto(result: RestoredCameraResult): boolean {
  if (
    restoredPhoto ||
    result.pluginId !== "Camera" ||
    !["getPhoto", "takePhoto"].includes(result.methodName) ||
    !result.success ||
    !isMediaResult(result.data)
  ) return false;
  restoredPhoto = result.data;
  return true;
}

/** Clear an unclaimed restored result when the active journal owner changes. */
export function clearRestoredCameraPhoto() {
  restoredPhoto = undefined;
}

export function createCapacitorNativeCapabilities(): NativeCapabilities {
  return {
    async getCurrentLocation(options) {
      try {
        const currentPermission = await Geolocation.checkPermissions();
        // Android may retain only the coarse grant. Ask for the precise `location`
        // grant before sampling because boundary claims require GPS-level accuracy.
        const permission = currentPermission.location === "granted"
          ? currentPermission
          : await Geolocation.requestPermissions({ permissions: ["location"] });
        if (!hasLocationPermission(permission)) {
          throw new LocationCapabilityError("permission-denied", "Location permission was denied.");
        }
        const position = await Geolocation.getCurrentPosition({
          // Do not ask Android for precise GPS when the user granted approximate only.
          enableHighAccuracy: options.highAccuracy && permission.location === "granted",
          timeout: options.timeoutMs,
          maximumAge: options.maxAgeMs,
        });
        return {
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          accuracyMeters: position.coords.accuracy,
          capturedAtEpochMs: position.timestamp,
        };
      } catch (error) {
        if (error instanceof LocationCapabilityError) throw error;
        throw locationError(error);
      }
    },

    async getPhoto() {
      try {
        if (restoredPhoto) {
          const pendingPhoto = restoredPhoto;
          restoredPhoto = undefined;
          return await photoAsset(pendingPhoto);
        }

        const photo = await Camera.takePhoto({
          cameraDirection: CameraDirection.Rear,
          correctOrientation: true,
          editable: "no",
          // Do not retain EXIF/GPS metadata in the app-private retry copy.
          includeMetadata: false,
          quality: 85,
          // Visit photos are app input only; never request gallery persistence.
          saveToGallery: false,
          targetHeight: 2048,
          targetWidth: 2048,
        });
        return await photoAsset(photo);
      } catch (error) {
        // Capacitor's cancellation is a normal no-photo outcome, not an error state.
        if (pluginError(error).code === "OS-PLUG-CAMR-0006") return null;
        throw error;
      }
    },
    photoRetry: createNativePhotoRetryStore(Filesystem, Directory.Data, Encoding.UTF8),
  };
}
