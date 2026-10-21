import { Camera as NativeCamera, CameraResultType, CameraSource } from "@capacitor/camera";
import { useEffect, useRef, useState, type RefObject } from "react";

export type LiveCamera = "pending" | "on" | "off";
export type Facing = "environment" | "user";

/**
 * A live camera preview in a video element, or "off" when there is none: no camera, denied
 * permission, or a stream that never delivers frames.
 */
export function useLiveCamera(facing: Facing, idealWidth = 1280, enabled = true): { video: RefObject<HTMLVideoElement | null>; live: LiveCamera } {
  const video = useRef<HTMLVideoElement>(null);
  const [live, setLive] = useState<LiveCamera>(enabled ? "pending" : "off");

  useEffect(() => {
    if (!enabled) {
      setLive("off");
      return;
    }
    let stream: MediaStream | null = null;
    let cancelled = false;
    setLive("pending");
    const request = navigator.mediaDevices
      ?.getUserMedia({ video: { facingMode: facing, width: { ideal: idealWidth } }, audio: false })
      .then((s) => {
        if (cancelled) return s.getTracks().forEach((t) => t.stop());
        stream = s;
        if (video.current) {
          video.current.srcObject = s;
          void video.current.play();
        }
        setLive("on");
      })
      .catch(() => setLive("off"));
    // Without mediaDevices (an insecure origin or an old WebView) there is no preview at all.
    if (!request) setLive("off");
    // Some devices grant a stream that never delivers frames; treat that as no preview.
    const watchdog = setTimeout(() => {
      if (!cancelled && !video.current?.videoWidth) setLive("off");
    }, 6000);
    return () => {
      clearTimeout(watchdog);
      cancelled = true;
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [facing, idealWidth, enabled]);

  return { video, live };
}

/** What came back from the phone's camera app. */
export type NativeShot = { kind: "photo"; dataUrl: string } | { kind: "cancelled" };

// The Capacitor camera plugin's message when the player backs out of the camera app.
const CANCELLED = /cancel/i;

/**
 * Hands off to the phone's own camera app (never the gallery), so the photo gets the phone's own
 * processing. The photo comes back at full size and upright; the app scales it down itself,
 * because the plugin's resize skips filtering. Throws when the camera cannot open, for example
 * when permission is denied.
 */
export async function takeNativePhoto(options: { quality: number }): Promise<NativeShot> {
  try {
    const shot = await NativeCamera.getPhoto({
      source: CameraSource.Camera,
      resultType: CameraResultType.DataUrl,
      quality: options.quality,
      correctOrientation: true,
      saveToGallery: false,
    });
    return shot.dataUrl ? { kind: "photo", dataUrl: shot.dataUrl } : { kind: "cancelled" };
  } catch (error) {
    if (error instanceof Error && CANCELLED.test(error.message)) return { kind: "cancelled" };
    throw error;
  }
}
