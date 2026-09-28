import { AnimatePresence, motion, type PanInfo } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { Badge } from "../components/Badge";
import { Icon } from "../components/Icon";
import { Bubble, Kip } from "../components/Kip";
import { useToast } from "../components/Toast";
import { buzz, sfx } from "../lib/feedback";
import { distanceKm } from "../lib/geo";
import { FIELD } from "../lib/native";
import type { Park } from "../lib/parks";
import { useContent } from "../lib/content/provider";
import { DEMO_START, useStore } from "../lib/store";
import { RARITY } from "../lib/parks";
import { RARITY_REQUIREMENTS, RARITY_TIERS } from "../lib/progression";
import { formatRarityRequirements } from "../lib/rarityUi";

const SLIDES = [
  {
    eyebrow: "Step 1 · Explore",
    title: ["Every park", "has a badge."],
    body: "Parks all over Vancouver Island, each with its own one-of-a-kind badge. Find one you want.",
    tint: "#FFE2C2",
  },
  {
    eyebrow: "Step 2 · Go",
    title: ["Go there.", "For real."],
    body: "No couch claims. Badges unlock only when you're standing inside the park boundary.",
    tint: "#D6F0DF",
  },
  {
    eyebrow: "Step 3 · Collect",
    title: ["Snap it.", "Claim it. Keep it."],
    body: "Take a photo, claim the badge and build a collection worth putting on a shelf.",
    tint: "#DCEBFF",
  },
  {
    eyebrow: "Step 4 · Unlock",
    title: ["Unlock", "rarer parks."],
    body: "Claim badges to open the next rarity tier. Your park sheet always shows what you need next.",
    tint: "#E8E2FF",
  },
];

function RarityRoadmap() {
  return (
    <div className="ob-roadmap" aria-label="Badge rarity unlock requirements">
      <div className="ob-roadmap__heading">Claimed badges unlock rarer parks</div>
      <div className="ob-roadmap__rows">
        {RARITY_TIERS.map((rarity, index) => {
          const requirements = RARITY_REQUIREMENTS[rarity];
          const need = formatRarityRequirements(requirements);
          return (
            <motion.div
              key={rarity}
              className="ob-roadmap__row"
              initial={{ x: 24, opacity: 0 }}
              animate={{ x: 0, opacity: 1 }}
              transition={{ delay: index * 0.08, type: "spring", stiffness: 320, damping: 24 }}
            >
              <span className="ob-roadmap__tier" style={{ background: RARITY[rarity].color, color: RARITY[rarity].ink }}>
                {RARITY[rarity].label}
              </span>
              <span className="ob-roadmap__need">{need || "Open now"}</span>
            </motion.div>
          );
        })}
      </div>
      <div className="ob-roadmap__foot">Each badge counts once</div>
    </div>
  );
}

function BadgeFan({ parks }: { parks: readonly Park[] }) {
  const fan = parks.slice(0, 3);
  const pos = [
    { x: -92, y: 26, r: -14, s: 0.78, d: 0.1 },
    { x: 0, y: -8, r: 0, s: 1, d: 0 },
    { x: 92, y: 26, r: 14, s: 0.78, d: 0.2 },
  ];
  return (
    <div className="ob-fan">
      <motion.div className="ob-rays" animate={{ rotate: 360 }} transition={{ duration: 30, repeat: Infinity, ease: "linear" }} />
      {fan.map((park, i) => (
        <motion.div
          key={park.id}
          className="ob-fan__item"
          style={{ zIndex: i === 1 ? 2 : 1 }}
          initial={{ x: 0, y: 120, scale: 0.2, rotate: 0, opacity: 0 }}
          animate={{ x: pos[i].x, y: pos[i].y, scale: pos[i].s, rotate: pos[i].r, opacity: 1 }}
          transition={{ type: "spring", stiffness: 240, damping: 16, delay: 0.15 + pos[i].d }}
        >
          <motion.div animate={{ y: [0, -8, 0], rotate: [0, i === 1 ? 2 : -2, 0] }} transition={{ duration: 3 + i * 0.4, repeat: Infinity, ease: "easeInOut" }}>
            <Badge park={park} size={170} animated />
          </motion.div>
        </motion.div>
      ))}
      <motion.div className="ob-fan__kip" initial={{ x: -120, rotate: -20 }} animate={{ x: 0, rotate: 0 }} transition={{ type: "spring", delay: 0.6, stiffness: 200, damping: 14 }}>
        <Kip pose="wave" size={110} />
        <Bubble side="left" style={{ left: 64, top: -34, whiteSpace: "nowrap" }}>
          Hi! I'm Kip.
        </Bubble>
      </motion.div>
    </div>
  );
}

