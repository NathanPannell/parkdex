import confetti from "canvas-confetti";

let fire: confetti.CreateTypes | null = null;
let shapes: confetti.Shape[] | null = null;

const COLORS = ["#FF5A1F", "#FFC93C", "#2F9E6B", "#22B3C5", "#FF5C8A", "#7B61FF", "#FFF8EC"];

// Confetti renders into a canvas pinned to the phone frame, not the whole window.
function instance() {
  if (fire) return fire;
  const host = document.querySelector(".device") ?? document.body;
  const canvas = document.createElement("canvas");
  canvas.className = "confetti-canvas";
  host.appendChild(canvas);
  fire = confetti.create(canvas, { resize: true, useWorker: false });
  try {
    shapes = [
      confetti.shapeFromPath({ path: "M0 10 C4 2 12 0 20 0 C18 8 14 16 0 20 C2 16 2 13 0 10Z" }),
      "star",
      "circle",
      "square",
    ];
  } catch {
    shapes = ["star", "circle", "square"];
  }
  return fire;
}

export function burst(origin = { x: 0.5, y: 0.45 }, power = 1) {
  const f = instance();
  const base = { origin, colors: COLORS, shapes: shapes ?? undefined, scalar: 1.1, ticks: 260, gravity: 0.9 };
  void f({ ...base, particleCount: Math.round(90 * power), spread: 80, startVelocity: 42 * power });
  void f({ ...base, particleCount: Math.round(50 * power), spread: 140, startVelocity: 28 * power, decay: 0.92, scalar: 0.8 });
}

export function cannons() {
  const f = instance();
  const base = { colors: COLORS, shapes: shapes ?? undefined, ticks: 300, scalar: 1.05 };
  void f({ ...base, particleCount: 70, angle: 60, spread: 55, origin: { x: 0, y: 0.8 }, startVelocity: 62 });
  void f({ ...base, particleCount: 70, angle: 120, spread: 55, origin: { x: 1, y: 0.8 }, startVelocity: 62 });
}
