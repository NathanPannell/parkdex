import { Camera as NativeCamera, CameraResultType, CameraSource } from "@capacitor/camera";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../components/Icon";
import { Kip } from "../components/Kip";
import { ContentGate } from "../components/ContentGate";
import { buzz, sfx } from "../lib/feedback";
import { scenePath, type Park } from "../lib/parks";
import { FIELD } from "../lib/native";
import { useStore } from "../lib/store";
import { useContent, useContentRuntime } from "../lib/content/provider";
import { getParkRarityEligibility, getRarityProgress } from "../lib/progression";
import { sceneSvg } from "../lib/accounts/photoBackupRendition";

// When no camera is available (desktop without webcam, denied permission),
// the mockup "photographs" an illustrated scene so the flow still completes.
function rasterizeSyntheticScene(svg: string): Promise<string> {
  const objectUrl = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml;charset=utf-8" }));
  return new Promise((resolve, reject) => {
    const image = new Image();
    const releaseUrl = () => URL.revokeObjectURL(objectUrl);
    image.onload = () => {
      releaseUrl();
      try {
        const width = 720;
        const height = 960;
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext("2d");
        if (!context) throw new Error("A photo canvas could not be opened.");
        context.drawImage(image, 0, 0, width, height);
        const photo = canvas.toDataURL("image/jpeg", 0.82);
        if (!photo.startsWith("data:image/jpeg;base64,")) throw new Error("The demo photo could not be encoded as JPEG.");
        resolve(photo);
      } catch (error) {
        reject(error);
      }
    };
    image.onerror = () => {
      releaseUrl();
      reject(new Error("The demo scene could not be rasterized."));
    };
    image.src = objectUrl;
  });
}

export function Camera() {
  const { state, dispatch } = useStore();
  const content = useContent();
  const park = content?.parkById.get(state.tripId ?? "");
  const rarityProgress = useMemo(() => getRarityProgress(state.claims, content?.parkById), [state.claims, content?.parkById]);
  const eligibility = park ? getParkRarityEligibility(park, rarityProgress, !!state.claims[park.id]) : null;
  const canClaim = !!park && state.progressReady && !state.claims[park.id] && !!eligibility?.eligible && eligibility.reason === "unlocked";
  const runtime = useContentRuntime();
  const artParkId = park?.scene && !content?.assetUrls.has(scenePath(park.scene)) ? park.id : null;

  // Start saving this park's badge art while the photo is taken, so the claim does not wait for it.
  useEffect(() => {
    if (artParkId) void runtime.ensureParkArt?.(artParkId).catch(() => {});
  }, [artParkId, runtime]);

  useEffect(() => {
    if (!park || !state.progressReady || canClaim) return;
    dispatch({ type: "trip", id: null });
    dispatch({ type: "select", id: park.id });
    dispatch({ type: "go", screen: "map" });
  }, [canClaim, dispatch, park, state.progressReady]);

  if (!park || !state.progressReady || !canClaim) return <ContentGate />;
  return <CameraReady park={park} />;
}