const ROUTE = "M40 214 C 70 200, 60 150, 110 140 S 170 120, 176 96";

function GoThere() {
  const dur = "4.2s";
  const keys = { keyTimes: "0;0.65;1", keyPoints: "0;1;1", calcMode: "linear" as const };
  return (
    <div className="ob-go">
      <svg viewBox="0 0 300 260" width="100%" height="100%">
        <defs>
          <pattern id="ob-dots" width="14" height="14" patternUnits="userSpaceOnUse">
            <circle cx="2" cy="2" r="1.3" fill="#14231C" opacity="0.12" />
          </pattern>
        </defs>
        <rect width="300" height="260" rx="28" fill="#F7ECD8" />
        <rect width="300" height="260" rx="28" fill="url(#ob-dots)" />
        <path d="M0 40 Q80 60 150 30 T300 50 L300 0 L0 0Z" fill="#A8E1EC" />
        <path d="M-10 190 L310 150" stroke="#FFFFFF" strokeWidth="12" strokeLinecap="round" />
        <path d="M-10 190 L310 150" stroke="#E3C697" strokeWidth="1.5" strokeDasharray="8 8" />
        <path d="M128 60 C160 36 238 44 250 84 C262 124 222 150 190 142 C150 132 100 96 128 60Z" fill="#C9E7B2" />
        <path d="M128 60 C160 36 238 44 250 84 C262 124 222 150 190 142 C150 132 100 96 128 60Z" fill="none" stroke="#2F9E6B" strokeWidth="3" strokeDasharray="7 6">
          <animate attributeName="stroke-dashoffset" values="0;-26" dur="1.2s" repeatCount="indefinite" />
        </path>
        <path d="M128 60 C160 36 238 44 250 84 C262 124 222 150 190 142 C150 132 100 96 128 60Z" fill="#2F9E6B" opacity="0">
          <animate attributeName="opacity" values="0;0;.35;0" keyTimes="0;.64;.72;1" dur={dur} repeatCount="indefinite" />
        </path>
        {[[160, 70], [214, 64], [230, 104], [190, 112]].map(([x, y], i) => (
          <path key={i} d={`M${x} ${y - 16} l7 12 h-4 l6 10 h-18 l6 -10 h-4Z`} fill="#1C5B43" />
        ))}
        <path d={ROUTE} fill="none" stroke="#FF5A1F" strokeWidth="4" strokeLinecap="round" strokeDasharray="1 9" />
        <g>
          <circle r="16" fill="#FF5A1F" opacity="0.2">
            <animate attributeName="r" values="10;20;10" dur="1.4s" repeatCount="indefinite" />
          </circle>
          <circle r="9" fill="#FF5A1F" stroke="#FFF8EC" strokeWidth="3.5" />
          <animateMotion path={ROUTE} dur={dur} repeatCount="indefinite" {...keys} />
        </g>
        <g transform="translate(206 26)">
          <g opacity="0">
            <animate attributeName="opacity" values="0;0;1;1;0" keyTimes="0;.66;.7;.95;1" dur={dur} repeatCount="indefinite" />
            <animateTransform attributeName="transform" type="scale" values="0.2;0.2;1.15;1;1" keyTimes="0;.66;.72;.78;1" dur={dur} repeatCount="indefinite" />
            <rect x="-44" y="-16" width="88" height="32" rx="16" fill="#14231C" />
            <text x="0" y="5" textAnchor="middle" fill="#FFF8EC" fontFamily="'Bricolage Grotesque Variable'" fontWeight="800" fontSize="14">
              You're in!
            </text>
          </g>
        </g>
      </svg>
      <motion.div className="ob-go__kip" animate={{ rotate: [0, -6, 0] }} transition={{ duration: 2, repeat: Infinity }}>
        <Kip pose="point" size={104} />
      </motion.div>
    </div>
  );
}

