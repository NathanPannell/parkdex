import { Camera as NativeCamera, CameraResultType, CameraSource } from "@capacitor/camera";
import { useEffect, useRef, useState, type RefObject } from "react";

export type LiveCamera = "pending" | "on" | "off";
export type Facing = "environment" | "user";

/**
 * A live camera preview in a video element, or "off" when there is none: no camera, denied
 * permission, or a stream that never delivers frames.
 */
export function useLiveCamera(facing: Facing, idealWidth = 1280): { video: RefObject<HTMLVideoElement | null>; live: LiveCamera } {
  const video = useRef<HTMLVideoElement>(null);
  const [live, setLive] = useState<LiveCamera>("pending");

  useEffect(() => {
    let stream: MediaStream | null = null;
    let cancelled = false;
    setLive("pending");
    navigator.mediaDevices
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
      .catch(() => setLive("off")) ?? setLive("off");
    // Some devices grant a stream that never delivers frames; treat that as no preview.
    const watchdog = setTimeout(() => {
      if (!cancelled && !video.current?.videoWidth) setLive("off");
    }, 6000);
    return () => {
      clearTimeout(watchdog);
      cancelled = true;
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [facing, idealWidth]);

  return { video, live };
}

/** Hands off to the phone's own camera app. Null when the player backs out. */
export async function takeNativePhoto(options: { width: number; quality: number }): Promise<string | null> {
  try {
    const shot = await NativeCamera.getPhoto({
      source: CameraSource.Camera,
      resultType: CameraResultType.DataUrl,
      quality: options.quality,
      width: options.width,
      correctOrientation: true,
    });
    return shot.dataUrl ?? null;
  } catch {
    return null;
  }
}
