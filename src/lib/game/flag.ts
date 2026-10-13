/**
 * Generated player flags. A flag is a pure function of the player's public flag seed, so the
 * same seed draws the same flag on every device and in every build. Changing anything that
 * feeds the drawing (palette order, layout list, random draws) changes everyone's flag, so
 * add new options at the end of each list and keep the draw order stable.
 */

export const FLAG_WIDTH = 60;
export const FLAG_HEIGHT = 40;

export type FlagLayout = "plain" | "stripes-h" | "stripes-v" | "quarters" | "chevron" | "cross" | "diagonal" | "border";
export type FlagEmblem = "star" | "circle" | "diamond" | "leaf" | "ring";
/** 0 is fresh, 1 has flown a week, 2 has flown three weeks. */
export type FlagWeather = 0 | 1 | 2;

export type FlagSpec = {
  layout: FlagLayout;
  field: string;
  accent: string;
  emblem: FlagEmblem | null;
  emblemColor: string;
};

// Saturated colours with a dark outline read on the light basemap and on park fills,
// which are mostly greens and blues, so greens are left out.
export const FLAG_PALETTE = [
  "#D7263D", // red
  "#F46036", // orange
  "#FFC93C", // sun
  "#FFF8EC", // paper
  "#1B2A4A", // navy
  "#2E6FD8", // blue
  "#159A8C", // teal
  "#7A3FB0", // plum
  "#E2589B", // pink
  "#14231C", // ink
  "#9B2226", // maroon
] as const;

const LAYOUTS: readonly FlagLayout[] = ["plain", "stripes-h", "stripes-v", "quarters", "chevron", "cross", "diagonal", "border"];
const EMBLEMS: readonly FlagEmblem[] = ["star", "circle", "diamond", "leaf", "ring"];
const OUTLINE = "#14231C";
const BLEACH = "#CBBFA8";