function SnapClaimKeep({ parks }: { parks: readonly Park[] }) {
  const park = parks[0];
  const loop = { duration: 4.4, repeat: Infinity, repeatDelay: 0.6 };
  const cells = parks.slice(0, 5);
  return (
    <div className="ob-snap">
      <motion.div
        className="ob-polaroid"
        animate={{ y: [140, 0, 0, 0, -40], rotate: [-18, -6, -6, -6, -2], opacity: [0, 1, 1, 1, 0], scale: [0.8, 1, 1, 1, 0.6] }}
        transition={{ ...loop, times: [0, 0.15, 0.5, 0.72, 0.85], ease: "easeOut" }}
      >
        <div className="ob-polaroid__img">
          <svg viewBox="0 0 200 150" width="100%" height="100%" preserveAspectRatio="xMidYMid slice">
            <rect width="200" height="150" fill="#FFD9A8" />
            <circle cx="140" cy="46" r="18" fill="#FFF4D6" />
            <path d="M0 90 Q50 70 100 88 T200 80 L200 150 L0 150Z" fill="#27A9C4" />
            <path d="M0 120 Q60 104 120 122 T200 112 L200 150 L0 150Z" fill="#1C5B43" />
            <path d="M30 108 l10 -30 l10 30Z M52 110 l8 -24 l8 24Z" fill="#14231C" />
          </svg>
          <motion.div className="ob-flash" animate={{ opacity: [0, 0, 1, 0, 0] }} transition={{ ...loop, times: [0, 0.14, 0.16, 0.26, 1] }} />
        </div>
        <span>{park?.short ?? "your park"} · your visit</span>
      </motion.div>
      <motion.div
        className="ob-stamp"
        animate={{ scale: [3, 3, 0.9, 1.05, 1, 1, 0.34], opacity: [0, 0, 1, 1, 1, 1, 1], rotate: [30, 30, -8, 4, 0, 0, 0], x: [0, 0, 60, 60, 60, 60, -58], y: [0, 0, 30, 30, 30, 30, 118] }}
        transition={{ ...loop, times: [0, 0.3, 0.4, 0.46, 0.5, 0.72, 0.86], ease: "easeOut" }}
      >
        {park ? <Badge park={park} size={120} /> : <Kip pose="think" size={100} />}
      </motion.div>
      <div className="ob-case">
        {cells.map((item, i) => (
          <div key={item.id} className="ob-case__cell">
            <Badge park={item} size={32} showName={false} state={i < 3 ? "earned" : "silhouette"} />
          </div>
        ))}
        <motion.div className="ob-case__cell ob-case__cell--new" animate={{ boxShadow: ["0 0 0 0 #FFC93C00", "0 0 0 0 #FFC93C00", "0 0 0 6px #FFC93Cff", "0 0 0 0 #FFC93C00"] }} transition={{ ...loop, times: [0, 0.84, 0.9, 1] }} />
      </div>
    </div>
  );
}

