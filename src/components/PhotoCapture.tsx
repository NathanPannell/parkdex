import { AnimatePresence, motion } from "motion/react";
import { useRef, useState, type ChangeEvent } from "react";
import { Icon } from "./Icon";
import { Kip } from "./Kip";
import { buzz, sfx } from "../lib/feedback";
import { useBackHandler } from "../lib/backStack";
import { takeNativePhoto, useLiveCamera, type Facing } from "../lib/camera";
import { isNative } from "../lib/native";
import { encodePhoto, encodePhotoBlob, encodePhotoDataUrl, MAX_PHOTO_EDGE, type EncodedPhoto } from "../lib/photoEncode";

type Props = {
  /** Shown in the chip at the top, such as "Inside Paterson Park". */
  place: string;
  hint: string;
  caption: string;
  onUse: (photo: EncodedPhoto) => void;
  onClose: () => void;
};

/**
 * Takes one real photo and offers "Use this photo" or "Retake". A live preview is used when the
 * device grants one; otherwise the phone's camera app (native) or the browser's camera picker.
 * Every photo is downscaled and re-encoded before it leaves this component.
 */
export function PhotoCapture({ place, hint, caption, onUse, onClose }: Props) {
  const [facing, setFacing] = useState<Facing>("environment");
  const { video, live } = useLiveCamera(facing, 1920);
  const [photo, setPhoto] = useState<EncodedPhoto | null>(null);
  const [flash, setFlash] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  // Back from the photo review returns to the camera.
  useBackHandler(() => setPhoto(null), !!photo);

  async function prepare(work: () => Promise<EncodedPhoto | null> | EncodedPhoto | null) {
    setBusy(true);
    setError(null);
    try {
      const encoded = await work();
      if (encoded) setPhoto(encoded);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "This photo could not be used. Try again.");
    } finally {
      setBusy(false);
    }
  }

  const shoot = () => {
    if (busy) return;
    const v = video.current;
    if (live === "on" && v && v.videoWidth) {
      sfx.shutter();
      buzz(20);
      setFlash((value) => value + 1);
      void prepare(() => encodePhoto({ source: v, width: v.videoWidth, height: v.videoHeight }, { mirror: facing === "user" }));
    } else if (isNative) {
      void prepare(async () => {
        const dataUrl = await takeNativePhoto({ quality: 90, width: MAX_PHOTO_EDGE });
        return dataUrl ? encodePhotoDataUrl(dataUrl) : null;
      });
    } else {
      picker.current?.click();
    }
  };

  const picked = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file) void prepare(() => encodePhotoBlob(file));
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
        <button className="camera__round" onClick={() => setFacing((f) => (f === "user" ? "environment" : "user"))} aria-label="Flip camera" disabled={live !== "on"}>
          <Icon name="flip" size={20} />
        </button>
      </div>

      <div className="camera__frame">
        {["tl", "tr", "bl", "br"].map((c) => (
          <motion.span key={c} className={`corner corner--${c}`} animate={{ scale: [1, 1.08, 1] }} transition={{ duration: 1.8, repeat: Infinity }} />
        ))}
      </div>

      {live === "off" && !photo && (
        <motion.div className="camera__note" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.4 }}>
          Tap the shutter to open your camera
        </motion.div>
      )}

      <input ref={picker} className="found-camera__picker" type="file" accept="image/jpeg,image/png,image/webp" capture="environment" onChange={picked} tabIndex={-1} aria-hidden="true" />

      <div className="camera__bottom">
        <div className="camera__hint" role={error ? "alert" : undefined}>{error ?? (busy ? "Getting your photo ready…" : hint)}</div>
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
        {photo && (
          <motion.div className="review" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <motion.div
              className="polaroid found-camera__polaroid"
              initial={{ scale: 1.4, rotate: 0, y: -40 }}
              animate={{ scale: 1, rotate: -3, y: 0 }}
              transition={{ type: "spring", stiffness: 220, damping: 16 }}
            >
              <div className="polaroid__img" style={{ aspectRatio: `${photo.width} / ${photo.height}` }}>
                <motion.img src={photo.dataUrl} alt="Your photo" initial={{ filter: "brightness(2.4) saturate(0)" }} animate={{ filter: "brightness(1) saturate(1)" }} transition={{ duration: 1.4, ease: "easeOut" }} />
              </div>
              <span className="polaroid__caption">{caption}</span>
            </motion.div>
            <motion.div className="review__actions" initial={{ y: 80, opacity: 0 }} animate={{ y: 0, opacity: 1 }} transition={{ delay: 0.3, type: "spring" }}>
              <button className="btn btn--paper" onClick={() => setPhoto(null)}>
                <Icon name="refresh" size={18} /> Retake
              </button>
              <button
                className="btn btn--glow"
                onClick={() => {
                  sfx.pop();
                  onUse(photo);
                }}
              >
                Use this photo <Icon name="next" />
              </button>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
