// Tiny Web Audio synth and vibration helpers. Everything is generated, so the
// mockup ships no audio files and stays silent until the first user gesture.
let ctx: AudioContext | null = null;
let muted = false;

export function setMuted(value: boolean) {
  muted = value;
}

function audio() {
  if (muted) return null;
  try {
    ctx ??= new AudioContext();
    if (ctx.state === "suspended") void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

function tone(freq: number, start: number, dur: number, type: OscillatorType = "sine", gain = 0.12, glideTo?: number) {
  const a = audio();
  if (!a) return;
  const t = a.currentTime + start;
  const osc = a.createOscillator();
  const amp = a.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  if (glideTo) osc.frequency.exponentialRampToValueAtTime(glideTo, t + dur);
  amp.gain.setValueAtTime(0, t);
  amp.gain.linearRampToValueAtTime(gain, t + 0.012);
  amp.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(amp).connect(a.destination);
  osc.start(t);
  osc.stop(t + dur + 0.02);
}

export const sfx = {
  tap: () => tone(660, 0, 0.07, "triangle", 0.06, 880),
  pop: () => tone(420, 0, 0.12, "sine", 0.12, 980),
  whoosh: () => tone(220, 0, 0.25, "sawtooth", 0.025, 900),
  shutter: () => {
    tone(1800, 0, 0.04, "square", 0.05);
    tone(900, 0.05, 0.06, "square", 0.04);
  },
  chirp: () => {
    // Kip's call: two quick rising "kleep" notes.
    tone(1400, 0, 0.09, "triangle", 0.07, 2400);
    tone(1500, 0.12, 0.11, "triangle", 0.07, 2600);
  },
  arrive: () => [523, 659, 784].forEach((f, i) => tone(f, i * 0.09, 0.3, "triangle", 0.09)),
  charge: (progress: number) => tone(220 + progress * 660, 0, 0.09, "sine", 0.05),
  claim: () => {
    [523, 659, 784, 1047, 1319].forEach((f, i) => tone(f, i * 0.07, 0.5, "triangle", 0.1));
    tone(80, 0, 0.5, "sine", 0.3, 40);
    [1568, 2093].forEach((f, i) => tone(f, 0.45 + i * 0.08, 0.6, "sine", 0.05));
  },
};

export function buzz(pattern: number | number[]) {
  try {
    navigator.vibrate?.(pattern);
  } catch {
    // Vibration is optional; desktop browsers ignore it.
  }
}
