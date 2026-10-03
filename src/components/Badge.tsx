import { memo, useId, type CSSProperties, type ReactNode } from "react";
import { PALETTES, RARITY, scenePath, type Park, type Palette, type Shape } from "../lib/parks";
import { useOptionalContent } from "../lib/content/provider";

export type BadgeState = "earned" | "preview" | "silhouette";

type Props = {
  park: Park;
  size?: number;
  state?: BadgeState;
  animated?: boolean;
  showName?: boolean;
  className?: string;
  style?: CSSProperties;
  // Overrides the scene URL, e.g. with a data URL for image export.
  sceneHref?: string;
  /** False keeps art that is not saved on this device from loading from the CDN. */
  remoteArt?: boolean;
};

const C = 100;

function scallop(points = 22, outer = 95, inner = 86) {
  let d = "";
  for (let i = 0; i < points; i++) {
    const a0 = (i / points) * Math.PI * 2 - Math.PI / 2;
    const a1 = ((i + 0.5) / points) * Math.PI * 2 - Math.PI / 2;
    const a2 = ((i + 1) / points) * Math.PI * 2 - Math.PI / 2;
    const p0 = [C + Math.cos(a0) * inner, C + Math.sin(a0) * inner];
    const p1 = [C + Math.cos(a1) * outer * 1.04, C + Math.sin(a1) * outer * 1.04];
    const p2 = [C + Math.cos(a2) * inner, C + Math.sin(a2) * inner];
    d += `${i === 0 ? `M${p0[0].toFixed(1)} ${p0[1].toFixed(1)}` : ""} Q${p1[0].toFixed(1)} ${p1[1].toFixed(1)} ${p2[0].toFixed(1)} ${p2[1].toFixed(1)}`;
  }
  return d + "Z";
}

function hex() {
  const pts = Array.from({ length: 6 }, (_, i) => {
    const a = (i / 6) * Math.PI * 2 - Math.PI / 2;
    return `${(C + Math.cos(a) * 96).toFixed(1)} ${(C + Math.sin(a) * 96).toFixed(1)}`;
  });
  return `M${pts.join(" L")}Z`;
}

const SHAPES: Record<Shape, string> = {
  circle: "M100 6 A94 94 0 1 1 99.9 6Z",
  hex: hex(),
  shield: "M100 5 C130 16 160 17 186 11 C194 88 178 152 100 196 C22 152 6 88 14 11 C40 17 70 16 100 5Z",
  arch: "M14 186 Q14 196 24 196 L176 196 Q186 196 186 186 L186 92 A86 86 0 0 0 14 92Z",
  seal: scallop(),
};

const RIM: Record<string, string[]> = {
  common: ["#FFF8EC", "#FFF8EC"],
  uncommon: ["#BDEBFF", "#7FD3F7"],
  rare: ["#F3F5FF", "#A9B3D6"],
  epic: ["#FF9BD0", "#9B7BFF"],
  legendary: ["#FFF1A8", "#E9A800"],
};

function Star({ x, y, r, fill }: { x: number; y: number; r: number; fill: string }) {
  const pts = Array.from({ length: 10 }, (_, i) => {
    const a = (i / 10) * Math.PI * 2 - Math.PI / 2;
    const rr = i % 2 ? r * 0.45 : r;
    return `${(x + Math.cos(a) * rr).toFixed(1)},${(y + Math.sin(a) * rr).toFixed(1)}`;
  });
  return <polygon points={pts.join(" ")} fill={fill} stroke="#14231C" strokeWidth={1.6} strokeLinejoin="round" />;
}

function Ribbon({ text, p }: { text: string; p: Palette }) {
  const upper = text.toUpperCase();
  const size = Math.max(9.5, Math.min(17, 190 / Math.max(upper.length, 1) + 1.2));
  const fit = upper.length > 13;
  return (
    <g>
      <path d="M2 150 L26 146 L26 178 L2 182 L12 166Z" fill={p.ribbon} stroke="#14231C" strokeWidth={2.5} strokeLinejoin="round" />
      <path d="M198 150 L174 146 L174 178 L198 182 L188 166Z" fill={p.ribbon} stroke="#14231C" strokeWidth={2.5} strokeLinejoin="round" />
      <path d="M18 142 Q100 128 182 142 L182 174 Q100 160 18 174Z" fill={p.ribbon} stroke="#14231C" strokeWidth={2.5} strokeLinejoin="round" />
      <text x={100} y={156} fontFamily="'Bricolage Grotesque Variable', system-ui" fontWeight={800} fontSize={size} fill={p.ribbonText} letterSpacing={0.4} textAnchor="middle" dominantBaseline="middle" {...(fit ? { textLength: 138, lengthAdjust: "spacingAndGlyphs" } : {})}>
        {upper}
      </text>
    </g>
  );
}

const MYSTERY_PALETTE: Palette = { ...PALETTES.forest, ribbon: "#8A8F87", ribbonText: "#FFF8EC" };