export function Onboarding() {
  const { dispatch } = useStore();
  const content = useContent();
  const toast = useToast();
  const [index, setIndex] = useState(0);
  const [dir, setDir] = useState(1);
  const [asking, setAsking] = useState(false);
  const slide = SLIDES[index];
  // The illustrations are drawn at 320px; shrink them to fit shorter phones.
  const visualRef = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState(1);
  useEffect(() => {
    const el = visualRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setFit(Math.min(1, entry.contentRect.height / 340, entry.contentRect.width / 340)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const parks = content?.liveParks ?? [];

  const goTo = (i: number) => {
    if (i < 0 || i >= SLIDES.length) return;
    sfx.tap();
    buzz(8);
    setDir(i > index ? 1 : -1);
    setIndex(i);
  };

  const onDragEnd = (_: unknown, info: PanInfo) => {
    if (info.offset.x < -60 || info.velocity.x < -400) goTo(index + 1);
    else if (info.offset.x > 60 || info.velocity.x > 400) goTo(index - 1);
  };

  const finish = (useGps: boolean) => {
    sfx.chirp();
    // Field builds hand location to the app-wide watcher, which asks for permission itself.
    if (FIELD || !useGps || !navigator.geolocation) {
      dispatch({ type: "onboarded" });
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const here: [number, number] = [pos.coords.longitude, pos.coords.latitude];
        if (distanceKm(here, DEMO_START) > 300) toast("You're far from the Island. Using a Victoria demo spot.", "kip");
        else dispatch({ type: "move", user: here, accuracy: pos.coords.accuracy });
        dispatch({ type: "onboarded" });
      },
      () => {
        toast("No location, no problem. Using a Victoria demo spot.", "kip");
        dispatch({ type: "onboarded" });
      },
      { timeout: 6000 },
    );
  };

  return (
    <motion.div
      className="screen onboarding"
      animate={{ backgroundColor: slide.tint }}
      transition={{ duration: 0.6 }}
      exit={{ opacity: 0, y: 40, transition: { duration: 0.35 } }}
    >
      <div className="onboarding__top">
        <div className="onboarding__logo">parkdex</div>
        {index < SLIDES.length - 1 && (
          <button className="onboarding__skip" onClick={() => goTo(SLIDES.length - 1)}>
            Skip
          </button>
        )}
      </div>
      <motion.div className="onboarding__drag" drag="x" dragConstraints={{ left: 0, right: 0 }} dragElastic={0.25} onDragEnd={onDragEnd}>
        <div className="onboarding__visual" ref={visualRef}>
          <AnimatePresence mode="popLayout" custom={dir} initial={false}>
            <motion.div
              key={index}
              custom={dir}
              className="onboarding__visual-inner"
              variants={{
                enter: (d: number) => ({ x: d * 320, rotate: d * 8, opacity: 0 }),
                center: { x: 0, rotate: 0, opacity: 1 },
                exit: (d: number) => ({ x: d * -320, rotate: d * -8, opacity: 0 }),
              }}
              initial="enter"
              animate="center"
              exit="exit"
              transition={{ type: "spring", stiffness: 260, damping: 26 }}
            >
              <div style={{ transform: `scale(${fit})` }}>
                {index === 0 ? <BadgeFan parks={parks} /> : index === 1 ? <GoThere /> : index === 2 ? <SnapClaimKeep parks={parks} /> : <RarityRoadmap />}
              </div>
            </motion.div>
          </AnimatePresence>
        </div>
        <div className="onboarding__copy">
          <AnimatePresence mode="wait" initial={false}>
            <motion.div key={index} initial="hidden" animate="show" exit="hidden" variants={{ show: { transition: { staggerChildren: 0.06 } } }}>
              <motion.p className="eyebrow" variants={rise}>
                {slide.eyebrow}
              </motion.p>
              <h1 className="onboarding__title">
                {slide.title.map((line) => (
                  <motion.span key={line} variants={rise}>
                    {line}
                  </motion.span>
                ))}
              </h1>
              <motion.p className="onboarding__body" variants={rise}>
                {slide.body}
              </motion.p>
            </motion.div>
          </AnimatePresence>
        </div>
      </motion.div>
      <div className="onboarding__foot">
        <div className="dots">
          {SLIDES.map((_, i) => (
            <motion.button
              key={i}
              className="dot"
              aria-label={`Slide ${i + 1}`}
              onClick={() => goTo(i)}
              animate={{ width: i === index ? 28 : 10, backgroundColor: i === index ? "#14231C" : "#14231C33" }}
              transition={{ type: "spring", stiffness: 500, damping: 30 }}
            />
          ))}
        </div>
        <motion.button
          className="btn"
          layout
          onClick={() => (index < SLIDES.length - 1 ? goTo(index + 1) : setAsking(true))}
          whileTap={{ scale: 0.96 }}
          transition={{ type: "spring", stiffness: 500, damping: 30 }}
        >
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.span key={index < SLIDES.length - 1 ? "next" : "go"} initial={{ y: 20, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: -20, opacity: 0 }}>
              {index < SLIDES.length - 1 ? "Next" : "Let's go!"}
            </motion.span>
          </AnimatePresence>
          <Icon name="next" />
        </motion.button>
      </div>

      <AnimatePresence>
        {asking && (
          <motion.div className="sheet-scrim" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setAsking(false)}>
            <motion.div
              className="permission"
              onClick={(e) => e.stopPropagation()}
              initial={{ y: 400 }}
              animate={{ y: 0 }}
              exit={{ y: 400 }}
              transition={{ type: "spring", stiffness: 320, damping: 30 }}
            >
              <div className="permission__kip">
                <Kip pose="talk" size={110} />
              </div>
              <h2>Kip needs to know when you've arrived.</h2>
              <p>Your location is only used to check you in inside a park boundary. It never leaves your phone.</p>
              <button className="btn btn--block" onClick={() => finish(true)}>
                <Icon name="locate" /> Allow location
              </button>
              {!FIELD && (
                <button className="permission__alt" onClick={() => finish(false)}>
                  Use a demo spot in Victoria
                </button>
              )}
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

const rise = {
  hidden: { y: 18, opacity: 0 },
  show: { y: 0, opacity: 1, transition: { type: "spring" as const, stiffness: 400, damping: 30 } },
};
