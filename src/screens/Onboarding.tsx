import { AnimatePresence, motion, useReducedMotion, type PanInfo } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { Flag, FlagPin } from "../components/Flag";
import { Icon } from "../components/Icon";
import { Bubble, Kip } from "../components/Kip";
import { RollingNumber } from "../components/Motion";
import { useToast } from "../components/Toast";
import { useAuth } from "../lib/accounts/AuthProvider";
import { buzz, sfx } from "../lib/feedback";
import { useGame } from "../lib/game/GameProvider";
import { distanceKm } from "../lib/geo";
import { FIELD } from "../lib/native";
import { DEMO_START, useStore } from "../lib/store";
import goMap from "../assets/onboarding-go-map.webp";
import "../game.css";
import "../onboarding.css";

/**
 * Six short slides that teach the flag game, with Kip as the guide: plant a flag by going to a
 * park, earn a point a day while it flies, take other players' parks for their flag's age, get
 * your own @handle and flag, and found parks nobody has founded yet. How flags eventually fall
 * is left for players to discover.
 */
const SLIDES = [
  {
    eyebrow: "Parkdex",
    title: ["Plant your flag", "in real parks."],
    body: "Like capture the flag, for every park around you. Play with your friends.",
    tint: "#FFE2C2",
  },
  {
    eyebrow: "Step 1 · Go",
    title: ["Go to a park.", "Up goes your flag."],
    body: "Head to any park on the map. Once you're inside the boundary, hold the button and plant your flag.",
    tint: "#D6F0DF",
  },
  {
    eyebrow: "Step 2 · Hold",
    title: ["A point a day", "while it flies."],
    body: "Your flag earns 1 point for every day it stays up. The longer it flies, the more it's worth.",
    tint: "#FFF1B8",
  },
  {
    eyebrow: "Step 3 · Take",
    title: ["Take parks.", "Win their days."],
    body: "Plant on someone else's park and it's yours, plus a point for every day their flag was up. They keep what they earned.",
    tint: "#FFD6DE",
  },
  {
    eyebrow: "Step 4 · You",
    title: ["Your @handle.", "Your flag."],
    body: "Every player gets a one-of-a-kind flag. Everyone sees it, and your handle, on the parks you hold.",
    tint: "#DCEBFF",
  },
  {
    eyebrow: "Bonus · Found",
    title: ["Found a park.", "Make it yours."],
    body: "Standing in a park nobody has founded? Take its photo and it's yours, +10 points.",
    tint: "#E6F4C8",
  },
];
// The handle slide: signing in and picking a handle are offered here.
const YOU_SLIDE = 4;

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
      <motion.div className="ob-guide ob-guide--left" initial={{ x: -120, rotate: -20 }} animate={{ x: 0, rotate: 0 }} transition={{ type: "spring", delay: 0.7, stiffness: 200, damping: 14 }}>
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
      <motion.span className="ob-go__in" animate={{ opacity: [0, 0, 1, 1, 0], scale: [0.3, 0.3, 1.12, 1, 1] }} transition={{ ...loop, times: [0, 0.6, 0.66, 0.95, 1] }}>
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

function PointsPerDay() {
  const reduce = useReducedMotion();
  const [day, setDay] = useState(reduce ? 3 : 1);
  useEffect(() => {
    if (reduce) return;
    // Days tick by, the score climbs, and the flag weathers as it would over a month.
    const timer = window.setInterval(() => setDay((current) => (current >= 9 ? 1 : current + 1)), 750);
    return () => window.clearInterval(timer);
  }, [reduce]);
  const days = day === 1 ? 0 : day * 3;
  return (
    <div className="ob-days">
      <motion.span key={day} className="ob-days__chip" initial={{ y: -14, opacity: 0, rotate: -8 }} animate={{ y: 0, opacity: 1, rotate: -4 }} transition={{ type: "spring", stiffness: 500, damping: 18 }}>
        Day {day}
      </motion.span>
      <div className="ob-days__flag">
        <PlantedFlag seed={YOU_SEED} size={118} days={days} />
      </div>
      <div className="ob-days__score card">
        <strong><RollingNumber value={day - 1} /></strong>
        <span>{day - 1 === 1 ? "point" : "points"}</span>
      </div>
      <div className="ob-guide ob-guide--right">
        <Bubble side="to-right" style={{ position: "relative", marginBottom: 22, whiteSpace: "nowrap" }}>
          Tick, tick, points!
        </Bubble>
        <Kip pose="cheer" size={76} flip />
      </div>
    </div>
  );
}

