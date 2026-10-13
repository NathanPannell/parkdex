import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { Icon } from "./Icon";
import { Kip } from "./Kip";
import { PhotoCropper } from "./PhotoCropper";
import { buzz, sfx } from "../lib/feedback";
import { useBackHandler } from "../lib/backStack";
import { takeNativePhoto, useLiveCamera, type Facing } from "../lib/camera";
import { isNative } from "../lib/native";
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
 * Takes one real photo, then lets the player crop it to `aspect`, 3:4 by default (#173). On
 * Android the phone's own camera app takes it, straight away and with no gallery; backing out of
 * the camera app returns to the previous screen. On the web a live preview is used when the
 * browser grants one, otherwise the browser's camera capture. The photo is kept as an upright
 * original with the crop beside it, and the cropped image is encoded for upload (see
 * `lib/photoEncode.ts`).
 */
export function PhotoCapture({ place, hint, caption, onUse, onClose, aspect = CROP_ASPECT }: Props) {
  const [facing, setFacing] = useState<Facing>("environment");
  const { video, live } = useLiveCamera(facing, 1920, !isNative);
  const [taken, setTaken] = useState<Taken | null>(null);
  const [flash, setFlash] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const shots = useRef(0);
  const mounted = useRef(true);
  const takenRef = useRef(taken);
  takenRef.current = taken;
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  // Back from the crop: on the web it returns to the camera; on Android the camera app was the
  // step before, so back leaves the capture instead of reopening it.
  useBackHandler(() => (isNative ? onClose() : setTaken(null)), !!taken);

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

  const opened = useRef(false);
  useEffect(() => {
    mounted.current = true;
    // Once per capture, even when a development build mounts effects twice.
    if (isNative && !opened.current) {
      opened.current = true;
      openNativeCamera();
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
    } else if (isNative) {
      openNativeCamera();
    } else {
      picker.current?.click();
    }
  };

  const retake = () => {
    if (busy) return;
    sfx.tap();
    if (isNative) openNativeCamera();
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

  const picked = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file) void prepare(() => originalFromBlob(file));
  };

  return (
    <motion.div
      className="screen camera found-camera"
      initial={{ clipPath: "circle(0% at 50% 92%)" }}
      animate={{ clipPath: "circle(150% at 50% 92%)" }}
      exit={{ opacity: 0, transition: { duration: 0.3 } }}
      transition={{ duration: 0.7, ease: [0.7, 0, 0.2, 1] }}
    >
      <div className="camera__feed">
        <video ref={video} playsInline muted className={facing === "user" ? "mirror" : ""} style={{ opacity: live === "on" ? 1 : 0 }} />
        <div className="camera__grid" />
      </div>

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
          style={isNative ? { visibility: "hidden" } : undefined}
        >
          <Icon name="flip" size={20} />
        </button>
      </div>

      <div className={`camera__frame${aspect > 1 ? " camera__frame--landscape" : ""}`} style={aspect > 1 ? { aspectRatio: String(aspect) } : undefined}>
        {["tl", "tr", "bl", "br"].map((c) => (
          <motion.span key={c} className={`corner corner--${c}`} animate={{ scale: [1, 1.08, 1] }} transition={{ duration: 1.8, repeat: Infinity }} />
        ))}
      </div>

      {live === "off" && !taken && (
        <motion.div className="camera__note" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.4 }}>
          {isNative && busy ? "Opening your camera…" : "Tap the shutter to open your camera"}
        </motion.div>
      )}

      {/* The web fallback: the browser's camera capture. Never a gallery picker without `capture`. */}
      <input ref={picker} className="found-camera__picker" type="file" accept="image/jpeg,image/png,image/webp" capture="environment" onChange={picked} tabIndex={-1} aria-hidden="true" />

      <div className="camera__bottom">
        <div className="camera__hint" role={error && !taken ? "alert" : undefined}>{(!taken && error) || (busy ? "Getting your photo ready…" : hint)}</div>
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
        {taken && (
          <PhotoCropper
            key={taken.id}
            photo={taken.photo}
            caption={caption}
            busy={busy}
            error={error}
            onRetake={retake}
            onUse={use}
            aspect={aspect}
          />
        )}
      </AnimatePresence>
    </motion.div>
  );
}
