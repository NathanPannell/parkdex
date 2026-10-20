import { AnimatePresence, motion, type PanInfo } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { Flag, FlagPin } from "../components/Flag";
import { Icon } from "../components/Icon";
import { Bubble, Kip } from "../components/Kip";
import { useToast } from "../components/Toast";
import { buzz, sfx } from "../lib/feedback";
import { FIELD } from "../lib/native";
import { DEMO_TOOLS } from "../lib/demo";
import { useFeatureFlag } from "../lib/appConfig";
import { saveLastLocation } from "../lib/lastLocation";
import { rememberWebLocation, WEB_CAN_TRACK } from "../lib/liveLocation";
import { onboardingStart } from "../lib/provinces";
import { DEMO_START, useStore } from "../lib/store";
import goMap from "../assets/onboarding-go-map.webp";
import "../game.css";
import "../onboarding.css";

/**
 * Three short slides that teach the flag game, with Kip as the guide: go to a park and plant
 * your flag, earn a point an hour and take other players' parks, and hold parks with friends
 * (only while crews are on). Handles and founding are explained where they first come up, and
 * how flags eventually fall is left for players to discover.
 */
type SlideVisual = "go" | "take" | "crew";
const SLIDES: { visual: SlideVisual; eyebrow: string; title: [string, string]; body: string; tint: string }[] = [
  {
    visual: "go",
    eyebrow: "Parkdex",
    title: ["Plant your flag", "in real parks."],
    body: "Walk into any park on the map and tap Plant. Like capture the flag, for every park around you.",
    tint: "#D6F0DF",
  },
  {
    visual: "take",
    eyebrow: "Points",
    title: ["Take parks.", "Win their days."],
    body: "Your flag earns a point every hour it flies. Plant on someone else's park to take it, plus a point for every day their flag was up.",
    tint: "#FFD6DE",
  },
  {
    visual: "crew",
    eyebrow: "Friends",
    title: ["Bring friends.", "Hold it together."],
    body: "Plant a flag and your friends scan your crew code to join. The park is yours together, and everyone earns its hours.",
    tint: "#FFE2C2",
  },
];

const SAMPLE_SEEDS = ["onboard-fern", "onboard-tide", "onboard-moss"];
const RIVAL_SEED = "onboard-rival";
const YOU_SEED = "onboard-you";

function Mound({ width = 150 }: { width?: number }) {
  return (
    <svg className="ob-mound" viewBox="0 0 150 46" width={width} aria-hidden="true">
      <ellipse cx="75" cy="42" rx="70" ry="4" fill="rgba(20,35,28,.18)" />
      <path d="M6 42 C 24 12, 52 4, 75 4 C 98 4, 126 12, 144 42 Z" fill="#8B5A2B" />
      <path d="M22 30 C 40 14, 60 10, 75 10 C 92 10, 112 14, 128 30 C 104 24, 46 24, 22 30 Z" fill="#A0703F" />
      <path d="M68 6 l3 -7 l2 7 M80 7 l4 -6 l1 7" stroke="#5E9A3A" strokeWidth="2.5" strokeLinecap="round" fill="none" />
    </svg>
  );
}

/** A flag on a pole standing in a mound, for the slides. */
function PlantedFlag({ seed, size = 92, days = 0, wave = true }: { seed: string | null; size?: number; days?: number; wave?: boolean }) {
  const width = size * 1.5;
  const poleHeight = size * 1.25;
  const moundHeight = (width * 46) / 150;
  const poleLeft = width * 0.32;
  return (
    <div className="ob-planted" style={{ width, height: poleHeight + moundHeight - 12 }}>
      <span className="ob-planted__pole" style={{ left: poleLeft, height: poleHeight }} />
      <span className={`ob-planted__cloth ${wave ? "plant-flag__cloth--wave" : ""}`} style={{ left: poleLeft + 5 }}>
        <Flag seed={seed} size={size} days={days} />
      </span>
      <Mound width={width} />
    </div>
  );
}

