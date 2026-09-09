import { Camera, CameraDirection } from "@capacitor/camera";
import { Geolocation } from "@capacitor/geolocation";

import { LocationCapabilityError, type NativeCapabilities } from "./native-capabilities";

type PluginError = { code?: string; message?: string };

function locationError(error: unknown): LocationCapabilityError {
  const pluginError = error as PluginError;
  if (pluginError.code === "OS-PLUG-GLOC-0003" || pluginError.code === "OS-PLUG-GLOC-0009") {
    return new LocationCapabilityError("permission-denied", "Location permission was denied.");
  }
  if (pluginError.code === "OS-PLUG-GLOC-0010") {
    return new LocationCapabilityError("timeout", "Could not get your location in time.");
  }
  return new LocationCapabilityError("unavailable", pluginError.message ?? "Location is unavailable.");
}

function extensionFor(mimeType: string) {
  if (mimeType === "image/jpeg") return "jpg";
  if (mimeType === "image/png") return "png";
  return "image";
}

export function createCapacitorNativeCapabilities(): NativeCapabilities {
  return {
    async getCurrentLocation(options) {
      try {
        const currentPermission = await Geolocation.checkPermissions();
        const permission = currentPermission.location === "granted"
          ? currentPermission
          : await Geolocation.requestPermissions({ permissions: ["location"] });
        if (permission.location !== "granted") {
          throw new LocationCapabilityError("permission-denied", "Location permission was denied.");
        }
        const position = await Geolocation.getCurrentPosition({
          enableHighAccuracy: options.highAccuracy,
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
        const photo = await Camera.takePhoto({
          cameraDirection: CameraDirection.Rear,
          correctOrientation: true,
          includeMetadata: true,
          quality: 85,
          saveToGallery: false,
          targetHeight: 2048,
          targetWidth: 2048,
        });
        if (!photo.webPath) throw new Error("The camera did not return a readable photo.");
        const response = await fetch(photo.webPath);
        if (!response.ok) throw new Error("The captured photo could not be read.");
        const blob = await response.blob();
        const mimeType = blob.type || `image/${photo.metadata?.format || "jpeg"}`;
        const file = new File([blob], `parkdex-visit-${Date.now()}.${extensionFor(mimeType)}`, {
          type: mimeType,
        });
        return { file, mimeType };
      } catch (error) {
        if ((error as PluginError).code === "OS-PLUG-CAMR-0006") return null;
        throw error;
      }
    },
  };
}
