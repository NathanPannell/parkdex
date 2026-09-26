import { App } from "@capacitor/app";
import { Capacitor } from "@capacitor/core";
import { Directory, Filesystem } from "@capacitor/filesystem";
import { Geolocation, type Position } from "@capacitor/geolocation";
import { Haptics, ImpactStyle } from "@capacitor/haptics";
import { Share } from "@capacitor/share";
import type { LngLat } from "./geo";

export const isNative = Capacitor.isNativePlatform();
// Field builds are for real park visits: no demo location, teleports or simulated trips.
export const FIELD = import.meta.env.VITE_FIELD === "1";

export type Fix = { point: LngLat; accuracy: number };

const toFix = (p: Position | GeolocationPosition): Fix => ({
  point: [p.coords.longitude, p.coords.latitude],
  accuracy: p.coords.accuracy ?? 50,
});

// Continuous high-accuracy tracking so arrival fires as the visitor walks in.
export async function watchLocation(onFix: (fix: Fix) => void, onError: (message: string) => void) {
  // Android uses "interval" for update cadence; without it updates arrive only every 20s.
  const options = { enableHighAccuracy: true, maximumAge: 3000, timeout: 20000, interval: 2000, minimumUpdateInterval: 1000 };
  if (isNative) {
    try {
      const status = await Geolocation.requestPermissions({ permissions: ["location"] });
      if (status.location === "denied") {
        onError("denied");
        return () => {};
      }
      const id = await Geolocation.watchPosition(options, (pos, err) => {
        if (pos) onFix(toFix(pos));
        else if (err) onError(String(err.message ?? err));
      });
      return () => void Geolocation.clearWatch({ id });
    } catch (e) {
      onError(String((e as Error).message ?? e));
      return () => {};
    }
  }
  if (!navigator.geolocation) {
    onError("unavailable");
    return () => {};
  }
  const id = navigator.geolocation.watchPosition(
    (pos) => onFix(toFix(pos)),
    (err) => onError(err.code === err.PERMISSION_DENIED ? "denied" : err.message),
    options,
  );
  return () => navigator.geolocation.clearWatch(id);
}

export function haptic(pattern: number | number[]) {
  if (!isNative) {
    try {
      navigator.vibrate?.(pattern);
    } catch {
      // Desktop browsers ignore vibration.
    }
    return;
  }
  const steps = Array.isArray(pattern) ? pattern.filter((_, i) => i % 2 === 0) : [pattern];
  steps.forEach((ms, i) => {
    const style = ms >= 60 ? ImpactStyle.Heavy : ms >= 20 ? ImpactStyle.Medium : ImpactStyle.Light;
    setTimeout(() => void Haptics.impact({ style }).catch(() => {}), i * 90);
  });
}

async function blobToBase64(blob: Blob) {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = "";
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(bin);
}

// Native share sheet with the story image attached (Instagram, Messages, Photos, Drive...).
export async function shareImage(blob: Blob, fileName: string, text: string) {
  if (isNative) {
    const written = await Filesystem.writeFile({ path: fileName, data: await blobToBase64(blob), directory: Directory.Cache });
    await Share.share({ title: text, text, files: [written.uri], dialogTitle: "Share your badge" });
    return "shared" as const;
  }
  const file = new File([blob], fileName, { type: blob.type });
  if (navigator.canShare?.({ files: [file] })) {
    await navigator.share({ files: [file], title: text, text });
    return "shared" as const;
  }
  return "unsupported" as const;
}

export function onBackButton(handler: () => void) {
  if (!isNative) return () => {};
  const sub = App.addListener("backButton", handler);
  return () => void sub.then((s) => s.remove());
}

export const minimizeApp = () => void App.minimizeApp().catch(() => {});