function FlagHills() {
  const spots = [
    { x: -104, y: 34, s: 0.7, d: 0.25 },
    { x: 0, y: -8, s: 1, d: 0 },
    { x: 104, y: 34, s: 0.7, d: 0.4 },
  ];
  return (
    <div className="ob-hills">
      <motion.div className="ob-rays" animate={{ rotate: 360 }} transition={{ duration: 30, repeat: Infinity, ease: "linear" }} />
      {SAMPLE_SEEDS.map((seed, index) => (
        <motion.div
          key={seed}
          className="ob-hills__flag"
          style={{ zIndex: index === 1 ? 2 : 1 }}
          initial={{ x: spots[index].x, y: -260, scale: spots[index].s, opacity: 0 }}
          animate={{ x: spots[index].x, y: spots[index].y, scale: spots[index].s, opacity: 1 }}
          transition={{ type: "spring", stiffness: 300, damping: 15, delay: 0.15 + spots[index].d }}
        >
          <PlantedFlag seed={seed} size={96} />
        </motion.div>
      ))}
      <motion.div
        className="ob-guide ob-guide--left"
        initial={{ x: -120, rotate: -20 }}
        animate={{ x: 0, rotate: 0 }}
        transition={{ type: "spring", delay: 0.7, stiffness: 200, damping: 14 }}
      >
        <Kip pose="wave" size={84} />
        <Bubble side="to-left" style={{ position: "relative", marginBottom: 24, whiteSpace: "nowrap" }}>
          Hi! I'm Kip.
        </Bubble>
      </motion.div>
    </div>
  );
}

// A real render of the Parkdex map with a walk into a park.
const ROUTE = "M62 118 C 92 100, 124 98, 148 112 S 186 142, 200 166";

function GoThere() {
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
          <animateMotion path={ROUTE} dur="4.2s" repeatCount="indefinite" {...keys} />
        </g>
      </svg>
      <motion.span
        className="ob-go__in"
        animate={{ opacity: [0, 0, 1, 1, 0], scale: [0.3, 0.3, 1.12, 1, 1] }}
        transition={{ ...loop, times: [0, 0.6, 0.66, 0.95, 1] }}
      >
        You're in!
      </motion.span>
      <motion.div
        className="ob-go__flag"
        animate={{ opacity: [0, 0, 1, 1, 0], y: [-120, -120, 6, 0, 0], scaleY: [1, 1, 0.86, 1, 1] }}
        transition={{ ...loop, times: [0, 0.64, 0.7, 0.76, 1] }}
      >
        <FlagPin seed={YOU_SEED} size={66} showAge={false} />
      </motion.div>
      <motion.div className="ob-go__kip" animate={{ rotate: [0, -6, 0] }} transition={{ duration: 2, repeat: Infinity }}>
        <Kip pose="point" size={90} />
      </motion.div>
    </div>
  );
}

function TakeOver() {
  const loop = { duration: 4.6, repeat: Infinity, repeatDelay: 0.4 };
  return (
    <div className="ob-take">
      <div className="ob-take__ground">
        <Mound width={190} />
      </div>
      <motion.div
        className="ob-take__flag ob-take__flag--rival"
        animate={{ rotate: [0, 0, 84, 84, 0], x: [0, 0, 18, 18, 0], opacity: [1, 1, 1, 0, 0] }}
        transition={{ ...loop, times: [0, 0.3, 0.42, 0.6, 1], ease: "easeIn" }}
      >
        <span className="ob-take__pole" />
        <span className="ob-take__cloth">
          <Flag seed={RIVAL_SEED} size={100} days={12} />
        </span>
        <span className="ob-take__tag">@sam · 12d</span>
      </motion.div>
      <motion.div
        className="ob-take__flag"
        // The flag sits 82 px below the top of this illustration, so it drops from just inside that top edge,
        // never above it: on short screens it stays on the card instead of flashing past the notch.
        animate={{ y: [-64, -64, -64, 0, 0, 0], scale: [1.1, 1.1, 1.1, 1, 1, 1], opacity: [0, 0, 1, 1, 1, 0] }}
        transition={{ ...loop, times: [0, 0.4, 0.46, 0.56, 0.95, 1], ease: "easeIn" }}
      >
        <span className="ob-take__pole" />
        <span className="ob-take__cloth plant-flag__cloth--wave">
          <Flag seed={YOU_SEED} size={100} />
        </span>
      </motion.div>
      <motion.span
        className="ob-take__points"
        animate={{ scale: [0, 0, 1.3, 1, 1, 0], opacity: [0, 0, 1, 1, 1, 0], y: [10, 10, -6, 0, 0, 0] }}
        transition={{ ...loop, times: [0, 0.6, 0.66, 0.72, 0.94, 1] }}
      >
        +12
      </motion.span>
      <div className="ob-guide ob-guide--left">
        <Kip pose="point" size={76} />
        <Bubble side="to-left" style={{ position: "relative", marginBottom: 22, whiteSpace: "nowrap" }}>
          Sorry, Sam!
        </Bubble>
      </div>
    </div>
  );
}