function CameraReady({ park }: { park: Park }) {
  const { dispatch } = useStore();
  const video = useRef<HTMLVideoElement>(null);
  const [live, setLive] = useState<"pending" | "on" | "off">("pending");
  const [photo, setPhoto] = useState<string | null>(null);
  const [flash, setFlash] = useState(0);
  const [facing, setFacing] = useState<"environment" | "user">("environment");
  const [syntheticBusy, setSyntheticBusy] = useState(false);
  const [syntheticError, setSyntheticError] = useState<string | null>(null);

  useEffect(() => {
    let stream: MediaStream | null = null;
    let cancelled = false;
    navigator.mediaDevices
      ?.getUserMedia({ video: { facingMode: facing, width: { ideal: 1280 } }, audio: false })
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
  }, [facing]);

  // Field builds never use the stand-in scene: without a live preview they hand off
  // to the phone's own camera app so every claim has a real photo.
  const nativeShot = async () => {
    try {
      const shot = await NativeCamera.getPhoto({
        source: CameraSource.Camera,
        resultType: CameraResultType.DataUrl,
        quality: 82,
        width: 1080,
        correctOrientation: true,
      });
      if (shot.dataUrl) setPhoto(shot.dataUrl);
    } catch {
      // The visitor backed out of the camera app.
    }
  };

  const shoot = () => {
    if (syntheticBusy) return;
    if (FIELD && live !== "on") {
      void nativeShot();
      return;
    }
    sfx.shutter();
    buzz(20);
    setFlash((f) => f + 1);
    const v = video.current;
    if (live === "on" && v && v.videoWidth) {
      const w = 720;
      const h = Math.round((w * 4) / 3);
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      const ctx = c.getContext("2d")!;
      const scale = Math.max(w / v.videoWidth, h / v.videoHeight);
      const dw = v.videoWidth * scale;
      const dh = v.videoHeight * scale;
      if (facing === "user") {
        ctx.translate(w, 0);
        ctx.scale(-1, 1);
      }
      ctx.drawImage(v, (w - dw) / 2, (h - dh) / 2, dw, dh);
      setPhoto(c.toDataURL("image/jpeg", 0.82));
    } else {
      setSyntheticBusy(true);
      setSyntheticError(null);
      void rasterizeSyntheticScene(sceneSvg(park))
        .then(setPhoto)
        .catch(() => setSyntheticError("Kip couldn’t prepare the demo photo. Try taking it again."))
        .finally(() => setSyntheticBusy(false));
    }
  };

  const usePhoto = () => {
    if (!photo) return;
    sfx.pop();
    dispatch({ type: "photo", photo });
    dispatch({ type: "go", screen: "claim" });
  };

  return (
    <motion.div
      className="screen camera"
      initial={{ clipPath: "circle(0% at 50% 92%)" }}
      animate={{ clipPath: "circle(150% at 50% 92%)" }}
      exit={{ opacity: 0, transition: { duration: 0.3 } }}
      transition={{ duration: 0.7, ease: [0.7, 0, 0.2, 1] }}
    >
      <div className="camera__feed">
        <video ref={video} playsInline muted className={facing === "user" ? "mirror" : ""} style={{ opacity: live === "on" ? 1 : 0 }} />
        {live === "off" && !FIELD && <div className="camera__fallback" dangerouslySetInnerHTML={{ __html: sceneSvg(park) }} />}
        <div className="camera__grid" />
      </div>

      <div className="camera__top">
        <button className="camera__round" onClick={() => dispatch({ type: "go", screen: "map" })} aria-label="Close camera">
          <Icon name="close" size={20} stroke={2.8} />
        </button>
        <motion.div className="camera__geo" initial={{ y: -30, opacity: 0 }} animate={{ y: 0, opacity: 1 }} transition={{ delay: 0.5, type: "spring" }}>
          <span className="camera__geo-dot" /> Inside {park.short}
        </motion.div>
        <button className="camera__round" onClick={() => setFacing((f) => (f === "user" ? "environment" : "user"))} aria-label="Flip camera">
          <Icon name="flip" size={20} />
        </button>
      </div>

      <div className="camera__frame">
        {["tl", "tr", "bl", "br"].map((c) => (
          <motion.span key={c} className={`corner corner--${c}`} animate={{ scale: [1, 1.08, 1] }} transition={{ duration: 1.8, repeat: Infinity }} />
        ))}
      </div>

      {live === "off" && !photo && (
        <motion.div className="camera__note" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.8 }}>
          {FIELD ? "Tap the shutter to open your camera" : "No camera found, so this is a stand-in scene"}
        </motion.div>
      )}

      <div className="camera__bottom">
        <div className="camera__hint" role={syntheticError ? "alert" : undefined}>{syntheticError ?? (syntheticBusy ? "Preparing your demo photo…" : "Get the park in the shot. This photo goes on your badge.")}</div>
        {/* Kip waits beside the shutter, outside the viewfinder, so he never covers the shot. */}
        <div className="camera__controls">
          <motion.button className="shutter" onClick={shoot} disabled={syntheticBusy} whileTap={{ scale: 0.86 }} aria-label="Take photo">
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
              className="polaroid"
              initial={{ scale: 1.4, rotate: 0, y: -40 }}
              animate={{ scale: 1, rotate: -3, y: 0 }}
              transition={{ type: "spring", stiffness: 220, damping: 16 }}
            >
              <div className="polaroid__img">
                <motion.img src={photo} alt="" initial={{ filter: "brightness(2.4) saturate(0)" }} animate={{ filter: "brightness(1) saturate(1)" }} transition={{ duration: 1.4, ease: "easeOut" }} />
              </div>
              <span className="polaroid__caption">
                {park.short} · {new Date().toLocaleDateString("en-CA", { month: "short", day: "numeric" })}
              </span>
            </motion.div>
            <motion.div className="review__actions" initial={{ y: 80, opacity: 0 }} animate={{ y: 0, opacity: 1 }} transition={{ delay: 0.3, type: "spring" }}>
              <button className="btn btn--paper" onClick={() => setPhoto(null)}>
                Retake
              </button>
              <button className="btn btn--glow" onClick={usePhoto}>
                Looks great <Icon name="next" />
              </button>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
