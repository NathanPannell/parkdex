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
import { DEMO_START, useStore } from "../lib/store";
import { RARITY } from "../lib/parks";
import { RANKS, isRankProgressionEnabled } from "../lib/progression";
import { parksLabel } from "../lib/rarityUi";
import { RankEmblem } from "../components/Rank";
import goMap from "../assets/onboarding-go-map.webp";
import beaconHillScene from "../assets/onboarding-scene-beacon-hill.webp";
import goldstreamScene from "../assets/onboarding-scene-goldstream.webp";
import wittysLagoonScene from "../assets/onboarding-scene-wittys-lagoon.webp";

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
    body: "Pick a park on the map and head over. The badge unlocks once you're standing inside the park boundary.",
    tint: "#D6F0DF",
  },
  {
    eyebrow: "Step 3 · Collect",
    title: ["Snap it.", "Claim it. Keep it."],
    body: "Take a photo, claim the badge and build a collection worth putting on a shelf.",
    tint: "#DCEBFF",
  },
  {
    eyebrow: "Step 4 · Rank up",
    title: ["Visit more.", "Rank up."],
    body: "Every new park counts. Visit 2, 5 and 10 parks to rank up and open Uncommon, Rare and Legendary badges. Track your rank in My Dex.",
    tint: "#E8E2FF",
  },
];

const ONBOARDING_PARKS: readonly Park[] = [
  {
    id: "onboarding-beacon-hill",
    name: "Beacon Hill Park",
    short: "Beacon Hill",
    category: "municipal",
    region: "Southern Vancouver Island",
    lat: 48.4119,
    lng: -123.36334,
    biome: "forest",
    shape: "circle",
    rarity: "common",
    seed: 135,
    blurb: "Garden paths, roaming peacocks and the stone bridge over Goodacre Lake make Beacon Hill a place to wander. Garry oak meadows shelter sensitive native plants, while the park's southern edge opens onto the Strait of Juan de Fuca. Nearby Mile Zero marks the western end of the Trans-Canada Highway.",
    scene: "onboarding-beacon-hill",
  },
  {
    id: "onboarding-goldstream",
    name: "Goldstream Park",
    short: "Goldstream",
    category: "provincial",
    region: "South Island",
    lat: 48.47556,
    lng: -123.54243,
    biome: "river",
    shape: "shield",
    rarity: "uncommon",
    seed: 372,
    blurb: "Each autumn, salmon return to the Goldstream River beneath old-growth firs and cedars, drawing bald eagles to this South Island park.",
    scene: "onboarding-goldstream",
  },
  {
    id: "onboarding-wittys-lagoon",
    name: "Witty's Lagoon Regional Park",
    short: "Witty's Lagoon",
    category: "regional",
    region: "Capital Region",
    lat: 48.38571,
    lng: -123.51755,
    biome: "coast",
    shape: "circle",
    rarity: "common",
    seed: 592,
    blurb: "A forest trail passes Sitting Lady Falls and reaches a broad tidal beach, one of the few sandy shores with significant tides on southern Vancouver Island. Witty's Lagoon also shelters more than 160 recorded bird species.",
    scene: "onboarding-wittys-lagoon",
  },
];

const ONBOARDING_SCENES: Readonly<Record<string, string>> = {
  "onboarding-beacon-hill": beaconHillScene,
  "onboarding-goldstream": goldstreamScene,
  "onboarding-wittys-lagoon": wittysLagoonScene,
};

function SampleBadge({ park, size, animated = false, state = "earned", showName = true }: {
  park: Park;
  size: number;
  animated?: boolean;
  state?: "earned" | "preview" | "silhouette";
  showName?: boolean;
}) {
  return <Badge park={park} size={size} animated={animated} state={state} showName={showName} sceneHref={ONBOARDING_SCENES[park.id]} />;
}

function RankRoadmap() {
  return (
    <div className="ob-ranks" aria-label="Collector ranks and the rarities they unlock">
      {RANKS.map((rank, index) => (
        <motion.div
          key={rank.name}
          className="ob-ranks__row"
          initial={{ x: 24, opacity: 0 }}
          animate={{ x: 0, opacity: 1 }}
          transition={{ delay: 0.1 + index * 0.1, type: "spring", stiffness: 320, damping: 24 }}
        >
          <RankEmblem rank={rank} size={50} />
          <span className="ob-ranks__text">
            <strong>{rank.name}</strong>
            <span>{rank.parks === 0 ? "Where you start" : `Visit ${parksLabel(rank.parks)}`}</span>
          </span>
          <span className="ob-ranks__opens" style={{ background: RARITY[rank.rarity].color, color: RARITY[rank.rarity].ink }}>
            {RARITY[rank.rarity].label}
          </span>
        </motion.div>
      ))}
    </div>
  );
}

function BadgeFan() {
  const fan = ONBOARDING_PARKS;
  const pos = [
    { x: -92, y: -8, r: -14, s: 0.78, d: 0.1 },
    { x: 0, y: -42, r: 0, s: 1, d: 0 },
    { x: 92, y: -8, r: 14, s: 0.78, d: 0.2 },
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
            <SampleBadge park={park} size={170} animated />
          </motion.div>
        </motion.div>
      ))}
      {/* Kip stands below the fan with his bubble beside him, clear of every badge ribbon. */}
      <motion.div className="ob-fan__kip" initial={{ x: -120, rotate: -20 }} animate={{ x: 0, rotate: 0 }} transition={{ type: "spring", delay: 0.6, stiffness: 200, damping: 14 }}>
        <Kip pose="wave" size={92} />
        <Bubble side="to-left" style={{ position: "relative", marginBottom: 26, whiteSpace: "nowrap" }}>
          Hi! I'm Kip.
        </Bubble>
      </motion.div>
    </div>
  );
}