// Placeholder for parks whose badge art isn't made yet.
function Mystery({ label }: { label: string }) {
  return (
    <g>
      <rect x={-10} y={-10} width={220} height={220} fill="#EDE3CF" />
      {Array.from({ length: 11 }, (_, r) =>
        Array.from({ length: 11 }, (_, c) => <circle key={`${r}-${c}`} cx={c * 20 + (r % 2) * 10} cy={r * 20} r={1.6} fill="#14231C" opacity={0.12} />),
      )}
      <text x={100} y={112} textAnchor="middle" fontFamily="'Bricolage Grotesque Variable', system-ui" fontWeight={800} fontSize={88} fill="#14231C" opacity={0.22}>
        ?
      </text>
      <text x={100} y={36} textAnchor="middle" fontFamily="'Bricolage Grotesque Variable', system-ui" fontWeight={800} fontSize={12} letterSpacing={2} fill="#14231C" opacity={0.45}>
        {label}
      </text>
    </g>
  );
}

function BadgeImpl({ park, size = 120, state = "earned", animated = false, showName = true, className, style, sceneHref, remoteArt = true }: Props) {
  const content = useOptionalContent();
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "");
  const live = park.scene !== null;
  const resolvedSceneHref = sceneHref ?? (park.scene
    ? content?.assetUrls.get(scenePath(park.scene)) ?? content?.retainedSceneUrls.get(park.id) ?? (remoteArt ? content?.remoteSceneUrls?.get(scenePath(park.scene)) : undefined)
    : undefined);
  const p = live ? PALETTES[park.biome] : MYSTERY_PALETTE;
  const shape = SHAPES[park.shape];
  const rim = RIM[park.rarity];
  const stars = RARITY[park.rarity].stars;
  const shiny = live && state === "earned" && (park.rarity === "rare" || park.rarity === "epic" || park.rarity === "legendary");

  const defs: ReactNode = (
    <defs>
      <clipPath id={`c${uid}`}>
        <path d={shape} />
      </clipPath>
      <linearGradient id={`r${uid}`} x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stopColor={rim[0]} />
        <stop offset="0.5" stopColor={rim[1]} />
        <stop offset="1" stopColor={rim[0]} />
      </linearGradient>
      <linearGradient id={`h${uid}`} x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stopColor="#FF6BD6" />
        <stop offset="0.25" stopColor="#FFE66B" />
        <stop offset="0.5" stopColor="#6BFFB8" />
        <stop offset="0.75" stopColor="#6BB8FF" />
        <stop offset="1" stopColor="#C86BFF" />
      </linearGradient>
      <pattern id={`p${uid}`} width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(35)">
        <rect width="4" height="1.3" fill="#FFFFFF" opacity="0.09" />
      </pattern>
      <radialGradient id={`v${uid}`} cx="0.5" cy="0.42" r="0.62">
        <stop offset="0.62" stopColor="#14231C" stopOpacity="0" />
        <stop offset="1" stopColor="#14231C" stopOpacity="0.28" />
      </radialGradient>
      <linearGradient id={`g${uid}`} x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stopColor="#FFFFFF" stopOpacity="0" />
        <stop offset="0.5" stopColor="#FFFFFF" stopOpacity="0.85" />
        <stop offset="1" stopColor="#FFFFFF" stopOpacity="0" />
      </linearGradient>
    </defs>
  );

  return (
    <svg
      viewBox="-4 -4 208 208"
      width={size}
      height={size}
      className={`badge badge--${state} ${className ?? ""}`}
      style={style}
      role="img"
      aria-label={`${park.short} badge`}
    >
      {defs}
      <path d={shape} fill={`url(#r${uid})`} stroke="#14231C" strokeWidth={4} transform="translate(0 3)" opacity={0.25} />
      <g clipPath={`url(#c${uid})`}>
        {park.scene && resolvedSceneHref ? (
          <image href={resolvedSceneHref} x={-4} y={-4} width={208} height={208} preserveAspectRatio="xMidYMid slice" />
        ) : (
          <Mystery label={live ? "ART PENDING" : "COMING SOON"} />
        )}
        <rect x={-10} y={-10} width={220} height={220} fill={`url(#p${uid})`} />
        <rect x={-10} y={-10} width={220} height={220} fill={`url(#v${uid})`} />
        {shiny && (
          <rect x={-60} y={-60} width={320} height={320} fill={`url(#h${uid})`} className="badge__holo" style={{ mixBlendMode: "soft-light" }} />
        )}
        {live && state === "earned" && (
          <g transform="rotate(20 100 100)">
            <rect x={-120} y={-40} width={60} height={280} fill={`url(#g${uid})`} className="badge__shine" style={{ animationDelay: `${(park.seed % 40) / 10}s` }} />
          </g>
        )}
      </g>
      <path d={shape} fill="none" stroke={`url(#r${uid})`} strokeWidth={10} />
      <path d={shape} fill="none" stroke="#14231C" strokeWidth={3} />
      <path d={shape} fill="none" stroke="#FFFFFF" strokeOpacity={0.75} strokeWidth={1.6} strokeDasharray="4 3.2" transform="translate(100 100) scale(0.9) translate(-100 -100)" />
      <g>
        {Array.from({ length: stars }, (_, i) => (
          <Star
            key={i}
            x={100 + (i - (stars - 1) / 2) * 15}
            y={live ? (park.shape === "arch" ? 30 : 26) : 20}
            r={live ? 6.5 : 4.5}
            fill="#FFD23F"
          />
        ))}
      </g>
      {showName && <Ribbon text={park.short} p={p} />}
    </svg>
  );
}

export const Badge = memo(BadgeImpl);
