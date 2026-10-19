import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { Icon } from "./Icon";
import { Kip } from "./Kip";
import { PhotoCropper } from "./PhotoCropper";
import { buzz, sfx } from "../lib/feedback";
import { useBackHandler } from "../lib/backStack";
import { takeNativePhoto, useLiveCamera, type Facing } from "../lib/camera";
import { captureMode, currentCaptureEnv, openBrowserCamera, takeStartedCapture, usesCameraApp } from "../lib/captureMode";
import { CROP_ASPECT, type PhotoCrop } from "../lib/photoCrop";
import { encodePhoto, originalFromBlob, originalFromDataUrl, prepareOriginal, type CapturedPhoto, type Drawable, type OriginalPhoto } from "../lib/photoEncode";

type Props = {
  /** Shown in the chip at the top, such as "Inside Paterson Park". */
  place: string;
  hint: string;
  caption: string;
  onUse: (photo: CapturedPhoto) => void;
  onClose: () => void;
  /** The crop's width over height: 3:4 for the Dex, `PARK_COVER_ASPECT` for a founder's cover. */
  aspect?: number;
};

type Taken = { id: number; photo: OriginalPhoto; drawable: Drawable };

/** JPEG quality asked of the camera plugin; the app re-encodes the photo itself afterwards. */
const NATIVE_QUALITY = 92;

/**
 * Takes one real photo, then lets the player crop it to `aspect`, 3:4 by default (#173). On a
 * phone the phone's own camera app takes it, straight away, so the photo gets the phone's own
 * processing: the Android build through the camera plugin, a phone browser through a file input
 * with `capture` that the opening tap started (`startPhotoCapture`). Backing out of the camera app
 * returns to the previous screen. A desktop browser shows a live preview, or its file chooser
 * without a camera (`lib/captureMode.ts`). The photo is kept as an upright original with the crop
 * beside it, and the cropped image is encoded for upload (see `lib/photoEncode.ts`).
 */
