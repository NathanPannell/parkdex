import { animate, AnimatePresence, motion, useAnimationFrame, useMotionValue, useTransform } from "motion/react";
import { useRef, useState } from "react";
import { Badge } from "../components/Badge";
import { Icon } from "../components/Icon";
import { Bubble, Kip } from "../components/Kip";
import { RollingNumber, Rays, Tilt } from "../components/Motion";
import { burst, cannons } from "../lib/confetti";
import { buzz, sfx } from "../lib/feedback";
import { PALETTES, PARK_BY_ID, RARITY, TOTAL_BADGES } from "../lib/parks";
import { useStore } from "../lib/store";

const HOLD_MS = 1500;
const CHEERS = ["KLEEP! Beauty!", "Into the case!", "Look at that shine!", "Another one!"];

export function Claim() {
  const { state, dispatch } = useStore();
  const park = PARK_BY_ID.get(state.tripId ?? "")!;
  const photo = state.pendingPhoto ?? "";
  const pal = PALETTES[park.biome];
  const rarity = RARITY[park.rarity];
  const [phase, setPhase] = useState<"charge" | "done">("charge");
  const [holding, setHolding] = useState(false);
  // Frozen at mount: the claim itself bumps the live count mid-ceremony.
  const [before] = useState(() => Object.keys(state.claims).length);
  const [count, setCount] = useState(before);
  const number = before + 1;

  const progress = useMotionValue(0);
  const ring = useTransform(progress, (p) => 289 * (1 - p));
  const filter = useTransform(progress, (p) => `grayscale(${1 - p}) brightness(${0.55 + p * 0.45}) contrast(${0.9 + p * 0.1})`);
  const glow = useTransform(progress, (p) => p * 0.9);
  const shakeX = useMotionValue(0);
  const shakeR = useMotionValue(0);
  const anim = useRef<ReturnType<typeof animate> | null>(null);
  const lastTick = useRef(0);

  useAnimationFrame((t) => {
    if (phase !== "charge") return;
    const p = progress.get();
    shakeX.set(Math.sin(t / 22) * p * p * 7);
    shakeR.set(Math.sin(t / 31) * p * p * 6);
  });

  const start = (e: React.PointerEvent) => {
    if (phase !== "charge") return;
    e.currentTarget.setPointerCapture(e.pointerId);
    setHolding(true);
    anim.current?.stop();
    anim.current = animate(progress, 1, {
      duration: (HOLD_MS / 1000) * (1 - progress.get()),
      ease: "easeIn",
      onUpdate: (p) => {
        const step = Math.floor(p * 10);
        if (step > lastTick.current) {
          lastTick.current = step;
          sfx.charge(p);
          buzz(6 + step * 2);
        }
      },
      onComplete: complete,
    });
  };

  const release = () => {
    if (phase !== "charge" || progress.get() >= 1) return;
    setHolding(false);
    lastTick.current = 0;
    anim.current?.stop();
    anim.current = animate(progress, 0, { type: "spring", stiffness: 300, damping: 24 });
  };

  function complete() {
    setHolding(false);
    setPhase("done");
    sfx.claim();
    buzz([40, 40, 80, 40, 160]);
    shakeX.set(0);
    shakeR.set(0);
    burst({ x: 0.5, y: 0.42 }, 1.3);
    setTimeout(cannons, 350);
    setTimeout(() => setCount(number), 700);
    setTimeout(() => sfx.chirp(), 900);
    dispatch({ type: "claim", id: park.id, photo });
    dispatch({ type: "trip", id: park.id });
  }

  return (
    <motion.div
      className="screen claim"
      style={{ ["--spot" as string]: pal.skyTop }}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, transition: { duration: 0.3 } }}
    >
      <motion.div className="claim__spot" style={{ opacity: phase === "done" ? 1 : undefined }} />
      <motion.div className="claim__glow" style={{ opacity: phase === "done" ? 1 : glow, background: `radial-gradient(circle, ${pal.skyTop} 0%, transparent 62%)` }} />

      <div className="claim__head">
        <AnimatePresence mode="wait">
          {phase === "charge" ? (
            <motion.div key="a" initial={{ y: -20, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: -20, opacity: 0 }}>
              <span className="eyebrow eyebrow--light">Checked in · {new Date().toLocaleTimeString("en-CA", { hour: "numeric", minute: "2-digit" })}</span>
              <h1>{park.short}</h1>
            </motion.div>
          ) : (
            <motion.div key="b" className="claim__stamp" initial={{ scale: 3.2, rotate: -24, opacity: 0 }} animate={{ scale: 1, rotate: -5, opacity: 1 }} transition={{ type: "spring", stiffness: 520, damping: 15, delay: 0.25 }}>
              Badge claimed!
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <motion.div
        className="claim__photo"
        initial={{ x: -200, rotate: -40 }}
        animate={phase === "done" ? { x: 0, rotate: -9, y: 0, scale: 1 } : { x: 0, rotate: -12, y: 0 }}
        transition={{ type: "spring", stiffness: 200, damping: 16, delay: 0.2 }}
      >
        <span className="tape" />
        <img src={photo} alt="Your check-in" />
      </motion.div>

      <div className="claim__stage">
        {phase === "done" && (
          <>
            <div className="claim__rays">
              <Rays color="#FFE27A" size={620} opacity={0.5} speed={20} />
            </div>
            {[0, 1, 2].map((i) => (
              <motion.span
                key={i}
                className="shock"
                initial={{ scale: 0.2, opacity: 0.9 }}
                animate={{ scale: 3.4, opacity: 0 }}
                transition={{ duration: 1, delay: i * 0.12, ease: "easeOut" }}
              />
            ))}
          </>
        )}
        {phase === "charge" && (
          <div className={`orbit ${holding ? "orbit--pull" : ""}`}>
            {Array.from({ length: 18 }, (_, i) => (
              <span key={i} style={{ ["--a" as string]: `${i * 20}deg`, ["--d" as string]: `${(i % 6) * 0.12}s`, background: i % 3 ? pal.skyTop : "#FFC93C" }} />
            ))}
          </div>
        )}
        <motion.div
          className="claim__badge"
          style={{ x: shakeX, rotate: shakeR }}
          initial={{ scale: 0.2, y: 120, opacity: 0 }}
          animate={
            phase === "done"
              ? { scale: [0.8, 1.28, 1], rotateY: [0, 360], y: 0, opacity: 1 }
              : { scale: holding ? 1.08 : 1, y: 0, opacity: 1 }
          }
          transition={
            phase === "done"
              ? { duration: 0.9, ease: [0.2, 1.4, 0.4, 1] }
              : { type: "spring", stiffness: 240, damping: 18 }
          }
        >
          <motion.div style={{ filter: phase === "done" ? "none" : filter }}>
            <Tilt idle={phase === "done"} max={phase === "done" ? 22 : 0}>
              <Badge park={park} size={236} animated state={phase === "done" ? "earned" : "preview"} />
            </Tilt>
          </motion.div>
        </motion.div>
        {phase === "done" && <motion.div className="claim__flash" initial={{ opacity: 1 }} animate={{ opacity: 0 }} transition={{ duration: 0.7 }} />}
      </div>

      <div className="claim__foot">
        <AnimatePresence mode="wait">
          {phase === "charge" ? (
            <motion.div key="hold" className="hold" initial={{ y: 60, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 40, opacity: 0, scale: 0.8 }} transition={{ type: "spring", delay: 0.4 }}>
              <motion.button
                className="hold__btn"
                onPointerDown={start}
                onPointerUp={release}
                onPointerCancel={release}
                onContextMenu={(e) => e.preventDefault()}
                animate={{ scale: holding ? 0.92 : 1 }}
                transition={{ type: "spring", stiffness: 500, damping: 20 }}
                aria-label="Hold to claim"
              >
                <svg viewBox="0 0 100 100" className="hold__ring">
                  <circle cx="50" cy="50" r="46" fill="none" stroke="rgba(255,248,236,.18)" strokeWidth="7" />
                  <motion.circle cx="50" cy="50" r="46" fill="none" stroke="#FFC93C" strokeWidth="7" strokeLinecap="round" strokeDasharray="289" style={{ strokeDashoffset: ring }} transform="rotate(-90 50 50)" />
                </svg>
                <span className="hold__core">
                  <Icon name="sparkle" size={30} stroke={2.6} />
                </span>
              </motion.button>
              <motion.p className="hold__label" animate={{ opacity: holding ? 0.5 : 1 }}>
                {holding ? "Keep holding…" : "Press and hold to claim"}
              </motion.p>
            </motion.div>
          ) : (
            <motion.div key="done" className="claim__done" initial="hidden" animate="show" variants={{ show: { transition: { staggerChildren: 0.08, delayChildren: 0.6 } } }}>
              <motion.div className="claim__rarity" variants={pop}>
                <span className="pill" style={{ background: rarity.color, color: rarity.ink }}>
                  {"★".repeat(rarity.stars)} {rarity.label}
                </span>
                <span className="claim__count">
                  Badge #<RollingNumber value={count} />&nbsp;of {TOTAL_BADGES.toLocaleString("en-CA")}
                </span>
              </motion.div>
              <motion.button variants={pop} className="btn btn--block btn--sun" onClick={() => dispatch({ type: "go", screen: "share" })}>
                <Icon name="share" /> Share it
              </motion.button>
              <motion.div variants={pop} className="claim__row">
                <button className="btn btn--sm btn--ink" onClick={() => dispatch({ type: "go", screen: "collection" })}>
                  <Icon name="case" size={18} /> See my case
                </button>
                <button
                  className="btn btn--sm btn--paper"
                  onClick={() => {
                    dispatch({ type: "trip", id: null });
                    dispatch({ type: "go", screen: "map" });
                  }}
                >
                  <Icon name="map" size={18} /> Find next park
                </button>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <AnimatePresence>
        {phase === "done" && (
          <motion.div className="claim__kip" initial={{ y: 200, rotate: 20 }} animate={{ y: 0, rotate: 0 }} transition={{ type: "spring", delay: 0.9, stiffness: 220, damping: 14 }}>
            <Bubble side="right" style={{ right: 70, top: -40, whiteSpace: "nowrap" }}>
              {number === 1 ? "Your first badge! KLEEP!" : CHEERS[number % CHEERS.length]}
            </Bubble>
            <Kip pose="cheer" size={96} flip />
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

const pop = {
  hidden: { y: 30, opacity: 0, scale: 0.9 },
  show: { y: 0, opacity: 1, scale: 1, transition: { type: "spring" as const, stiffness: 420, damping: 22 } },
};
