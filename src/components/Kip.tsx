import { AnimatePresence, motion, type Transition } from "motion/react";
import type { CSSProperties, ReactNode } from "react";

export type KipPose = "idle" | "wave" | "cheer" | "talk" | "sleep" | "point";

type Props = { pose?: KipPose; size?: number; flip?: boolean; style?: CSSProperties; className?: string };

const loop = (duration: number, delay = 0): Transition => ({ duration, repeat: Infinity, ease: "easeInOut", delay });

const INK = "#1E1A23";

// Pivot in the SVG's own coordinates so joints rotate where they attach.
const pivot = (x: number, y: number) => ({ transformBox: "view-box" as const, originX: `${x}px`, originY: `${y}px` });
const WING = "#100E13";
const BILL = "#FF5A1F";
const LEG = "#F7A1B5";

export function Kip({ pose = "idle", size = 120, flip, style, className }: Props) {
  const cheer = pose === "cheer";
  const sleep = pose === "sleep";
  const talking = pose === "talk" || cheer;

  const bodyAnim = cheer
    ? { y: [0, -22, 0, 0], scaleY: [1, 1.06, 0.9, 1], scaleX: [1, 0.96, 1.08, 1] }
    : sleep
      ? { y: [0, 1.5, 0], scaleY: [1, 0.98, 1] }
      : { y: [0, -2.5, 0] };

  return (
    <motion.svg
      viewBox="0 0 150 150"
      width={size}
      height={size}
      className={className}
      style={{ overflow: "visible", ...style, transform: flip ? "scaleX(-1)" : undefined }}
      aria-label="Kip the oystercatcher"
      role="img"
    >
      <motion.ellipse
        cx={66}
        cy={138}
        rx={30}
        ry={5}
        fill="#14231C"
        style={pivot(66, 138)}
        initial={{ opacity: 0.16 }}
        animate={cheer ? { scaleX: [1, 0.6, 1, 1], opacity: [0.16, 0.08, 0.16, 0.16] } : { scaleX: 1, opacity: 0.16 }}
        transition={loop(cheer ? 0.9 : 2.4)}
      />
      <motion.g animate={bodyAnim} transition={loop(cheer ? 0.9 : sleep ? 3.2 : 2.4)} style={pivot(66, 136)}>
        {/* Legs */}
        <g stroke={LEG} strokeWidth={4.5} strokeLinecap="round" fill="none">
          <path d="M58 104 L55 132 M55 132 L47 134 M55 132 L60 135" />
          <path d="M74 104 L77 132 M77 132 L70 135 M77 132 L85 134" />
        </g>
        {/* Tail */}
        <path d="M30 80 L6 72 Q10 84 24 96Z" fill={WING} />
        {/* Body */}
        <ellipse cx={60} cy={84} rx={36} ry={28} fill={INK} />
        <ellipse cx={66} cy={94} rx={22} ry={11} fill="#3A3442" opacity={0.55} />
        {/* Back wing */}
        <motion.path
          d="M52 70 Q20 62 14 90 Q34 100 58 84Z"
          fill={WING}
          style={pivot(54, 74)}
          animate={cheer ? { rotate: [0, 40, 0, 0] } : {}}
          transition={loop(0.9)}
        />
        {/* Head group */}
        <motion.g
          style={pivot(80, 60)}
          animate={
            pose === "idle"
              ? { rotate: [0, -4, 0, 3, 0] }
              : pose === "point"
                ? { rotate: [-6, -10, -6] }
                : sleep
                  ? { rotate: 14, y: 6 }
                  : pose === "talk"
                    ? { rotate: [0, 3, -2, 0] }
                    : { rotate: 0 }
          }
          transition={sleep ? { type: "spring", stiffness: 60 } : loop(pose === "talk" ? 0.8 : 4)}
        >
          <circle cx={80} cy={50} r={27} fill={INK} />
          <path d="M62 34 Q70 26 82 26" stroke="#FFFFFF" strokeOpacity={0.22} strokeWidth={4} fill="none" strokeLinecap="round" />
          <ellipse cx={90} cy={64} rx={6.5} ry={3.6} fill="#FF7A9A" opacity={0.6} />
          {/* Eye */}
          {sleep ? (
            <path d="M81 48 Q88 54 95 48" stroke="#FF3B2F" strokeWidth={3} fill="none" strokeLinecap="round" />
          ) : (
            <motion.g
              style={pivot(88, 47)}
              animate={{ scaleY: [1, 1, 0.08, 1, 1] }}
              transition={{ duration: 4.2, repeat: Infinity, times: [0, 0.9, 0.93, 0.96, 1] }}
            >
              <circle cx={88} cy={47} r={9.5} fill="#FF3B2F" />
              <circle cx={88} cy={47} r={6.8} fill="#FFD23F" />
              <circle cx={cheer ? 89 : 90} cy={cheer ? 46 : 47} r={3.8} fill="#0D0B10" />
              <circle cx={86} cy={44} r={1.9} fill="#FFFFFF" />
            </motion.g>
          )}
          {/* Bill */}
          <motion.path
            d="M101 57 Q120 59 142 64 Q124 67 100 66Z"
            fill="#E23E14"
            stroke="#14231C"
            strokeWidth={1.6}
            style={pivot(101, 62)}
            animate={talking ? { rotate: [0, 16, 0, 10, 0] } : { rotate: 0 }}
            transition={talking ? loop(cheer ? 0.9 : 0.5) : { duration: 0.2 }}
          />
          <path d="M100 48 Q124 50 146 60 Q124 62 101 60Z" fill={BILL} stroke="#14231C" strokeWidth={1.6} strokeLinejoin="round" />
          <path d="M132 55.5 Q140 57.5 146 60 Q139 61 132 61Z" fill="#FFB547" />
        </motion.g>
        {/* Front wing */}
        <motion.path
          d="M56 72 Q30 74 30 98 Q52 104 68 86Z"
          fill={WING}
          style={pivot(58, 76)}
          animate={
            pose === "wave"
              ? { rotate: [0, -95, -60, -95, 0] }
              : cheer
                ? { rotate: [0, -110, -20, 0] }
                : pose === "point"
                  ? { rotate: -70 }
                  : { rotate: [0, -4, 0] }
          }
          transition={pose === "wave" ? loop(1.3) : cheer ? loop(0.9) : pose === "point" ? { type: "spring" } : loop(2.4)}
        />
      </motion.g>
      <AnimatePresence>
        {sleep && (
          <motion.g initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            {[0, 1, 2].map((i) => (
              <motion.text
                key={i}
                x={112}
                y={30}
                fontSize={12 + i * 3}
                fontWeight={800}
                fill="#14231C"
                fontFamily="'Bricolage Grotesque Variable'"
                animate={{ y: [30, -10], x: [112, 124], opacity: [0, 1, 0] }}
                transition={{ duration: 2.4, repeat: Infinity, delay: i * 0.8 }}
              >
                z
              </motion.text>
            ))}
          </motion.g>
        )}
      </AnimatePresence>
      {cheer &&
        [0, 1, 2, 3].map((i) => (
          <motion.path
            key={i}
            d="M0 -6 L1.8 -1.8 L6 0 L1.8 1.8 L0 6 L-1.8 1.8 L-6 0 L-1.8 -1.8Z"
            fill={i % 2 ? "#FFC93C" : "#FF5A1F"}
            initial={{ x: 70, y: 60, scale: 0 }}
            animate={{ x: [70, 20 + i * 36], y: [60, 4 + (i % 2) * 12], scale: [0, 1.4, 0], rotate: [0, 180] }}
            transition={{ duration: 0.9, repeat: Infinity, delay: i * 0.12, ease: "easeOut" }}
          />
        ))}
    </motion.svg>
  );
}

export function Bubble({ children, show = true, side = "left", style }: { children: ReactNode; show?: boolean; side?: "left" | "right"; style?: CSSProperties }) {
  return (
    <AnimatePresence mode="popLayout">
      {show && (
        <motion.div
          key={String(children)}
          className={`bubble bubble--${side}`}
          style={style}
          initial={{ opacity: 0, scale: 0.4, y: 10, rotate: side === "left" ? -6 : 6 }}
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