export function Onboarding() {
  const { dispatch } = useStore();
  const toast = useToast();
  const [index, setIndex] = useState(0);
  const [dir, setDir] = useState(1);
  const [asking, setAsking] = useState(false);
  // The friends slide teaches crews, so it shows only while they are on.
  const crews = useFeatureFlag("crews");
  const slides = crews ? SLIDES : SLIDES.filter((candidate) => candidate.visual !== "crew");
  // The flag can change while onboarding is open; stay on the last slide that still exists.
  const at = Math.min(index, slides.length - 1);
  const slide = slides[at];
  const last = at === slides.length - 1;
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
    setDir(i > at ? 1 : -1);
    setIndex(i);
  };

  const onDragEnd = (_: unknown, info: PanInfo) => {
    if (info.offset.x < -60 || info.velocity.x < -400) goTo(at + 1);
    else if (info.offset.x > 60 || info.velocity.x > 400) goTo(at - 1);
  };

  const finish = (useGps: boolean) => {
    sfx.chirp();
    // Field builds hand location to the app-wide watcher, which asks for permission itself.
    if (FIELD || !useGps || !navigator.geolocation) {
      dispatch({ type: "onboarded" });
      return;
    }
    // A real position anywhere in a supported province is used as is; the demo spot is
    // only for players outside them all or without a location.
    // The hosted web app follows the player from here on, as phones do, but only inside the
    // provinces Parkdex covers: elsewhere it stays on the demo spot it just announced.
    const followOnWeb = () => {
      if (!WEB_CAN_TRACK) return;
      rememberWebLocation(true);
      dispatch({ type: "webLocation", allowed: true });
    };
    const start = (fix: [number, number] | null, accuracy: number | null) => {
      const decision = onboardingStart(fix);
      if (decision.kind === "located") {
        followOnWeb();
        dispatch({ type: "move", user: decision.point, accuracy });
        // Builds without live GPS have no other way to remember it across a reload.
        saveLastLocation(decision.point);
      } else {
        toast(decision.message, "kip");
        dispatch({ type: "move", user: DEMO_START, accuracy: null });
      }
      dispatch({ type: "onboarded" });
    };
    navigator.geolocation.getCurrentPosition(
      (pos) => start([pos.coords.longitude, pos.coords.latitude], pos.coords.accuracy),
      (error) => {
        // Allowed, but the first fix was slow: keep following, so the position arrives later.
        if (error.code !== error.PERMISSION_DENIED) followOnWeb();
        start(null, null);
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
        {!last && (
          <button className="onboarding__skip" onClick={() => goTo(slides.length - 1)}>
            Skip
          </button>
        )}
      </div>
      <motion.div className="onboarding__drag" drag="x" dragConstraints={{ left: 0, right: 0 }} dragElastic={0.25} onDragEnd={onDragEnd}>
        <div className="onboarding__visual" ref={visualRef}>
          <AnimatePresence mode="popLayout" custom={dir} initial={false}>
            <motion.div
              key={at}
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
              <div style={{ transform: `scale(${fit})` }}>{slide.visual === "go" ? <GoThere /> : slide.visual === "take" ? <TakeOver /> : <FlagHills />}</div>
            </motion.div>
          </AnimatePresence>
        </div>
        <div className="onboarding__copy">
          <AnimatePresence mode="wait" initial={false}>
            <motion.div key={at} initial="hidden" animate="show" exit="hidden" variants={{ show: { transition: { staggerChildren: 0.06 } } }}>
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
              animate={{ width: i === at ? 28 : 10, backgroundColor: i === at ? "#14231C" : "#14231C33" }}
              transition={{ type: "spring", stiffness: 500, damping: 30 }}
            />
          ))}
        </div>
        <motion.button
          className="btn"
          layout
          onClick={() => (!last ? goTo(at + 1) : setAsking(true))}
          whileTap={{ scale: 0.96 }}
          transition={{ type: "spring", stiffness: 500, damping: 30 }}
        >
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.span key={!last ? "next" : "go"} initial={{ y: 20, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: -20, opacity: 0 }}>
              {!last ? "Next" : "Let's go!"}
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
              <h2>Kip needs to know when you're in a park.</h2>
              <p>Kip uses your location to check you're inside a park. It's never shown to other players.</p>
              <button className="btn btn--block" onClick={() => finish(true)}>
                <Icon name="locate" /> Allow location
              </button>
              {!FIELD && (
                <button className="permission__alt" onClick={() => finish(false)}>
                  {DEMO_TOOLS ? "Use a demo spot in Victoria" : "Not now"}
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
