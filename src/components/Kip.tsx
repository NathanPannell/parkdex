import { AnimatePresence, motion, type TargetAndTransition, type Transition } from "motion/react";
import type { CSSProperties, ReactNode } from "react";

export type KipPose =
  | "idle"
  | "wave"
  | "cheer"
  | "talk"
  | "sleep"
  | "point"
  | "camera"
  | "celebrate"
  | "map"
  | "walk"
  | "think"
  | "peek"
  | "avatar";

type Props = { pose?: KipPose; size?: number; flip?: boolean; style?: CSSProperties; className?: string };

const loop = (duration: number): Transition => ({ duration, repeat: Infinity, ease: "easeInOut" });

// Each pose image gets its own body language so Kip never sits still.
const MOTION: Record<KipPose, { animate: TargetAndTransition; transition: Transition }> = {
  idle: { animate: { y: [0, -4, 0], scaleY: [1, 1.02, 1] }, transition: loop(2.6) },
  avatar: { animate: { rotate: [0, -4, 0, 3, 0] }, transition: loop(4) },
  wave: { animate: { rotate: [0, -5, 3, -5, 0], y: [0, -3, 0] }, transition: loop(1.4) },
  talk: { animate: { y: [0, -3, 0, -2, 0], rotate: [0, 2, -1, 0] }, transition: loop(0.9) },
  point: { animate: { x: [0, 5, 0], rotate: [0, -3, 0] }, transition: loop(1.8) },
  cheer: { animate: { y: [0, -26, 0, 0], scaleY: [1, 1.06, 0.9, 1], scaleX: [1, 0.95, 1.08, 1] }, transition: loop(0.9) },
  celebrate: { animate: { y: [0, -10, 0], rotate: [0, -4, 4, 0] }, transition: loop(1.1) },
  camera: { animate: { rotate: [0, -2, 0], y: [0, -2, 0] }, transition: loop(2) },
  map: { animate: { rotate: [0, 3, -2, 0] }, transition: loop(2.8) },
  walk: { animate: { y: [0, -5, 0, -5, 0], rotate: [-3, 3, -3] }, transition: loop(0.8) },
  think: { animate: { rotate: [0, -6, -6, 0] }, transition: loop(3.2) },
  sleep: { animate: { scaleY: [1, 0.96, 1], scaleX: [1, 1.03, 1] }, transition: loop(3.4) },
  peek: { animate: { x: [-6, 0, -6] }, transition: loop(3) },
};

// Pivots from art-source/kip/parts/rig.json, as fractions of the 1024 canvas.
const PIVOT = {
  body: [483, 914],
  head: [479, 496],
  wingFront: [422, 529],
  wingBack: [650, 551],
  bill: [641, 393],
  tail: [274, 638],
} as const;
const origin = ([x, y]: readonly [number, number]) => `${(x / 10.24).toFixed(2)}% ${(y / 10.24).toFixed(2)}%`;
const part = (name: string) => `/art/kip/parts/${name}.webp`;
const layer: CSSProperties = { position: "absolute", inset: 0, width: "100%", height: "100%", userSelect: "none", pointerEvents: "none" };

function Part({ name, pivot, animate, transition, style }: { name: string; pivot?: readonly [number, number]; animate?: TargetAndTransition; transition?: Transition; style?: CSSProperties }) {
  return (
    <motion.img
      src={part(name)}
      alt=""
      draggable={false}
      style={{ ...layer, transformOrigin: pivot ? origin(pivot) : undefined, ...style }}
      animate={animate}
      transition={transition}
    />
  );
}

