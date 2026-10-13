import type { CSSProperties } from "react";

const PATHS = {
  map: "M9 4 3 6.5v13.5l6-2.5 6 2.5 6-2.5V4l-6 2.5L9 4Zm0 0v13.5m6-11v13.5",
  case: "M4 5h16v14H4zM4 12h16M9 5v14M15 5v14",
  camera: "M4 8h3l2-3h6l2 3h3v11H4V8Zm8 9a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z",
  share: "M12 3v12M7 8l5-5 5 5M5 13v7h14v-7",
  close: "M6 6l12 12M18 6 6 18",
  search: "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14Zm5-2 4.5 4.5",
  back: "M15 5l-7 7 7 7",
  next: "M9 5l7 7-7 7",
  pin: "M12 21s7-6.2 7-12a7 7 0 1 0-14 0c0 5.8 7 12 7 12Zm0-9a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z",
  walk: "M13 4a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3ZM10 22l2-7 3 3v6M8 12l2-4 4 1 2 4 3 1M12 15l-1-5",
  car: "M5 16v3M19 16v3M3 16h18v-4l-2-5H5l-2 5v4ZM3 12h18M7 14h.01M17 14h.01",
  locate: "M12 2v3m0 14v3M2 12h3m14 0h3M12 18a6 6 0 1 0 0-12 6 6 0 0 0 0 12Zm0-4a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z",
  sound: "M4 9h4l5-4v14l-5-4H4V9Zm12 0a4 4 0 0 1 0 6m2.5-9a8 8 0 0 1 0 12",
  mute: "M4 9h4l5-4v14l-5-4H4V9Zm12.5 1.5 5 5m0-5-5 5",
  check: "M5 12.5 10 17 19 7",
  lock: "M7 10V7a5 5 0 0 1 10 0v3M5 10h14v11H5zM12 14v3",
  sparkle: "M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M18 6l-2.5 2.5M8.5 15.5 6 18",
  download: "M12 4v11M7 10l5 5 5-5M5 20h14",
  menu: "M4 7h16M4 12h16M4 17h16",
  gear: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm7.4-3c0-.4 0-.8-.1-1.2l2-1.6-2-3.4-2.4 1a7.5 7.5 0 0 0-2-1.2L14.5 3h-5l-.4 2.6a7.5 7.5 0 0 0-2 1.2l-2.4-1-2 3.4 2 1.6a7.4 7.4 0 0 0 0 2.4l-2 1.6 2 3.4 2.4-1a7.5 7.5 0 0 0 2 1.2l.4 2.6h5l.4-2.6a7.5 7.5 0 0 0 2-1.2l2.4 1 2-3.4-2-1.6c.1-.4.1-.8.1-1.2Z",
  link: "M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1",
  flip: "M4 8a8 8 0 0 1 14-3l2 2M20 16a8 8 0 0 1-14 3l-2-2M20 3v4h-4M4 21v-4h4",
  route: "M6 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4Zm12-10a2 2 0 1 0 0-4 2 2 0 0 0 0 4ZM6 15V9a3 3 0 0 1 3-3h3M18 9v6a3 3 0 0 1-3 3h-3",
  play: "M7 4.5v15l12-7.5-12-7.5Z",
  compass: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm3.5-12.5-2 5-5 2 2-5 5-2Z",
  book: "M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2V5Zm0 16a2 2 0 0 1 2-2h13v2",
  wand: "M4 20 16 8m-2-2 4 4M18 3v3m-1.5-1.5h3M20 9v2m-1-1h2M12 3v2m-1-1h2",
  refresh: "M4 12a8 8 0 0 1 14-5.3L20 9M20 4v5h-5M20 12a8 8 0 0 1-14 5.3L4 15m0 5v-5h5",
  chat: "M4 5h16v11H9l-5 4V5Zm4 5h.01M12 10h.01M16 10h.01",
  bug: "M8 10a4 4 0 0 1 8 0v4a4 4 0 0 1-8 0v-4Zm4 0v8M3 13h5m8 0h5M5 8l3 2m11-2-3 2M5 19l3-2m11 2-3-2M9.5 6.5 8 4m6.5 2.5L16 4",
  bulb: "M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3Z",
  image: "M4 5h16v14H4V5Zm0 11 5-5 4 4 3-3 4 4M15.5 9.5h.01",
  // Feedback: a speech bubble with a pencil line, so it reads as "write to us".
  feedback: "M4 5h16v11H9l-5 4V5Zm4.5 7.5 1-3 4.5-4.5 2 2-4.5 4.5-3 1Z",
  megaphone: "M3 10v4h3l8 4V6l-8 4H3Zm14-1a4 4 0 0 1 0 6m-10 0 1.5 5h3L12 16",
  // Propose a park: a map pin with a plus.
  pinPlus: "M12 21s7-6.2 7-12a7 7 0 1 0-14 0c0 5.8 7 12 7 12Zm0-14.5v5m-2.5-2.5h5",
  flagPlus: "M5 21V4h10l-1.5 3.5L15 11H5m13 3v6m-3-3h6",
  flag: "M5 21V4h13l-2.5 4 2.5 4H5",
  trophy: "M8 4h8v5a4 4 0 0 1-8 0V4Zm0 1.5H4.5A3.5 3.5 0 0 0 8 10m8-4.5h3.5A3.5 3.5 0 0 1 16 10m-4 3v4m-4 3.5h8m-6-3.5h4",
  draw: "M4 18c3-5 6 1 9-4s4-7 7-6M15 5l4 4",
  // Crews (#171): the protected hour, and a crew code to scan.
  shield: "M12 3 5 6v5c0 4.5 3 8.3 7 10 4-1.7 7-5.5 7-10V6l-7-3Zm-3 9 2 2 4-4.5",
  qr: "M4 4h6v6H4V4Zm10 0h6v6h-6V4ZM4 14h6v6H4v-6Zm10 0h2v2h-2v-2Zm4 0h2v2h-2v-2Zm-4 4h2v2h-2v-2Zm4 0h2v2h-2v-2Z",
  // Park area: the four corners of a square, like a "fit to screen" glyph.
  corners: "M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5",
  coast: "M3 9c2-2 4-2 6 0s4 2 6 0 4-2 6 0M3 15c2-2 4-2 6 0s4 2 6 0 4-2 6 0",
  forest: "M12 3 6 11h3l-4 6h14l-4-6h3L12 3Zm0 14v4",
  mountain: "M3 20 9.5 8l4 7 2.5-4 5 9H3Zm4.5-8.5 2 1.5 2-1.5",
  lake: "M4 14c0-3 3.6-5 8-5s8 2 8 5-3.6 5-8 5-8-2-8-5Zm4 0c1.3-.8 2.7-.8 4 0s2.7.8 4 0",
  waterfall: "M5 4h14M8 4v8M12 4v12M16 4v8M4 20c2.5-2 5.5-2 8 0s5.5 2 8 0",
  river: "M7 3c-3 4 5 6 2 10s4 6 2 8M15 3c-3 4 5 6 2 10s4 6 2 8",
  cave: "M3 20c0-8 4-15 9-15s9 7 9 15H3Zm6 0c0-4 1.3-7 3-7s3 3 3 7",
  marsh: "M4 20h16M8 20V10M12 20V6M16 20V11M8 10c-1.2-1-1.2-3 0-4 1.2 1 1.2 3 0 4Zm4-4c-1.2-1-1.2-3 0-4 1.2 1 1.2 3 0 4Zm4 5c-1.2-1-1.2-3 0-4 1.2 1 1.2 3 0 4Z",
  heritage: "M3 9 12 4l9 5H3Zm2 0v9m4.7-9v9m4.6-9v9M19 9v9M3 20h18",
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 22, stroke = 2.4, style }: { name: IconName; size?: number; stroke?: number; style?: CSSProperties }) {
  const filled = name === "play";
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth={stroke}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={style}
      aria-hidden
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