// A real render of the Parkdex map around a fixed sample badge park.
const ROUTE = "M62 118 C 92 100, 124 98, 148 112 S 186 142, 200 166";

function GoThere() {
  const park = ONBOARDING_PARKS[0]!;
  const dur = "4.2s";
  const loop = { duration: 4.2, repeat: Infinity, ease: "linear" as const };
  const keys = { keyTimes: "0;0.6;1", keyPoints: "0;1;1", calcMode: "linear" as const };
  return (
    <div className="ob-go">
      <img className="ob-go__map" src={goMap} alt="" draggable={false} />
      <svg className="ob-go__route" viewBox="0 0 300 260" width="100%" height="100%" aria-hidden="true">
        <path d={ROUTE} fill="none" stroke="#FFF8EC" strokeWidth="9" strokeLinecap="round" />
        <path d={ROUTE} fill="none" stroke="#FF5A1F" strokeWidth="4.5" strokeLinecap="round" strokeDasharray="1 9" />
        <g>
          <circle r="16" fill="#FF5A1F" opacity="0.2">
            <animate attributeName="r" values="10;20;10" dur="1.4s" repeatCount="indefinite" />
          </circle>
          <circle r="9" fill="#2F7BFF" stroke="#FFF8EC" strokeWidth="3.5" />
          <animateMotion path={ROUTE} dur={dur} repeatCount="indefinite" {...keys} />
        </g>
      </svg>
      <motion.span
        className="ob-go__in"
        animate={{ opacity: [0, 0, 1, 1, 0], scale: [0.3, 0.3, 1.12, 1, 1] }}
        transition={{ ...loop, times: [0, 0.6, 0.66, 0.95, 1] }}
      >
        You're in!
      </motion.span>
      {park && (
        <motion.div
          className="ob-go__badge"
          animate={{ opacity: [0, 0, 1, 1, 0], scale: [0.2, 0.2, 1.15, 1, 1], rotate: [-30, -30, 6, 0, 0] }}
          transition={{ ...loop, times: [0, 0.62, 0.7, 0.95, 1] }}
        >
          <SampleBadge park={park} size={92} />
        </motion.div>
      )}
      <motion.div className="ob-go__kip" animate={{ rotate: [0, -6, 0] }} transition={{ duration: 2, repeat: Infinity }}>
        <Kip pose="point" size={96} />
      </motion.div>
    </div>
  );
}

function SnapClaimKeep() {
  const park = ONBOARDING_PARKS[0]!;
  const loop = { duration: 4.4, repeat: Infinity, repeatDelay: 0.6 };
  const cells = ONBOARDING_PARKS.slice(1, 4);
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
        <span>{park?.short ?? "Your park"}</span>
      </motion.div>
      <motion.div
        className="ob-stamp"
        animate={{ scale: [3, 3, 0.9, 1.05, 1, 1, 0.34], opacity: [0, 0, 1, 1, 1, 1, 1], rotate: [30, 30, -8, 4, 0, 0, 0], x: [0, 0, 60, 60, 60, 60, -58], y: [0, 0, 4, 4, 4, 4, 118] }}
        transition={{ ...loop, times: [0, 0.3, 0.4, 0.46, 0.5, 0.72, 0.86], ease: "easeOut" }}
      >
        {park ? <SampleBadge park={park} size={120} /> : <Kip pose="think" size={100} />}
      </motion.div>
      <div className="ob-case">
        {cells.map((item) => (
          <div key={item.id} className="ob-case__cell">
            <SampleBadge park={item} size={32} showName={false} state="earned" />
          </div>
        ))}
        <motion.div className="ob-case__cell ob-case__cell--new" animate={{ boxShadow: ["0 0 0 0 #FFC93C00", "0 0 0 0 #FFC93C00", "0 0 0 6px #FFC93Cff", "0 0 0 0 #FFC93C00"] }} transition={{ ...loop, times: [0, 0.84, 0.9, 1] }} />
      </div>
    </div>
  );
}

export function Onboarding() {
  // The rank-up step only appears while rank progression is switched on for this build.
  const slides = isRankProgressionEnabled() ? SLIDES : SLIDES.slice(0, 3);
  const { dispatch } = useStore();
  const toast = useToast();
  const [index, setIndex] = useState(0);
  const [dir, setDir] = useState(1);
  const [asking, setAsking] = useState(false);
  const slide = slides[index];
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
  const goTo = (i: number) => {
    if (i < 0 || i >= slides.length) return;
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
        {index < slides.length - 1 && (
          <button className="onboarding__skip" onClick={() => goTo(slides.length - 1)}>
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
                {index === 0 ? <BadgeFan /> : index === 1 ? <GoThere /> : index === 2 ? <SnapClaimKeep /> : <RankRoadmap />}
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
          {slides.map((_, i) => (
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
          onClick={() => (index < slides.length - 1 ? goTo(index + 1) : setAsking(true))}
          whileTap={{ scale: 0.96 }}
          transition={{ type: "spring", stiffness: 500, damping: 30 }}
        >
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.span key={index < slides.length - 1 ? "next" : "go"} initial={{ y: 20, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: -20, opacity: 0 }}>
              {index < slides.length - 1 ? "Next" : "Let's go!"}
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