/** FNV-1a: a small, stable string hash that behaves the same in every JavaScript engine. */
function hashSeed(seed: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** mulberry32: integer-only, so every device draws the same sequence. */
function random(seed: string): () => number {
  let state = hashSeed(seed);
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(next: () => number, values: readonly T[]): T {
  return values[Math.floor(next() * values.length)];
}

function channel(hex: string, offset: number): number {
  return parseInt(hex.slice(offset, offset + 2), 16);
}

function luminance(hex: string): number {
  const linear = [1, 3, 5].map((offset) => {
    const value = channel(hex, offset) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

export function contrast(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

function contrasting(next: () => number, against: string, minimum: number, avoid: readonly string[] = []): string {
  const options = FLAG_PALETTE.filter((color) => color !== against && !avoid.includes(color) && contrast(color, against) >= minimum);
  return options.length ? pick(next, options) : contrast("#FFF8EC", against) >= contrast(OUTLINE, against) ? "#FFF8EC" : OUTLINE;
}

type EmblemPlace = { x: number; y: number; r: number; background: "field" | "accent" } | null;

const EMBLEM_PLACES: Record<FlagLayout, EmblemPlace> = {
  plain: { x: 30, y: 20, r: 11, background: "field" },
  "stripes-h": { x: 30, y: 20, r: 6.5, background: "accent" },
  "stripes-v": { x: 30, y: 20, r: 9, background: "accent" },
  quarters: { x: 15, y: 10, r: 6, background: "field" },
  chevron: { x: 9, y: 20, r: 6, background: "accent" },
  cross: null,
  diagonal: { x: 15, y: 11, r: 6.5, background: "field" },
  border: { x: 30, y: 20, r: 9, background: "field" },
};

export function flagSpec(seed: string): FlagSpec {
  const next = random(seed);
  const layout = pick(next, LAYOUTS);
  const field = pick(next, FLAG_PALETTE);
  const accent = contrasting(next, field, 1.8);
  const place = EMBLEM_PLACES[layout];
  // Plain fields always carry an emblem so they never look like an empty flag.
  const hasEmblem = !!place && (layout === "plain" || next() < 0.7);
  const emblem = hasEmblem ? pick(next, EMBLEMS) : null;
  const behind = place?.background === "accent" ? accent : field;
  const emblemColor = hasEmblem ? contrasting(next, behind, 2.6, [behind === field ? accent : field]) : field;
  return { layout, field, accent, emblem, emblemColor };
}

/** Flags look worn after a week and tattered after three weeks on the same park. */
export function weatherForDays(days: number): FlagWeather {
  return days >= 21 ? 2 : days >= 7 ? 1 : 0;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** How long a flag has flown, in milliseconds, from its planting time to the server's clock. */
export function flagAgeMs(since: string, now: string | number | Date): number {
  const start = Date.parse(since);
  const end = now instanceof Date ? now.getTime() : typeof now === "number" ? now : Date.parse(now);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
  return Math.max(0, end - start);
}

/** Whole days a flag has flown, for weathering. */
export function flagAgeDays(since: string, now: string | number | Date): number {
  return Math.floor(flagAgeMs(since, now) / DAY_MS);
}

/** The age tag on a flag pin: minutes in its first hour, hours in its first day, then days. */
export function formatFlagAge(ageMs: number): string {
  const age = Number.isFinite(ageMs) ? Math.max(0, ageMs) : 0;
  if (age < HOUR_MS) return `${Math.floor(age / MINUTE_MS)}m`;
  if (age < DAY_MS) return `${Math.floor(age / HOUR_MS)}h`;
  return `${Math.floor(age / DAY_MS)}d`;
}

function mix(hex: string, toward: string, amount: number): string {
  if (amount <= 0) return hex;
  const value = [1, 3, 5].map((offset) => Math.round(channel(hex, offset) * (1 - amount) + channel(toward, offset) * amount));
  return `#${value.map((part) => part.toString(16).padStart(2, "0")).join("")}`.toUpperCase();
}

const n = (value: number) => Number(value.toFixed(2)).toString();

/** The flag's outline: a straight hoist, and a fly edge that frays with weather. */
export function flagOutline(weather: FlagWeather): string {
  if (weather === 0) return `0,0 ${FLAG_WIDTH},0 ${FLAG_WIDTH},${FLAG_HEIGHT} 0,${FLAG_HEIGHT}`;
  const teeth = weather === 1 ? 4 : 6;
  const depth = weather === 1 ? 3 : 7;
  const points = ["0,0", `${FLAG_WIDTH},0`];
  for (let tooth = 0; tooth < teeth; tooth += 1) {
    const top = (FLAG_HEIGHT / teeth) * tooth;
    // Alternate deep and shallow cuts so the edge looks torn rather than serrated.
    const cut = tooth % 2 === 0 ? depth : depth * 0.55;
    points.push(`${n(FLAG_WIDTH - cut)},${n(top + FLAG_HEIGHT / teeth / 2)}`, `${FLAG_WIDTH},${n(top + FLAG_HEIGHT / teeth)}`);
  }
  points.push(`0,${FLAG_HEIGHT}`);
  return points.join(" ");
}

function emblemShape(emblem: FlagEmblem, x: number, y: number, r: number, color: string, background: string): string {
  switch (emblem) {
    case "circle":
      return `<circle cx="${n(x)}" cy="${n(y)}" r="${n(r * 0.8)}" fill="${color}"/>`;
    case "ring":
      return `<circle cx="${n(x)}" cy="${n(y)}" r="${n(r * 0.68)}" fill="none" stroke="${color}" stroke-width="${n(r * 0.32)}"/>`;
    case "diamond":
      return `<polygon points="${n(x)},${n(y - r)} ${n(x + r * 0.75)},${n(y)} ${n(x)},${n(y + r)} ${n(x - r * 0.75)},${n(y)}" fill="${color}"/>`;
    case "leaf":
      return `<path d="M${n(x)} ${n(y - r)}Q${n(x + r)} ${n(y)} ${n(x)} ${n(y + r)}Q${n(x - r)} ${n(y)} ${n(x)} ${n(y - r)}Z" fill="${color}"/>`
        + `<path d="M${n(x)} ${n(y - r * 0.55)}V${n(y + r * 0.85)}" stroke="${background}" stroke-width="${n(Math.max(0.8, r * 0.14))}" stroke-linecap="round"/>`;
    case "star": {
      const points: string[] = [];
      for (let corner = 0; corner < 10; corner += 1) {
        const radius = corner % 2 === 0 ? r : r * 0.42;
        const angle = -Math.PI / 2 + (corner * Math.PI) / 5;
        points.push(`${n(x + Math.cos(angle) * radius)},${n(y + Math.sin(angle) * radius)}`);
      }
      return `<polygon points="${points.join(" ")}" fill="${color}"/>`;
    }
  }
}

function layoutShapes(spec: FlagSpec, field: string, accent: string): string {
  const W = FLAG_WIDTH;
  const H = FLAG_HEIGHT;
  const base = `<rect width="${W}" height="${H}" fill="${field}"/>`;
  switch (spec.layout) {
    case "plain":
      return base;
    case "stripes-h":
      return `${base}<rect y="12" width="${W}" height="16" fill="${accent}"/>`;
    case "stripes-v":
      return `${base}<rect x="18" width="24" height="${H}" fill="${accent}"/>`;
    case "quarters":
      return `${base}<rect x="30" width="30" height="20" fill="${accent}"/><rect y="20" width="30" height="20" fill="${accent}"/>`;
    case "chevron":
      return `${base}<polygon points="0,0 27,20 0,40" fill="${accent}"/>`;
    case "cross":
      return `${base}<rect x="16" width="8" height="${H}" fill="${accent}"/><rect y="16" width="${W}" height="8" fill="${accent}"/>`;
    case "diagonal":
      return `${base}<polygon points="${W},0 ${W},${H} 0,${H}" fill="${accent}"/>`;
    case "border":
      return `<rect width="${W}" height="${H}" fill="${accent}"/><rect x="5" y="5" width="${W - 10}" height="${H - 10}" fill="${field}"/>`;
  }
}

export type FlagSvgOptions = {
  weather?: FlagWeather;
  /** Unique per inline SVG on a page, so clip paths of different flags never collide. */
  idPrefix?: string;
};

/** The flag cloth as SVG markup with a 60 by 40 view box. Every value is generated, never user text. */
export function flagBody(seed: string, options: FlagSvgOptions = {}): string {
  const weather = options.weather ?? 0;
  const spec = flagSpec(seed);
  const fade = weather === 0 ? 0 : weather === 1 ? 0.18 : 0.38;
  const field = mix(spec.field, BLEACH, fade);
  const accent = mix(spec.accent, BLEACH, fade);
  const emblemColor = mix(spec.emblemColor, BLEACH, fade);
  const place = EMBLEM_PLACES[spec.layout];
  const behind = place?.background === "accent" ? accent : field;
  const emblem = spec.emblem && place ? emblemShape(spec.emblem, place.x, place.y, place.r, emblemColor, behind) : "";
  const outline = flagOutline(weather);
  const cloth = `${layoutShapes(spec, field, accent)}${emblem}`;
  const clipId = `${(options.idPrefix ?? "flag").replace(/[^A-Za-z0-9_-]/g, "")}-clip`;
  const clipped = weather === 0
    ? cloth
    : `<clipPath id="${clipId}"><polygon points="${outline}"/></clipPath><g clip-path="url(#${clipId})">${cloth}</g>`;
  return `${clipped}<polygon points="${outline}" fill="none" stroke="${OUTLINE}" stroke-width="1.6" stroke-linejoin="round"/>`;
}

export function flagSvg(seed: string, options: FlagSvgOptions = {}): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-1 -1 ${FLAG_WIDTH + 2} ${FLAG_HEIGHT + 2}" width="${FLAG_WIDTH + 2}" height="${FLAG_HEIGHT + 2}">${flagBody(seed, options)}</svg>`;
}

export const PIN_WIDTH = 48;
export const PIN_HEIGHT = 56;
/** Where the pole meets the ground, so the pin can stand exactly on the park's point. */
export const PIN_POLE_X = 8;

function escapeText(value: string): string {
  return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

/**
 * A flag on a pole for the map and park lists. `seed` null draws an empty, muted pole so
 * unclaimed parks read as open. `label` is a short age tag such as "12d".
 */
export function flagPinSvg(seed: string | null, options: FlagSvgOptions & { label?: string; scale?: number } = {}): string {
  const scale = options.scale ?? 1;
  const width = PIN_WIDTH * scale;
  const height = PIN_HEIGHT * scale;
  const shadow = `<ellipse cx="${PIN_POLE_X}" cy="53.5" rx="7" ry="2.5" fill="#14231C" fill-opacity="0.22"/>`;
  if (!seed) {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${PIN_WIDTH} ${PIN_HEIGHT}" width="${n(width)}" height="${n(height)}">${shadow}`
      + `<rect x="6.75" y="5" width="2.5" height="49" rx="1.25" fill="#7D8A82"/>`
      + `<rect x="10" y="6" width="30" height="20" rx="1.5" fill="#FFF8EC" fill-opacity="0.7" stroke="#5B6B62" stroke-width="1.5" stroke-dasharray="3.5 2.5"/>`
      + `<circle cx="${PIN_POLE_X}" cy="4.5" r="2.6" fill="#FFF8EC" stroke="#5B6B62" stroke-width="1.3"/></svg>`;
  }
  const label = options.label ? escapeText(options.label.slice(0, 6)) : "";
  const tagWidth = 8 + label.length * 6.4;
  const tag = label
    ? `<rect x="10.5" y="33" width="${n(tagWidth)}" height="13" rx="6.5" fill="#14231C"/>`
      + `<text x="${n(10.5 + tagWidth / 2)}" y="42.6" font-family="system-ui, sans-serif" font-size="10" font-weight="800" fill="#FFF8EC" text-anchor="middle">${label}</text>`
    : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${PIN_WIDTH} ${PIN_HEIGHT}" width="${n(width)}" height="${n(height)}">${shadow}`
    + `<rect x="6.5" y="4" width="3" height="50" rx="1.5" fill="#14231C"/>`
    + `<g transform="translate(9.5 5.5) scale(0.62)">${flagBody(seed, options)}</g>`
    + `${tag}<circle cx="${PIN_POLE_X}" cy="4" r="3" fill="#FFC93C" stroke="#14231C" stroke-width="1.3"/></svg>`;
}

/** The outline shown before a player has a flag: a dashed, empty cloth. */
export function blankFlagSvg(): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-1 -1 ${FLAG_WIDTH + 2} ${FLAG_HEIGHT + 2}" width="${FLAG_WIDTH + 2}" height="${FLAG_HEIGHT + 2}">`
    + `<rect width="${FLAG_WIDTH}" height="${FLAG_HEIGHT}" fill="#FFF8EC" fill-opacity="0.6" stroke="${OUTLINE}" stroke-width="1.6" stroke-dasharray="4 3"/></svg>`;
}
