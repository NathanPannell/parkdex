import { memo, useId, type CSSProperties, type ReactNode } from "react";
import { PALETTES, RARITY, rng, type Park, type Palette, type Shape } from "../lib/parks";

export type BadgeState = "earned" | "preview" | "silhouette";

type Props = {
  park: Park;
  size?: number;
  state?: BadgeState;
  animated?: boolean;
  showName?: boolean;
  className?: string;
  style?: CSSProperties;
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

function ridge(rand: () => number, base: number, amp: number, count: number, smooth = true) {
  const pts: [number, number][] = [];
  for (let i = 0; i <= count; i++) pts.push([(i / count) * 220 - 10, base - rand() * amp]);
  let d = `M-10 210 L${pts[0][0]} ${pts[0][1]}`;
  for (let i = 1; i < pts.length; i++) {
    if (smooth) {
      const mx = (pts[i - 1][0] + pts[i][0]) / 2;
      const my = (pts[i - 1][1] + pts[i][1]) / 2;
      d += ` Q${pts[i - 1][0]} ${pts[i - 1][1]} ${mx} ${my}`;
    } else d += ` L${pts[i][0]} ${pts[i][1]}`;
  }
  return d + ` L210 ${pts[pts.length - 1][1]} L210 210Z`;
}

function Pine({ x, y, h, color }: { x: number; y: number; h: number; color: string }) {
  const w = h * 0.55;
  return (
    <g>
      <path d={`M${x} ${y - h} L${x + w * 0.42} ${y - h * 0.48} L${x - w * 0.42} ${y - h * 0.48}Z`} fill={color} />
      <path d={`M${x} ${y - h * 0.72} L${x + w * 0.5} ${y - h * 0.08} L${x - w * 0.5} ${y - h * 0.08}Z`} fill={color} />
      <rect x={x - 1.4} y={y - h * 0.1} width={2.8} height={h * 0.14} fill={color} />
    </g>
  );
}

function Forest({ rand, color, base, count, min, max }: { rand: () => number; color: string; base: number; count: number; min: number; max: number }) {
  const trees = Array.from({ length: count }, () => ({ x: rand() * 200, h: min + rand() * (max - min), dy: rand() * 8 }));
  return <g>{trees.sort((a, b) => a.dy - b.dy).map((t, i) => <Pine key={i} x={t.x} y={base + t.dy} h={t.h} color={color} />)}</g>;
}

function Waves({ y, color, animated, count = 3 }: { y: number; color: string; animated?: boolean; count?: number }) {
  return (
    <g>
      {Array.from({ length: count }, (_, i) => {
        const yy = y + i * 9;
        const d = Array.from({ length: 12 }, (_, k) => `q6 ${k % 2 ? 4 : -4} 12 0`).join(" ");
        return (
          <path key={i} d={`M${-20 + i * 7} ${yy} ${d}`} fill="none" stroke={color} strokeWidth={2.2} strokeLinecap="round" opacity={0.75 - i * 0.18}>
            {animated && <animateTransform attributeName="transform" type="translate" values={`0 0; ${i % 2 ? -6 : 6} 0; 0 0`} dur={`${3 + i}s`} repeatCount="indefinite" />}
          </path>
        );
      })}
    </g>
  );
}

function Scene({ park, p, animated }: { park: Park; p: Palette; animated?: boolean }) {
  const rand = rng(park.seed + 7);
  switch (park.biome) {
    case "coast": {
      const lighthouse = park.seed % 3 === 0;
      return (
        <g>
          <path d={ridge(rand, 112, 26, 5)} fill={p.far} />
          <rect x={-10} y={116} width={220} height={100} fill={p.water} />
          <Waves y={128} color="#FFFFFF" animated={animated} />
          <path d={`M-10 210 L-10 ${168 + rand() * 6} Q60 ${150 + rand() * 10} 120 172 T210 ${160 + rand() * 8} L210 210Z`} fill={p.near} />
          {lighthouse ? (
            <g transform={`translate(${128 + rand() * 30} 0)`}>
              <path d="M0 150 L4 104 L14 104 L18 150Z" fill="#FFF8EC" />
              <path d="M2 136 L16 136 L17 144 L1 144Z M3 118 L15 118 L15.6 126 L2.4 126Z" fill={p.accent} />
              <rect x={2} y={96} width={14} height={9} rx={2} fill="#1A2B28" />
              <path d="M9 86 L17 96 L1 96Z" fill={p.accent} />
              <circle cx={9} cy={100} r={3.2} fill="#FFE27A">
                {animated && <animate attributeName="opacity" values="1;.2;1" dur="2s" repeatCount="indefinite" />}
              </circle>
            </g>
          ) : (
            <g fill={p.mid}>
              <path d={`M${130 + rand() * 20} 150 L${136 + rand() * 20} 110 Q150 100 158 114 L166 150Z`} />
              <path d={`M${40 + rand() * 20} 148 L${48 + rand() * 10} 124 Q56 118 62 128 L68 148Z`} opacity={0.85} />
            </g>
          )}
          <path d="M60 70 q5 -5 10 0 q5 -5 10 0" fill="none" stroke="#1A2B28" strokeWidth={2} strokeLinecap="round" opacity={0.55} />
        </g>
      );
    }
    case "mountain": {
      const peaks = [60 + rand() * 20, 125 + rand() * 25];
      return (
        <g>
          <path d={ridge(rand, 120, 30, 6, false)} fill={p.far} />
          {peaks.map((x, i) => {
            const top = 42 + i * 16 + rand() * 10;
            const w = 70 - i * 8;
            return (
              <g key={i}>
                <path d={`M${x - w} 170 L${x} ${top} L${x + w} 170Z`} fill={i ? p.mid : p.near} />
                <path d={`M${x - 14} ${top + 18} L${x} ${top} L${x + 14} ${top + 18} L${x + 7} ${top + 13} L${x} ${top + 20} L${x - 6} ${top + 13}Z`} fill="#FFFFFF" />
              </g>
            );
          })}
          <path d={ridge(rand, 160, 10, 4)} fill="#2C7F57" />
          <Forest rand={rand} color="#1C5B43" base={176} count={9} min={16} max={30} />
        </g>
      );
    }
    case "lake": {
      return (
        <g>
          <path d={ridge(rand, 108, 26, 5)} fill={p.far} />
          <path d={ridge(rand, 124, 16, 6)} fill={p.mid} />
          <Forest rand={rand} color={p.near} base={130} count={10} min={12} max={24} />
          <rect x={-10} y={128} width={220} height={90} fill={p.water} />
          <Waves y={146} color="#FFFFFF" animated={animated} count={2} />
          <g transform={`translate(${70 + rand() * 50} 162)`}>
            <path d="M-20 0 Q0 9 20 0 Q0 4 -20 0Z" fill={p.accent} />
            <path d="M-3 -1 L-1 -14 M4 -1 L2 -12" stroke="#1A2B28" strokeWidth={2} strokeLinecap="round" />
            {animated && <animateTransform attributeName="transform" type="translate" additive="sum" values="0 0; 0 -1.5; 0 0" dur="2.4s" repeatCount="indefinite" />}
          </g>
          <path d="M-10 210 L-10 186 Q50 176 100 190 T210 182 L210 210Z" fill={p.near} />
        </g>
      );
    }
    case "waterfall": {
      return (
        <g>
          <path d={ridge(rand, 90, 20, 4)} fill={p.far} />
          <path d="M-10 210 L-10 60 Q30 50 70 64 L76 210Z" fill={p.mid} />
          <path d="M210 210 L210 70 Q170 56 128 68 L122 210Z" fill={p.near} />
          <rect x={74} y={62} width={52} height={120} fill={p.water} />
          {[80, 90, 100, 110, 118].map((x, i) => (
            <path key={x} d={`M${x} 60 L${x} 180`} stroke={i % 2 ? "#FFFFFF" : p.accent} strokeWidth={i % 2 ? 3 : 2} strokeDasharray="14 10" opacity={0.85} strokeLinecap="round">
              {animated && <animate attributeName="stroke-dashoffset" values="0;-48" dur={`${0.9 + i * 0.12}s`} repeatCount="indefinite" />}
            </path>
          ))}
          <ellipse cx={100} cy={184} rx={70} ry={16} fill={p.accent} opacity={0.6} />
          {[70, 100, 128].map((x) => (
            <circle key={x} cx={x} cy={178} r={8} fill="#FFFFFF" opacity={0.9} />
          ))}
          <Forest rand={rand} color="#1C5B43" base={70} count={4} min={14} max={22} />
        </g>
      );
    }
    case "river": {
      return (
        <g>
          <path d={ridge(rand, 104, 22, 5)} fill={p.far} />
          <path d={ridge(rand, 128, 18, 6)} fill={p.mid} />
          <path d={`M92 116 C70 140 140 150 104 172 S40 196 70 214 L140 214 C110 194 170 176 130 160 S104 132 108 116Z`} fill={p.water} />
          <path d="M100 128 q-6 8 4 14 M112 160 q-10 6 -2 12 M86 186 q-8 6 2 12" stroke="#FFFFFF" strokeWidth={2} fill="none" strokeLinecap="round" opacity={0.8}>
            {animated && <animate attributeName="opacity" values=".8;.3;.8" dur="1.8s" repeatCount="indefinite" />}
          </path>
          <Forest rand={rand} color={p.near} base={178} count={5} min={20} max={34} />
        </g>
      );
    }
    case "cave": {
      return (
        <g>
          {Array.from({ length: 14 }, (_, i) => (
            <circle key={i} cx={rand() * 200} cy={rand() * 80 + 20} r={rand() * 1.4 + 0.5} fill="#FFFFFF">
              {animated && <animate attributeName="opacity" values="1;.2;1" dur={`${1.5 + rand() * 2}s`} repeatCount="indefinite" />}
            </circle>
          ))}
          <path d={ridge(rand, 112, 30, 5, false)} fill={p.far} />
          <path d="M-10 210 L-10 120 Q100 70 210 120 L210 210Z" fill={p.near} />
          <path d="M52 210 L52 168 Q100 96 148 168 L148 210Z" fill="#150F33" />
          {[70, 88, 112, 128].map((x, i) => (
            <path key={x} d={`M${x} ${150 - i * 3} l4 ${10 + (i % 2) * 6} l-8 0Z`} transform={`rotate(180 ${x} ${150 - i * 3})`} fill={p.mid} />
          ))}
          {[[80, 196, 14], [100, 200, 20], [120, 196, 12]].map(([x, y, h], i) => (
            <path key={i} d={`M${x} ${y - h} L${x + 6} ${y} L${x - 6} ${y}Z`} fill={i === 1 ? p.accent : p.water}>
              {animated && <animate attributeName="opacity" values="1;.55;1" dur={`${1.2 + i * 0.4}s`} repeatCount="indefinite" />}
            </path>
          ))}
        </g>
      );
    }
    case "marsh": {
      return (
        <g>
          <path d={ridge(rand, 118, 16, 5)} fill={p.far} />
          <rect x={-10} y={130} width={220} height={90} fill={p.water} />
          <Waves y={150} color="#FFFFFF" animated={animated} count={2} />
          {Array.from({ length: 11 }, (_, i) => {
            const x = 8 + i * 18 + rand() * 8;
            const h = 36 + rand() * 30;
            return (
              <g key={i}>
                <path d={`M${x} 200 Q${x + 3} ${200 - h / 2} ${x + 1} ${200 - h}`} stroke={p.near} strokeWidth={2.4} fill="none" strokeLinecap="round" />
                {i % 2 === 0 && <rect x={x - 2} y={200 - h} width={6} height={13} rx={3} fill="#8C4A2F" />}
              </g>
            );
          })}
          <path d="M140 118 q4 -12 12 -12 q-2 6 2 10 l-4 18 M150 134 l-4 20 M154 134 l4 20" stroke="#3A4A6B" strokeWidth={3} fill="none" strokeLinecap="round" />
        </g>
      );
    }
    case "heritage": {
      return (
        <g>
          <path d={ridge(rand, 104, 22, 5)} fill={p.far} />
          <path d="M-10 210 L-10 116 Q60 96 130 110 Q180 118 210 106 L210 210Z" fill={p.mid} />
          <g stroke={p.accent} strokeWidth={3} fill="none" strokeLinecap="round" opacity={0.95}>
            <path d="M100 150 m-3 0 a3 3 0 1 1 6 0 a7 7 0 1 1 -14 0 a11 11 0 1 1 22 0 a15 15 0 1 1 -30 0" />
            <path d="M52 140 l0 18 M44 146 l16 0 M46 158 l6 -6 l6 6" />
            <path d="M144 136 q8 -6 16 0 q-8 6 -16 0 M150 136 l0 22 M144 150 l12 0" />
          </g>
          <path d="M-10 210 L-10 186 Q60 176 110 190 T210 184 L210 210Z" fill={p.near} />
        </g>
      );
    }
    default: {
      return (
        <g>
          <path d={ridge(rand, 104, 26, 5)} fill={p.far} />
          <Forest rand={rand} color={p.mid} base={140} count={14} min={24} max={40} />
          <path d={ridge(rand, 160, 12, 4)} fill={p.near} />
          <Forest rand={rand} color={p.near} base={196} count={8} min={34} max={54} />
          <g transform={`translate(${60 + rand() * 80} 178)`}>
            <path d="M-10 0 Q0 -16 10 0Z" fill="#FF5C5C" />
            <circle cx={-4} cy={-6} r={1.6} fill="#FFF" />
            <circle cx={4} cy={-4} r={1.3} fill="#FFF" />
            <rect x={-2.5} y={0} width={5} height={8} rx={2} fill="#FFF8EC" />
          </g>
        </g>
      );
    }
  }
}

function Clouds({ seed, animated }: { seed: number; animated?: boolean }) {
  const r = rng(seed + 31);
  const clouds = [
    { x: 20 + r() * 40, y: 44 + r() * 14, s: 0.8 + r() * 0.3 },
    { x: 120 + r() * 50, y: 34 + r() * 20, s: 0.6 + r() * 0.3 },
  ];
  return (
    <g>
      {clouds.map((c, i) => (
        <g key={i} transform={`translate(${c.x} ${c.y}) scale(${c.s})`}>
          <g>
            <path d="M-22 6 a10 10 0 0 1 8 -14 a14 14 0 0 1 26 -2 a10 10 0 0 1 14 10 a6 6 0 0 1 0 6Z" fill="#FFFFFF" opacity={0.92} />
            <path d="M-22 6 L26 6" stroke="#14231C" strokeOpacity={0.08} strokeWidth={3} />
            {animated && <animateTransform attributeName="transform" type="translate" values={`0 0; ${i ? -8 : 8} 0; 0 0`} dur={`${9 + i * 3}s`} repeatCount="indefinite" />}
          </g>
        </g>
      ))}
    </g>
  );
}

function Star({ x, y, r, fill }: { x: number; y: number; r: number; fill: string }) {
  const pts = Array.from({ length: 10 }, (_, i) => {
    const a = (i / 10) * Math.PI * 2 - Math.PI / 2;
    const rr = i % 2 ? r * 0.45 : r;
    return `${(x + Math.cos(a) * rr).toFixed(1)},${(y + Math.sin(a) * rr).toFixed(1)}`;
  });
  return <polygon points={pts.join(" ")} fill={fill} stroke="#14231C" strokeWidth={1.6} strokeLinejoin="round" />;
}

function Ribbon({ text, p, id }: { text: string; p: Palette; id: string }) {
  const upper = text.toUpperCase();
  const size = Math.max(9.5, Math.min(17, 190 / Math.max(upper.length, 1) + 1.2));
  const fit = upper.length > 13;
  return (
    <g>
      <path d="M2 150 L26 146 L26 178 L2 182 L12 166Z" fill={p.ribbon} stroke="#14231C" strokeWidth={2.5} strokeLinejoin="round" />
      <path d="M198 150 L174 146 L174 178 L198 182 L188 166Z" fill={p.ribbon} stroke="#14231C" strokeWidth={2.5} strokeLinejoin="round" />
      <path d="M18 142 Q100 128 182 142 L182 174 Q100 160 18 174Z" fill={p.ribbon} stroke="#14231C" strokeWidth={2.5} strokeLinejoin="round" />
      <path id={id} d="M26 163 Q100 149 174 163" fill="none" />
      <text fontFamily="'Bricolage Grotesque Variable', system-ui" fontWeight={800} fontSize={size} fill={p.ribbonText} letterSpacing={0.4} textAnchor="middle" dominantBaseline="middle">
        <textPath href={`#${id}`} startOffset="50%" {...(fit ? { textLength: 138, lengthAdjust: "spacingAndGlyphs" } : {})}>
          {upper}
        </textPath>
      </text>
    </g>
  );
}

function BadgeImpl({ park, size = 120, state = "earned", animated = false, showName = true, className, style }: Props) {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "");
  const p = PALETTES[park.biome];
  const shape = SHAPES[park.shape];
  const rim = RIM[park.rarity];
  const stars = RARITY[park.rarity].stars;
  const shiny = state === "earned" && (park.rarity === "rare" || park.rarity === "epic" || park.rarity === "legendary");
  const sunX = 50 + (park.seed % 100);

  const defs: ReactNode = (
    <defs>
      <clipPath id={`c${uid}`}>
        <path d={shape} />
      </clipPath>
      <linearGradient id={`s${uid}`} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor={p.skyTop} />
        <stop offset="1" stopColor={p.skyBottom} />
      </linearGradient>
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
        <rect x={-10} y={-10} width={220} height={220} fill={`url(#s${uid})`} />
        {park.rarity === "legendary" && (
          <g opacity={0.18}>
            {Array.from({ length: 12 }, (_, i) => (
              <path key={i} d="M100 70 L96 -40 L104 -40Z" fill="#FFFFFF" transform={`rotate(${i * 30} 100 70)`} />
            ))}
            {animated && <animateTransform attributeName="transform" type="rotate" from="0 100 70" to="360 100 70" dur="24s" repeatCount="indefinite" />}
          </g>
        )}
        {park.biome !== "cave" && (
          <g>
            <circle cx={sunX} cy={62} r={27} fill={p.sun} opacity={0.35} />
            <circle cx={sunX} cy={62} r={17} fill={p.sun} />
          </g>
        )}
        {park.biome !== "cave" && <Clouds seed={park.seed} animated={animated} />}
        <Scene park={park} p={p} animated={animated} />
        <rect x={-10} y={-10} width={220} height={220} fill={`url(#p${uid})`} />
        <rect x={-10} y={-10} width={220} height={220} fill={`url(#v${uid})`} />
        {shiny && (
          <rect x={-60} y={-60} width={320} height={320} fill={`url(#h${uid})`} className="badge__holo" style={{ mixBlendMode: "soft-light" }} />
        )}
        {state === "earned" && (
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
          <Star key={i} x={100 + (i - (stars - 1) / 2) * 15} y={park.shape === "arch" ? 30 : 26} r={6.5} fill={i < stars ? "#FFD23F" : "#FFF"} />
        ))}
      </g>
      {showName && <Ribbon text={park.short} p={p} id={`t${uid}`} />}
    </svg>
  );
}

export const Badge = memo(BadgeImpl);