// The articulated Kip: blinks, bobs his head, flaps a wing and talks with his bill.
function KipRig({ talking }: { talking: boolean }) {
  const blink = { duration: 4.2, repeat: Infinity, times: [0, 0.9, 0.92, 0.95, 1] };
  return (
    <motion.div style={{ ...layer, transformOrigin: origin(PIVOT.body) }} animate={{ y: [0, -8, 0], scaleY: [1, 1.02, 1] }} transition={loop(2.6)}>
      <Part name="tail" pivot={PIVOT.tail} animate={{ rotate: [0, 8, 0] }} transition={loop(1.3)} />
      <Part name="legs" />
      <Part name="wing-back" pivot={PIVOT.wingBack} animate={{ rotate: talking ? [0, 14, 0] : [0, 4, 0] }} transition={loop(talking ? 0.9 : 2.6)} />
      <Part name="body" />
      <motion.div style={{ ...layer, transformOrigin: origin(PIVOT.head) }} animate={{ rotate: talking ? [0, 5, -3, 0] : [0, -4, 0, 3, 0] }} transition={loop(talking ? 1.2 : 4)}>
        <Part name="head" />
        <Part name="eye-open" animate={{ opacity: [1, 1, 0, 1, 1] }} transition={blink} />
        <Part name="eye-closed" style={{ opacity: 0 }} animate={{ opacity: [0, 0, 1, 0, 0] }} transition={blink} />
        <Part name="bill-lower" pivot={PIVOT.bill} animate={{ rotate: talking ? [0, 16, 2, 12, 0] : 0 }} transition={talking ? loop(0.5) : { duration: 0.2 }} />
        <Part name="bill-upper" pivot={PIVOT.bill} animate={{ rotate: talking ? [0, -3, 0, -2, 0] : 0 }} transition={talking ? loop(0.5) : { duration: 0.2 }} />
      </motion.div>
      <Part name="wing-front" pivot={PIVOT.wingFront} animate={{ rotate: talking ? [0, -30, -10, -34, 0] : [0, -6, 0] }} transition={loop(talking ? 1.3 : 2.6)} />
    </motion.div>
  );
}

export function Kip({ pose = "idle", size = 120, flip, style, className }: Props) {
  if (pose === "idle" || pose === "talk") {
    return (
      <div className={className} style={{ width: size, height: size, position: "relative", ...style }} role="img" aria-label="Kip the oystercatcher">
        <div style={{ ...layer, transform: flip ? "scaleX(-1)" : undefined }}>
          <KipRig talking={pose === "talk"} />
        </div>
      </div>
    );
  }
  const m = MOTION[pose];
  return (
    <div className={className} style={{ width: size, height: size, position: "relative", ...style }} role="img" aria-label="Kip the oystercatcher">
      <div style={{ width: "100%", height: "100%", transform: flip ? "scaleX(-1)" : undefined }}>
        <motion.img
          key={pose}
          src={`/art/kip/kip-${pose}.webp`}
          alt=""
          draggable={false}
          style={{ width: "100%", height: "100%", display: "block", transformOrigin: "50% 90%", userSelect: "none" }}
          initial={{ scale: 0.85, opacity: 0 }}
          animate={{ ...m.animate, opacity: 1, scale: 1 }}
          transition={{ ...m.transition, opacity: { duration: 0.2 }, scale: { type: "spring", stiffness: 500, damping: 18 } }}
        />
      </div>
      {pose === "sleep" && <Zzz size={size} />}
    </div>
  );
}

function Zzz({ size }: { size: number }) {
  return (
    <div style={{ position: "absolute", right: size * 0.05, top: 0, pointerEvents: "none" }}>
      {[0, 1, 2].map((i) => (
        <motion.span
          key={i}
          style={{ position: "absolute", fontFamily: "var(--display)", fontWeight: 800, fontSize: size * (0.1 + i * 0.03), color: "#14231C" }}
          animate={{ y: [0, -size * 0.3], x: [0, size * 0.1], opacity: [0, 1, 0] }}
          transition={{ duration: 2.4, repeat: Infinity, delay: i * 0.8 }}
        >
          z
        </motion.span>
      ))}
    </div>
  );
}

// "left"/"right" put a downward tail near that corner, for a bubble above Kip.
// "to-left"/"to-right" point the tail sideways at Kip standing beside the bubble;
// "down" centres it over Kip standing below.
type BubbleSide = "left" | "right" | "to-left" | "to-right" | "down";

export function Bubble({ children, show = true, side = "left", style }: { children: ReactNode; show?: boolean; side?: BubbleSide; style?: CSSProperties }) {
  return (
    <AnimatePresence mode="popLayout">
      {show && (
        <motion.div
          key={String(children)}
          className={`bubble bubble--${side}`}
          style={style}
          initial={{ opacity: 0, scale: 0.4, y: 10, rotate: side === "left" || side === "to-left" ? -6 : 6 }}
          animate={{ opacity: 1, scale: 1, y: 0, rotate: 0 }}
          exit={{ opacity: 0, scale: 0.6, y: -6 }}
          transition={{ type: "spring", stiffness: 520, damping: 22 }}
        >
          {children}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
