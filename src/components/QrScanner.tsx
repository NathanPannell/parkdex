import { Camera as NativeCamera, CameraResultType, CameraSource } from "@capacitor/camera";
import { useEffect, useRef, useState } from "react";
import { Icon } from "./Icon";
import { isNative } from "../lib/native";

type Decode = (data: Uint8ClampedArray, width: number, height: number) => { data: string } | null;

let decoder: Promise<Decode> | null = null;
// jsQR is ~130 kB; load it only when someone opens the scanner.
function loadDecoder(): Promise<Decode> {
  decoder ??= import("jsqr").then((module) => (data, width, height) => module.default(data, width, height, { inversionAttempts: "dontInvert" }));
  return decoder;
}

function decodeCanvas(canvas: HTMLCanvasElement, source: CanvasImageSource, width: number, height: number, decode: Decode): string | null {
  // Scanning a smaller frame is much faster and still reads a phone-screen QR.
  const scale = Math.min(1, 640 / Math.max(width, height));
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return null;
  context.drawImage(source, 0, 0, canvas.width, canvas.height);
  const image = context.getImageData(0, 0, canvas.width, canvas.height);
  return decode(image.data, image.width, image.height)?.data ?? null;
}

/** Live QR scanning in the app's own camera view. Works offline. */
export function QrScanner({ onResult, onClose }: { onResult(text: string): void; onClose(): void }) {
  const video = useRef<HTMLVideoElement>(null);
  const canvas = useRef<HTMLCanvasElement>(document.createElement("canvas"));
  const [live, setLive] = useState<"pending" | "on" | "off">("pending");
  const [error, setError] = useState<string | null>(null);
  const done = useRef(false);

  const finish = (text: string) => {
    if (done.current) return;
    done.current = true;
    onResult(text);
  };

  useEffect(() => {
    let stream: MediaStream | null = null;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const tick = async () => {
      const decode = await loadDecoder();
      const frame = video.current;
      if (cancelled || done.current) return;
      if (frame && frame.videoWidth) {
        const text = decodeCanvas(canvas.current, frame, frame.videoWidth, frame.videoHeight, decode);
        if (text) return finish(text);
      }
      timer = setTimeout(() => void tick(), 200);
    };

    navigator.mediaDevices
      ?.getUserMedia({ video: { facingMode: "environment", width: { ideal: 1280 } }, audio: false })
      .then((s) => {
        if (cancelled) return s.getTracks().forEach((track) => track.stop());
        stream = s;
        if (video.current) {
          video.current.srcObject = s;
          void video.current.play();
        }
        setLive("on");
        void tick();
      })
      .catch(() => setLive("off")) ?? setLive("off");
    return () => {
      cancelled = true;
      clearTimeout(timer);
      stream?.getTracks().forEach((track) => track.stop());
    };
  }, []);

  // Without a live preview, a still photo from the phone's camera app works just as well.
  const scanPhoto = async () => {
    setError(null);
    try {
      const shot = await NativeCamera.getPhoto({ source: CameraSource.Camera, resultType: CameraResultType.DataUrl, quality: 80 });
      if (!shot.dataUrl) return;
      const image = new Image();
      image.src = shot.dataUrl;
      await image.decode();
      const text = decodeCanvas(canvas.current, image, image.naturalWidth, image.naturalHeight, await loadDecoder());
      if (text) finish(text);
      else setError("No QR code found in that photo. Try again a little closer.");
    } catch {
      setError("The camera didn't open. You can type the code instead.");
    }
  };

  return (
    <div className="qr-scanner" role="dialog" aria-modal="true" aria-label="Scan a friend's code">
      <video ref={video} className="qr-scanner__video" playsInline muted />
      <div className="qr-scanner__frame" aria-hidden="true" />
      <button className="btn btn--paper btn--icon qr-scanner__close" onClick={onClose} aria-label="Close scanner">
        <Icon name="close" size={20} />
      </button>
      <div className="qr-scanner__hint card">
        {live === "off" ? (
          <>
            <strong>The live camera isn't available</strong>
            <span>Take a photo of your friend's code instead.</span>
            {isNative && <button className="btn btn--sun btn--sm" onClick={() => void scanPhoto()}>Take a photo</button>}
          </>
        ) : (
          <span>Point at your friend's Parkdex code</span>
        )}
        {error && <span className="qr-scanner__error">{error}</span>}
      </div>
    </div>
  );
}
