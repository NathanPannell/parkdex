import { AnimatePresence, motion, useAnimationControls } from "motion/react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Flag, FlagPin } from "../components/Flag";
import { Icon } from "../components/Icon";
import { Bubble, Kip } from "../components/Kip";
import { useToast } from "../components/Toast";
import { buzz, sfx } from "../lib/feedback";
import { FIELD } from "../lib/native";
import { DEMO_TOOLS } from "../lib/demo";
import { GameError, handleProblem, normalizeHandle } from "../lib/game/client";
import { useGame } from "../lib/game/GameProvider";
import { readLocalHandle, saveLocalHandle } from "../lib/game/localHandle";
import { shake } from "../lib/motion";
import { saveLastLocation } from "../lib/lastLocation";
import { rememberWebLocation, WEB_CAN_TRACK } from "../lib/liveLocation";
import { onboardingStart } from "../lib/provinces";
import { DEMO_START, useStore } from "../lib/store";
import goMap from "../assets/onboarding-go-map.webp";
import "../game.css";
import "../onboarding.css";

/**
 * Two slides, each with one job. The first says what Parkdex is and asks for location, the
 * second says what you play for and takes a @handle. The handle stays on this device until the
 * player signs in, then becomes the account's (`lib/game/localHandle.ts`). Founding, crews and
 * how flags fall are explained where they first come up.
 */
type SlideVisual = "go" | "take";
const SLIDES: { visual: SlideVisual; title: [string, string]; line: string; tint: string }[] = [
  {
    visual: "go",
    title: ["Plant your flag", "in real parks."],
    line: "From the one down the street to the one you've meant to visit for five years.",
    tint: "#D6F0DF",
  },
  {
    visual: "take",
    title: ["Climb the leaderboard", "with friends."],
    line: "Earn points. Take parks back.",
    tint: "#FFD6DE",
  },
];

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
  const game = useGame();
  // Onboarding replays after an update: a player who already has a handle isn't asked again,
  // and a signed-in player whose game hasn't loaded isn't asked either, or a save could rename them.
  const named = game.me?.player?.handle ?? null;
  const asksHandle = !game.accountId || (game.status === "ready" && !named);
  const toast = useToast();
  const [at, setAt] = useState(0);
  const [locating, setLocating] = useState(false);
  // Not now stays available while the browser's prompt is open; a late answer then only moves the map.
  const waiting = useRef(false);
  const [value, setValue] = useState(() => readLocalHandle() ?? "");
  const [touched, setTouched] = useState(false);
  const field = useAnimationControls();
  const slide = SLIDES[at];
  const handle = normalizeHandle(value);
  // The handle is optional here: an empty field just means it's asked for at sign-in.
  const problem = handle && asksHandle ? handleProblem(handle) : null;
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

  const next = () => {
    sfx.tap();
    buzz(8);
    setAt(1);
  };

  const locate = (useGps: boolean) => {
    if (useGps && locating) return;
    // Field builds hand location to the app-wide watcher, which asks for permission itself.
    if (FIELD || !useGps || !navigator.geolocation) {
      waiting.current = false;
      setLocating(false);
      next();
      return;
    }
    waiting.current = true;
    setLocating(true);
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
      if (!waiting.current) return;
      waiting.current = false;
      setLocating(false);
      next();
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

  const finish = (event: FormEvent) => {
    event.preventDefault();
    setTouched(true);
    if (problem) {
      void field.start(shake);
      buzz([20, 30, 20]);
      return;
    }
    if (handle && asksHandle) {
      // Signed in without a handle yet: save it now. Signed out, it waits on this device.
      if (game.accountId)
        void game.saveHandle(handle).catch((error: unknown) => {
          const taken = error instanceof GameError && error.code === "handle_taken";
          toast(taken ? `Someone already has @${handle}. Pick another when you plant.` : `@${handle} couldn't be saved. Pick one when you plant.`, "kip");
          // A taken handle fills in the sheet later; a refused one shouldn't come back.
          if (taken) saveLocalHandle(handle);
        });
      else saveLocalHandle(handle);
    }
    sfx.chirp();
    dispatch({ type: "onboarded" });
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
        {at > 0 && (
          <button className="onboarding__skip" onClick={() => setAt(0)}>
            Back
          </button>
        )}
      </div>
      <div className="onboarding__visual" ref={visualRef}>
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.div
            key={at}
            className="onboarding__visual-inner"
            initial={{ x: 320, rotate: 8, opacity: 0 }}
            animate={{ x: 0, rotate: 0, opacity: 1 }}
            exit={{ x: -320, rotate: -8, opacity: 0 }}
            transition={{ type: "spring", stiffness: 260, damping: 26 }}
          >
            <div style={{ transform: `scale(${fit})` }}>{slide.visual === "go" ? <GoThere /> : <TakeOver />}</div>
          </motion.div>
        </AnimatePresence>
      </div>
      <div className="onboarding__copy">
        <AnimatePresence mode="wait" initial={false}>
          <motion.div key={at} initial="hidden" animate="show" exit="hidden" variants={{ show: { transition: { staggerChildren: 0.06 } } }}>
            <h1 className="onboarding__title">
              {slide.title.map((line) => (
                <motion.span key={line} variants={rise}>
                  {line}
                </motion.span>
              ))}
            </h1>
            <motion.p className="onboarding__body" variants={rise}>
              {slide.line}
            </motion.p>
          </motion.div>
        </AnimatePresence>
      </div>
      {at === 0 ? (
        <div className="onboarding__ask">
          <motion.button className="btn btn--block" whileTap={{ scale: 0.96 }} onClick={() => locate(true)} disabled={locating}>
            {FIELD ? (
              <>
                Next <Icon name="next" />
              </>
            ) : (
              <>
                <Icon name="locate" /> {locating ? "Finding you…" : "Allow location"}
              </>
            )}
          </motion.button>
          {!FIELD && (
            <>
              <p className="onboarding__note">Only used to check you're in a park.</p>
              <button className="permission__alt" onClick={() => locate(false)}>
                {DEMO_TOOLS ? "Use a demo spot in Victoria" : "Not now"}
              </button>
            </>
          )}
        </div>
      ) : (
        <form className="onboarding__ask" onSubmit={finish} noValidate>
          {named ? (
            <p className="onboarding__note">Playing as @{named}</p>
          ) : asksHandle ? (
            <>
              <label className="fb-label" htmlFor="onboarding-handle">
                Pick your handle
              </label>
              <motion.div className="handle-input" animate={field}>
                <span aria-hidden="true">@</span>
                <input
                  id="onboarding-handle"
                  className="fb-input"
                  value={value}
                  onChange={(event) => setValue(event.target.value)}
                  onBlur={() => setTouched(true)}
                  maxLength={21}
                  autoComplete="off"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  placeholder="yourname"
                  aria-invalid={touched && !!problem}
                  aria-describedby="onboarding-handle-help"
                />
              </motion.div>
              <p id="onboarding-handle-help" className={`handle-sheet__help ${touched && problem ? "is-error" : ""}`}>
                {touched && problem ? problem : game.accountId ? "Friends see it on the map and the leaderboard." : "Kept on this phone until you sign in."}
              </p>
            </>
          ) : null}
          <motion.button className="btn btn--block" type="submit" whileTap={{ scale: 0.96 }}>
            Let's go! <Icon name="next" />
          </motion.button>
        </form>
      )}
    </motion.div>
  );
}

const rise = {
  hidden: { y: 18, opacity: 0 },
  show: { y: 0, opacity: 1, transition: { type: "spring" as const, stiffness: 400, damping: 30 } },
};