function TakeOver() {
  const loop = { duration: 4.6, repeat: Infinity, repeatDelay: 0.4 };
  return (
    <div className="ob-take">
      <div className="ob-take__ground"><Mound width={190} /></div>
      <motion.div
        className="ob-take__flag ob-take__flag--rival"
        animate={{ rotate: [0, 0, 84, 84, 0], x: [0, 0, 18, 18, 0], opacity: [1, 1, 1, 0, 0] }}
        transition={{ ...loop, times: [0, 0.3, 0.42, 0.6, 1], ease: "easeIn" }}
      >
        <span className="ob-take__pole" />
        <span className="ob-take__cloth"><Flag seed={RIVAL_SEED} size={100} days={12} /></span>
        <span className="ob-take__tag">@sam · 12d</span>
      </motion.div>
      <motion.div
        className="ob-take__flag"
        animate={{ y: [-220, -220, -220, 0, 0, 0], opacity: [0, 0, 1, 1, 1, 0] }}
        transition={{ ...loop, times: [0, 0.4, 0.46, 0.56, 0.95, 1], ease: "easeIn" }}
      >
        <span className="ob-take__pole" />
        <span className="ob-take__cloth plant-flag__cloth--wave"><Flag seed={YOU_SEED} size={100} /></span>
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

function YourFlag() {
  const reduce = useReducedMotion();
  const auth = useAuth();
  const game = useGame();
  const signedIn = auth.phase === "authenticated";
  const player = game.me?.player ?? null;
  const ownSeed = player?.flagSeed ?? game.me?.flagSeed ?? null;
  const finalSeed = ownSeed ?? YOU_SEED;
  const [shuffle, setShuffle] = useState(reduce ? -1 : 0);
  useEffect(() => {
    if (reduce) return;
    // A quick shuffle through flags, landing on yours.
    let step = 0;
    const timer = window.setInterval(() => {
      step += 1;
      if (step > 9) {
        window.clearInterval(timer);
        setShuffle(-1);
        sfx.pop();
        buzz(15);
      } else {
        setShuffle(step);
      }
    }, 140);
    return () => window.clearInterval(timer);
  }, [reduce]);
  const seed = shuffle < 0 ? finalSeed : `onboard-shuffle-${shuffle}`;
  return (
    <div className="ob-you">
      <motion.div className="ob-rays" animate={{ rotate: 360 }} transition={{ duration: 30, repeat: Infinity, ease: "linear" }} />
      <motion.div
        key={shuffle < 0 ? "final" : "shuffle"}
        className="ob-you__flag"
        initial={shuffle < 0 ? { scale: 0.6, rotate: -10 } : false}
        animate={{ scale: 1, rotate: -3 }}
        transition={{ type: "spring", stiffness: 320, damping: 12 }}
      >
        <Flag seed={seed} size={170} label={shuffle < 0 ? "Your flag" : undefined} />
      </motion.div>
      <AnimatePresence>
        {shuffle < 0 && (
          <motion.span className="ob-you__handle" initial={{ y: 16, opacity: 0, scale: 0.8 }} animate={{ y: 0, opacity: 1, scale: 1 }} transition={{ type: "spring", stiffness: 420, damping: 18, delay: 0.1 }}>
            @{player?.handle ?? "you"}
          </motion.span>
        )}
      </AnimatePresence>
      <div className="ob-guide ob-guide--right">
        <Bubble side="to-right" style={{ position: "relative", marginBottom: 22, whiteSpace: "nowrap" }}>
          {player ? "Looking sharp!" : signedIn ? "Pick a handle!" : "Yours is waiting!"}
        </Bubble>
        <Kip pose="celebrate" size={76} flip />
      </div>
    </div>
  );
}

/** A park photo drops onto the ground like a planted flag, and the founder bonus pops. */
function FoundIt() {
  const loop = { duration: 4.4, repeat: Infinity, repeatDelay: 0.3 };
  return (
    <div className="ob-found">
      <motion.div className="ob-rays" animate={{ rotate: 360 }} transition={{ duration: 30, repeat: Infinity, ease: "linear" }} />
      <div className="ob-found__ground"><Mound width={210} /></div>
      <motion.div
        className="ob-found__photo"
        animate={{ y: [-260, -260, 0, 0, 0], rotate: [-16, -16, -4, -4, -4], opacity: [0, 1, 1, 1, 0] }}
        transition={{ ...loop, times: [0, 0.2, 0.34, 0.92, 1], ease: "easeIn" }}
      >
        <svg viewBox="0 0 160 120" aria-hidden="true">
          <rect width="160" height="120" fill="#9FD8FF" />
          <circle cx="126" cy="26" r="13" fill="#FFC93C" />
          <path d="M0 86 C 30 62, 62 64, 88 78 C 112 64, 140 62, 160 74 L160 120 L0 120 Z" fill="#5E9A3A" />
          <path d="M0 100 C 40 88, 110 90, 160 98 L160 120 L0 120 Z" fill="#2F9E6B" />
          <path d="M34 92 l10 -34 l10 34 Z M60 90 l8 -26 l8 26 Z M112 88 l11 -38 l11 38 Z" fill="#1C5B43" />
        </svg>
        <span className="ob-found__caption">Founded by @you</span>
      </motion.div>
      <motion.span
        className="ob-found__points"
        animate={{ scale: [0, 0, 1.3, 1, 1, 0], opacity: [0, 0, 1, 1, 1, 0], y: [10, 10, -6, 0, 0, 0] }}
        transition={{ ...loop, times: [0, 0.36, 0.42, 0.48, 0.92, 1] }}
      >
        +10
      </motion.span>
      <div className="ob-guide ob-guide--left">
        <Kip pose="camera" size={80} />
        <Bubble side="to-left" style={{ position: "relative", marginBottom: 22, whiteSpace: "nowrap" }}>
          Say cheese, park!
        </Bubble>
      </div>
    </div>
  );
}

export function Onboarding() {
  const { dispatch } = useStore();
  const toast = useToast();
  const auth = useAuth();
  const game = useGame();
  const [index, setIndex] = useState(0);
  const [dir, setDir] = useState(1);
  const [asking, setAsking] = useState(false);
  const slide = SLIDES[index];
  const last = index === SLIDES.length - 1;
  const onYouSlide = index === YOU_SLIDE;
  const canPickHandle = auth.phase === "authenticated" && game.status === "ready" && !game.me?.player;
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
        {!last && (
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
                {index === 0 ? <FlagHills /> : index === 1 ? <GoThere /> : index === 2 ? <PointsPerDay /> : index === 3 ? <TakeOver /> : index === YOU_SLIDE ? <YourFlag /> : <FoundIt />}
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
                {onYouSlide && !game.me?.player && auth.phase !== "authenticated" ? `${slide.body} Sign in when you plant your first one.` : slide.body}
              </motion.p>
            </motion.div>
          </AnimatePresence>
        </div>
      </motion.div>
      <AnimatePresence>
        {onYouSlide && canPickHandle && (
          <motion.button
            className="btn btn--paper btn--block ob-handle-btn"
            initial={{ y: 20, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 20, opacity: 0 }}
            onClick={() => game.openHandleSheet()}
          >
            <Icon name="flag" /> Pick your handle
          </motion.button>
        )}
      </AnimatePresence>
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
          onClick={() => (!last ? goTo(index + 1) : setAsking(true))}
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