export function PhotoCapture({ place, hint, caption, onUse, onClose, aspect = CROP_ASPECT }: Props) {
  const [mode] = useState(() => captureMode(currentCaptureEnv()));
  const cameraApp = usesCameraApp(mode);
  const [facing, setFacing] = useState<Facing>("environment");
  const { video, live } = useLiveCamera(facing, 1920, mode === "live-preview");
  const [taken, setTaken] = useState<Taken | null>(null);
  const [flash, setFlash] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const shots = useRef(0);
  const requests = useRef(0);
  const mounted = useRef(true);
  const takenRef = useRef(taken);
  takenRef.current = taken;
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  // Back from the crop: with a live preview it returns to the preview; on a phone the camera app was
  // the step before, so back leaves the capture instead of reopening it.
  useBackHandler(() => (cameraApp ? onClose() : setTaken(null)), !!taken);

  async function prepare(work: () => Promise<{ photo: OriginalPhoto; drawable: Drawable } | null> | { photo: OriginalPhoto; drawable: Drawable } | null) {
    setBusy(true);
    setError(null);
    try {
      const prepared = await work();
      if (prepared && mounted.current) {
        shots.current += 1;
        setTaken({ id: shots.current, ...prepared });
      }
    } catch (caught) {
      if (mounted.current) setError(caught instanceof Error && caught.message ? caught.message : "This photo could not be used. Try again.");
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  /** Opens the phone's camera app. Backing out of it returns to whatever was showing before. */
  function openNativeCamera() {
    void prepare(async () => {
      let shot;
      try {
        shot = await takeNativePhoto({ quality: NATIVE_QUALITY });
      } catch {
        throw new Error("Your camera couldn't open. Check that Parkdex can use the camera, then try again.");
      }
      if (shot.kind === "cancelled") {
        // From the first shot, back leaves the capture. From a retake, the earlier photo stays.
        if (!takenRef.current && mounted.current) closeRef.current();
        return null;
      }
      return originalFromDataUrl(shot.dataUrl);
    });
  }

  /**
   * Waits for a photo from the browser's camera capture. With `leaveOnCancel`, backing out of the
   * camera leaves the capture, back to the previous screen. Backing out of a retake returns to
   * this screen, whose close button leaves: the web has no back button to leave the crop with.
   * Only the latest capture counts, so a shutter tap after a camera that never reported back
   * replaces it.
   */
  function receiveBrowserPhoto(shot: Promise<File | null>, leaveOnCancel: boolean) {
    const request = (requests.current += 1);
    void shot.then((file) => {
      if (request !== requests.current || !mounted.current) return;
      if (file) void prepare(() => originalFromBlob(file));
      else if (leaveOnCancel) closeRef.current();
      else setTaken(null);
    });
  }

  const opened = useRef(false);
  useEffect(() => {
    mounted.current = true;
    // Once per capture, even when a development build mounts effects twice.
    if (!opened.current) {
      opened.current = true;
      if (mode === "native-camera") openNativeCamera();
      else if (mode === "browser-camera") {
        // The tap that opened this screen opened the camera too. Without it, the shutter does.
        const started = takeStartedCapture();
        if (started) receiveBrowserPhoto(started, true);
      }
    }
    return () => {
      mounted.current = false;
    };
  }, []);

  const shoot = () => {
    if (busy) return;
    const v = video.current;
    if (live === "on" && v && v.videoWidth) {
      sfx.shutter();
      buzz(20);
      setFlash((value) => value + 1);
      void prepare(() => prepareOriginal({ source: v, width: v.videoWidth, height: v.videoHeight }, { mirror: facing === "user" }));
    } else if (mode === "native-camera") {
      openNativeCamera();
    } else {
      // Inside the tap, which the browser requires. A desktop without a camera shows its file chooser.
      receiveBrowserPhoto(openBrowserCamera(), mode === "browser-camera");
    }
  };

  const retake = () => {
    if (busy) return;
    sfx.tap();
    if (mode === "native-camera") openNativeCamera();
    else if (mode === "browser-camera") receiveBrowserPhoto(openBrowserCamera(), false);
    else setTaken(null);
  };

  const use = (crop: PhotoCrop) => {
    if (!taken || busy) return;
    try {
      const cropped = encodePhoto(taken.drawable, { crop, aspect });
      sfx.pop();
      onUse({ original: taken.photo, crop, cropped });
    } catch (caught) {
      setError(caught instanceof Error && caught.message ? caught.message : "This photo could not be used. Try again.");
    }
  };

  return (
    <motion.div
      className="screen camera found-camera"
      initial={{ clipPath: "circle(0% at 50% 92%)" }}
      animate={{ clipPath: "circle(150% at 50% 92%)" }}
      exit={{ opacity: 0, transition: { duration: 0.3 } }}
      transition={{ duration: 0.7, ease: [0.7, 0, 0.2, 1] }}
    >
      {/* On a phone the camera app is the viewfinder; this screen only waits behind it. */}
      {!cameraApp && (
        <div className="camera__feed">
          <video ref={video} playsInline muted className={facing === "user" ? "mirror" : ""} style={{ opacity: live === "on" ? 1 : 0 }} />
          <div className="camera__grid" />
        </div>
      )}

      <div className="camera__top">
        <button className="camera__round" onClick={onClose} aria-label="Close camera">
          <Icon name="close" size={20} stroke={2.8} />
        </button>
        <motion.div className="camera__geo" initial={{ y: -30, opacity: 0 }} animate={{ y: 0, opacity: 1 }} transition={{ delay: 0.5, type: "spring" }}>
          <span className="camera__geo-dot" /> {place}
        </motion.div>
        <button
          className="camera__round"
          onClick={() => setFacing((f) => (f === "user" ? "environment" : "user"))}
          aria-label="Flip camera"
          disabled={live !== "on"}
          style={cameraApp ? { visibility: "hidden" } : undefined}
        >
          <Icon name="flip" size={20} />
        </button>
      </div>

      {!cameraApp && (
        <div className={`camera__frame${aspect > 1 ? " camera__frame--landscape" : ""}`} style={aspect > 1 ? { aspectRatio: String(aspect) } : undefined}>
          {["tl", "tr", "bl", "br"].map((c) => (
            <motion.span key={c} className={`corner corner--${c}`} animate={{ scale: [1, 1.08, 1] }} transition={{ duration: 1.8, repeat: Infinity }} />
          ))}
        </div>
      )}

      {live === "off" && !taken && (mode === "native-camera" || !busy) && (
        <motion.div className="camera__note" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.4 }}>
          {busy ? "Opening your camera…" : "Tap the shutter to open your camera"}
        </motion.div>
      )}

      <div className="camera__bottom">
        <div className="camera__hint" role={error && !taken ? "alert" : undefined}>
          {(!taken && error) || (busy ? "Getting your photo ready…" : hint)}
        </div>
        <div className="camera__controls">
          <motion.button className="shutter" onClick={shoot} disabled={busy} whileTap={{ scale: 0.86 }} aria-label="Take photo">
            <span />
          </motion.button>
          <motion.div className="camera__kip" initial={{ x: 120 }} animate={{ x: 0 }} transition={{ delay: 0.9, type: "spring", stiffness: 200, damping: 16 }}>
            <Kip pose="camera" size={78} flip />
          </motion.div>
        </div>
      </div>

      <AnimatePresence>
        {flash > 0 && <motion.div key={flash} className="camera__flash" initial={{ opacity: 1 }} animate={{ opacity: 0 }} transition={{ duration: 0.5 }} />}
      </AnimatePresence>

      <AnimatePresence>
        {taken && <PhotoCropper key={taken.id} photo={taken.photo} caption={caption} busy={busy} error={error} onRetake={retake} onUse={use} aspect={aspect} />}
      </AnimatePresence>
    </motion.div>
  );
}
