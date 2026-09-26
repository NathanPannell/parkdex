import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { Icon } from "../components/Icon";
import { Bubble, Kip } from "../components/Kip";
import { buzz, sfx } from "../lib/feedback";
import { PALETTES, PARK_BY_ID, type Park } from "../lib/parks";
import { useStore } from "../lib/store";

// When no camera is available (desktop without webcam, denied permission),
// the mockup "photographs" an illustrated scene so the flow still completes.
function sceneSvg(park: Park) {
  const p = PALETTES[park.biome];
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 800" preserveAspectRatio="xMidYMid slice">
<defs><linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${p.skyTop}"/><stop offset="1" stop-color="${p.skyBottom}"/></linearGradient></defs>
<rect width="600" height="800" fill="url(#s)"/>
<circle cx="${180 + (park.seed % 240)}" cy="220" r="70" fill="${p.sun}"/>
<path d="M0 420 Q120 330 240 400 T480 370 T600 390 L600 800 L0 800Z" fill="${p.far}"/>
<path d="M0 500 Q150 430 300 490 T600 470 L600 800 L0 800Z" fill="${p.mid}"/>
<path d="M0 560 L600 540 L600 800 L0 800Z" fill="${p.water}" opacity=".85"/>
<path d="M0 640 Q160 590 320 650 T600 630 L600 800 L0 800Z" fill="${p.near}"/>
${Array.from({ length: 7 }, (_, i) => {
    const x = 30 + i * 90 + ((park.seed * (i + 3)) % 40);
    const h = 120 + ((park.seed * (i + 7)) % 90);
    return `<path d="M${x} ${700 - h} l${h * 0.28} ${h * 0.55} h-${h * 0.12} l${h * 0.2} ${h * 0.45} h-${h * 0.72} l${h * 0.2} -${h * 0.45} h-${h * 0.12}Z" fill="#14231C" opacity=".9"/>`;
  }).join("")}
</svg>`;
}

export function Camera() {
  const { state, dispatch } = useStore();
  const park = PARK_BY_ID.get(state.tripId ?? "")!;
  const video = useRef<HTMLVideoElement>(null);
  const [live, setLive] = useState<"pending" | "on" | "off">("pending");
  const [photo, setPhoto] = useState<string | null>(null);
  const [flash, setFlash] = useState(0);
  const [facing, setFacing] = useState<"environment" | "user">("environment");

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
    return () => {
      cancelled = true;
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [facing]);

  const shoot = () => {
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
      setPhoto(`data:image/svg+xml;utf8,${encodeURIComponent(sceneSvg(park))}`);
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
        {live === "off" && <div className="camera__fallback" dangerouslySetInnerHTML={{ __html: sceneSvg(park) }} />}
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
          No camera found, so this is a stand-in scene
        </motion.div>
      )}

      <motion.div className="camera__kip" initial={{ x: 120 }} animate={{ x: 0 }} transition={{ delay: 0.9, type: "spring", stiffness: 200, damping: 16 }}>
        <Bubble side="right" style={{ right: 50, top: -44, whiteSpace: "nowrap" }}>
          Say "cheese"!
        </Bubble>
        <Kip pose="camera" size={96} flip />
      </motion.div>

      <div className="camera__bottom">
        <div className="camera__hint">Get the park in the shot. This photo goes on your badge.</div>
        <motion.button className="shutter" onClick={shoot} whileTap={{ scale: 0.86 }} aria-label="Take photo">
          <span />
        </motion.button>
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
