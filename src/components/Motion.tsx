import { animate, motion, useMotionValue, useSpring, useTransform } from "motion/react";
import { useEffect, useRef, useState, type ReactNode, type CSSProperties } from "react";

// Pointer-driven 3D tilt. Also feeds --hx/--hy so holo foil on badges slides with the tilt.
export function Tilt({ children, max = 18, idle = true, style }: { children: ReactNode; max?: number; idle?: boolean; style?: CSSProperties }) {
  const ref = useRef<HTMLDivElement>(null);
  const px = useMotionValue(0);
  const py = useMotionValue(0);
  const sx = useSpring(px, { stiffness: 180, damping: 16 });
  const sy = useSpring(py, { stiffness: 180, damping: 16 });
  const rotateY = useTransform(sx, (v) => v * max);
  const rotateX = useTransform(sy, (v) => -v * max);
  const hx = useTransform(sx, (v) => v * 60);
  const hy = useTransform(sy, (v) => v * 60);
  const [hover, setHover] = useState(false);

  useEffect(() => {
    if (!idle || hover) return;
    const controls = [
      animate(px, [0, 0.5, 0, -0.5, 0], { duration: 6, repeat: Infinity, ease: "easeInOut" }),
      animate(py, [0, -0.3, 0, 0.3, 0], { duration: 5, repeat: Infinity, ease: "easeInOut" }),
    ];
    return () => controls.forEach((c) => c.stop());
  }, [idle, hover]);

  const move = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    px.set(((e.clientX - r.left) / r.width) * 2 - 1);
    py.set(((e.clientY - r.top) / r.height) * 2 - 1);
  };

  return (
    <motion.div
      ref={ref}
      onPointerMove={move}
      onPointerEnter={() => setHover(true)}
      onPointerLeave={() => {
        setHover(false);
        px.set(0);
        py.set(0);
      }}
      style={{ perspective: 700, touchAction: "pan-y", ...style }}
    >
      <motion.div style={{ rotateX, rotateY, transformStyle: "preserve-3d", ["--hx" as string]: hx, ["--hy" as string]: hy }}>{children}</motion.div>
    </motion.div>
  );
}

// Odometer-style number: each digit rolls independently.
export function RollingNumber({ value, className }: { value: number; className?: string }) {
  const digits = value.toLocaleString("en-CA").split("");
  return (
    <span className={`roll ${className ?? ""}`} aria-label={String(value)}>
      {digits.map((d, i) => (/\d/.test(d) ? <Digit key={digits.length - i} d={Number(d)} /> : <span key={`s${digits.length - i}`}>{d}</span>))}
    </span>
  );
}

function Digit({ d }: { d: number }) {
  return (
    <span className="roll__digit">
      <motion.span className="roll__strip" animate={{ y: `${-d * 10}%` }} transition={{ type: "spring", stiffness: 140, damping: 18 }}>
        {Array.from({ length: 10 }, (_, i) => (
          <span key={i}>{i}</span>
        ))}
      </motion.span>
    </span>
  );
}

// Radiating light rays for hero moments.
export function Rays({ color = "#FFC93C", size = 420, speed = 24, opacity = 0.5 }: { color?: string; size?: number; speed?: number; opacity?: number }) {
  return (
    <motion.div
      className="rays"
      style={{ width: size, height: size, opacity, background: `repeating-conic-gradient(from 0deg, ${color} 0deg 9deg, transparent 9deg 22.5deg)` }}
      animate={{ rotate: 360 }}
      transition={{ duration: speed, repeat: Infinity, ease: "linear" }}
    />
  );
}
