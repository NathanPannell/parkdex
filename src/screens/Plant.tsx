import { animate, AnimatePresence, motion, useAnimationFrame, useMotionValue, useReducedMotion, useTransform } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { Flag } from "../components/Flag";
import { Icon } from "../components/Icon";
import { Bubble, Kip } from "../components/Kip";
import { RollingNumber, Rays } from "../components/Motion";
import { burst, cannons } from "../lib/confetti";
import { buzz, sfx } from "../lib/feedback";
import { useAuth } from "../lib/accounts/AuthProvider";
import { useContent } from "../lib/content/provider";
import { createVisitId, GameError, gameErrorMessage, sendVisit, type VisitResult } from "../lib/game/client";
import { flagAgeDays } from "../lib/game/flag";
import { useGame } from "../lib/game/GameProvider";
import { dirtClods, plantBeats, standingRival, startsPlanted } from "../lib/game/plantScene";
import { parkHolder, visitHeadline } from "../lib/game/visit";
import { useStore } from "../lib/store";
import "../game.css";

const HOLD_MS = 1100;
// How high the flag is carried above the mound before it is driven in, in pixels.
const ALOFT = -96;
const HOLD_LIFT = 30;
const FURLED = 0.16;

type Phase = "charge" | "sending" | "playing" | "done" | "failed";
type Failure = { message: string; action: "retry" | "sign-in" | "handle" };

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function failureFor(error: unknown): Failure {
  if (error instanceof GameError) {
    if (error.code === "offline") return { message: "You need a connection to plant your flag. Check your signal and try again.", action: "retry" };
    if (error.code === "unauthenticated") return { message: "Sign in again to plant your flag.", action: "sign-in" };
    if (error.code === "handle_required") return { message: "Pick a handle first. Your flag comes with it.", action: "handle" };
  }
  return { message: gameErrorMessage(error), action: "retry" };
}

/**
 * The flag visit. Hold to lift your flag over the mound; when the server answers, an old
 * flag is knocked over, yours is driven into the dirt, soil kicks up, the cloth unfurls,
 * and the points count up.
 */
export function Plant() {
  const { state, dispatch } = useStore();
  const auth = useAuth();
  const game = useGame();
  const content = useContent();
  const reduce = useReducedMotion() ?? false;
  const [parkId] = useState(() => state.tripId ?? "");
  // One id per visit attempt, reused on retries so the server can deduplicate.
  const [visitId] = useState(createVisitId);
  const [accountId] = useState(() => auth.ownerAccountId);
  const park = content?.parkById.get(parkId);
  const parkName = park?.short ?? park?.name ?? "this park";
  const me = game.me?.player ?? null;
  const [holder] = useState(() => parkHolder(parkId, game.flags?.byPark, me?.handle));
  const rival = standingRival(holder);
  const rivalDays = rival ? flagAgeDays(rival.since, game.serverNow()) : 0;
  const mineFirst = startsPlanted(holder);
  const ownDays = holder.kind === "mine" ? flagAgeDays(holder.flag.since, game.serverNow()) : 0;
  const [phase, setPhase] = useState<Phase>("charge");
  const [holding, setHolding] = useState(false);
  const [result, setResult] = useState<VisitResult | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [points, setPoints] = useState(0);
  const [impact, setImpact] = useState(0);
  const [waving, setWaving] = useState(mineFirst);

  const progress = useMotionValue(0);
  const ring = useTransform(progress, (p) => 289 * (1 - p));
  const base = useMotionValue(mineFirst ? 0 : ALOFT);
  const flagY = useMotionValue(mineFirst ? 0 : ALOFT);
  const shake = useMotionValue(0);
  const cloth = useMotionValue(mineFirst ? 1 : FURLED);
  const rivalRotate = useMotionValue(0);
  const rivalX = useMotionValue(0);
  const rivalOpacity = useMotionValue(1);
  const sceneX = useMotionValue(0);
  const moundScaleX = useMotionValue(1);
  const moundScaleY = useMotionValue(1);
  const anim = useRef<ReturnType<typeof animate> | null>(null);
  const lastTick = useRef(0);
  const sending = useRef(false);

  const title = holder.kind === "other" ? `Take it from @${holder.flag.handle}` : holder.kind === "mine" ? "Visit your flag" : "Plant your flag";
  const verb = holder.kind === "other" ? "take it" : holder.kind === "mine" ? "visit" : "plant";
  const flagSeed = me?.flagSeed ?? game.me?.flagSeed ?? null;

  useEffect(() => {
    if (!parkId || !accountId) dispatch({ type: "go", screen: "map" });
  }, [accountId, dispatch, parkId]);

  // While charging, the flag rises and trembles in your hands.
  useAnimationFrame((t) => {
    if (phase !== "charge" && phase !== "sending") return;
    const p = progress.get();
    flagY.set(base.get() - p * HOLD_LIFT);
    shake.set(reduce ? 0 : Math.sin(t / 26) * p * p * 5);
  });

  async function send() {
    if (sending.current || !accountId) return;
    sending.current = true;
    setPhase("sending");
    setFailure(null);
    try {
      const visit = await sendVisit(accountId, { visitId, parkId });
      setResult(visit);
      setPhase("playing");
      await play(visit);
      setPhase("done");
      void game.refresh();
      void game.refreshFlags();
    } catch (error) {
      const next = failureFor(error);
      setFailure(next);
      setPhase("failed");
      progress.set(0);
      lastTick.current = 0;
      if (next.action === "handle") game.openHandleSheet({ onDone: () => void send() });
    } finally {
      sending.current = false;
    }
  }

  async function play(visit: VisitResult) {
    const beats = plantBeats(visit.outcome);
    shake.set(0);
    if (reduce) {
      // Reduced motion: land on the final picture with one gentle cue.
      if (beats.includes("topple")) rivalOpacity.set(0);
      if (beats.includes("slam")) {
        flagY.set(0);
        cloth.set(1);
        setWaving(true);
        sfx.pop();
        buzz(30);
      } else {
        flagY.set(mineFirst ? 0 : ALOFT);
      }
      setPoints(visit.pointsEarned);
      return;
    }
    if (beats.includes("topple")) {
      sfx.topple();
      await animate(rivalRotate, 86, { duration: 0.5, ease: [0.55, 0, 0.95, 0.5] });
      buzz(45);
      void animate(rivalX, 24, { duration: 0.2 });
      void animate(rivalOpacity, 0, { duration: 0.5, delay: 0.35 });
    }
    if (beats.includes("slam")) {
      // A quick wind-up, then the pole is driven home.
      await animate(flagY, flagY.get() - 46, { duration: 0.16, ease: "easeOut" });
      await animate(flagY, 0, { duration: 0.14, ease: [0.7, 0, 1, 0.6] });
      sfx.thud();
      buzz([80, 40, 40]);
      setImpact((n) => n + 1);
      void animate(sceneX, [0, -10, 8, -5, 3, 0], { duration: 0.42 });
      void animate(moundScaleY, [1, 0.8, 1.06, 1], { duration: 0.45 });
      void animate(moundScaleX, [1, 1.12, 0.97, 1], { duration: 0.45 });
      await wait(140);
    }
    if (beats.includes("unfurl")) {
      sfx.flap();
      await animate(cloth, [cloth.get(), 1.1, 0.95, 1], { duration: 0.6, ease: "easeOut" });
      setWaving(true);
    }
    if (beats.includes("settle")) {
      await animate(flagY, mineFirst ? 0 : ALOFT, { type: "spring", stiffness: 260, damping: 18 });
      sfx.pop();
      buzz(15);
    }
    if (beats.includes("points")) {
      if (visit.outcome === "took" || visit.outcome === "planted") {
        sfx.claim();
        burst({ x: 0.5, y: 0.42 }, 1.1);
        setTimeout(cannons, 300);
        setTimeout(() => sfx.chirp(), 800);
      }
      setTimeout(() => setPoints(visit.pointsEarned), 450);
    }
  }

  const start = (event: React.PointerEvent) => {
    if (phase !== "charge" || sending.current) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    setHolding(true);
    anim.current?.stop();
    anim.current = animate(progress, 1, {
      duration: (HOLD_MS / 1000) * (1 - progress.get()),
      ease: "easeIn",
      onUpdate: (p) => {
        const step = Math.floor(p * 10);
        if (step > lastTick.current) {
          lastTick.current = step;
          sfx.charge(p);
          buzz(5 + step * 2);
        }
      },
      onComplete: () => {
        setHolding(false);
        void send();
      },
    });
  };

  const release = () => {
    if (phase !== "charge" || progress.get() >= 1) return;
    setHolding(false);
    lastTick.current = 0;
    anim.current?.stop();
    anim.current = animate(progress, 0, { type: "spring", stiffness: 300, damping: 24 });
  };

  const retry = () => {
    progress.set(0);
    flagY.set(base.get());
    void send();
  };

  const leave = (screen: "map" | "parks") => {
    dispatch({ type: "trip", id: null });
    if (screen === "map" && park) dispatch({ type: "focus", id: park.id });
    dispatch({ type: "go", screen });
  };

  const won = !!result && (result.outcome === "planted" || result.outcome === "took");
  const headline = result ? visitHeadline(result, parkName) : null;
  const flagDays = result?.outcome === "held" && result.flagSince ? flagAgeDays(result.flagSince, game.serverNow()) : mineFirst ? ownDays : 0;
  const clods = impact > 0 && !reduce ? dirtClods(16, impact) : [];

  return (
    <motion.div className="screen claim plant" exit={{ opacity: 0, transition: { duration: 0.3 } }} initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
      <motion.div className="claim__glow" style={{ opacity: won && phase === "done" ? 1 : 0.45, background: "radial-gradient(circle, #ffc93c 0%, transparent 62%)" }} />

      <div className="claim__head">
        <AnimatePresence mode="wait">
          {!headline || phase === "playing" ? (
            <motion.div key="a" initial={{ y: -20, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: -20, opacity: 0 }}>
              <span className="eyebrow eyebrow--light">At {parkName}</span>
              <h1>{title}</h1>
            </motion.div>
          ) : (
            <motion.div key="b" initial={{ scale: 2.4, rotate: -16, opacity: 0 }} animate={{ scale: 1, rotate: -3, opacity: 1 }} transition={{ type: "spring", stiffness: 520, damping: 15 }}>
              <span className={`claim__stamp plant__stamp ${won ? "" : "plant__stamp--quiet"}`}>{headline.title}</span>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <div className="claim__stage">
        {won && phase === "done" && (
          <div className="claim__rays">
            <Rays color="#FFE27A" size={620} opacity={0.4} speed={20} />
          </div>
        )}
        <motion.div className="plant-scene" style={{ x: sceneX }}>
          {rival && (
            <motion.div className="plant-flag plant-flag--rival" style={{ rotate: rivalRotate, x: rivalX, opacity: rivalOpacity }} aria-label={`Flag of @${rival.handle}`} role="img">
              <span className="plant-flag__pole" />
              <span className="plant-flag__cloth plant-flag__cloth--wave">
                <Flag seed={rival.flagSeed} size={124} days={rivalDays} />
              </span>
            </motion.div>
          )}
          {flagSeed && (
            <motion.div className="plant-flag" style={{ y: flagY, rotate: shake }} aria-label="Your flag" role="img">
              <span className="plant-flag__pole" />
              <motion.span className={`plant-flag__cloth ${waving ? "plant-flag__cloth--wave" : ""}`} style={{ scaleX: cloth }}>
                <Flag seed={flagSeed} size={124} days={flagDays} />
              </motion.span>
            </motion.div>
          )}
          <motion.svg className="plant-mound" viewBox="0 0 260 90" style={{ scaleX: moundScaleX, scaleY: moundScaleY }} aria-hidden="true">
            <ellipse cx="130" cy="82" rx="122" ry="8" fill="rgba(0,0,0,.35)" />
            <path d="M8 80 C 40 30, 90 14, 130 14 C 170 14, 220 30, 252 80 Z" fill="#6B4423" />
            <path d="M30 62 C 60 30, 100 22, 130 22 C 160 22, 200 30, 230 62 C 190 50, 70 50, 30 62 Z" fill="#8B5A2B" />
            <path d="M120 16 l4 -10 l3 10 M136 17 l5 -9 l1 10 M96 22 l2 -8 l4 8 M160 22 l4 -8 l2 9" stroke="#7A9A3A" strokeWidth="3" strokeLinecap="round" fill="none" />
            <path d="M60 70 q6 -3 12 0 M180 66 q6 -3 12 0 M120 54 q5 -3 10 0" stroke="#5A3A1E" strokeWidth="3" strokeLinecap="round" fill="none" />
          </motion.svg>
          <div className="plant-dirt" aria-hidden="true">
            <AnimatePresence>
              {impact > 0 && !reduce && (
                <motion.span
                  key={`puff-${impact}`}
                  className="plant-dirt__puff"
                  initial={{ scale: 0.3, opacity: 0.75 }}
                  animate={{ scale: 2.4, opacity: 0 }}
                  transition={{ duration: 0.7, ease: "easeOut" }}
                />
              )}
            </AnimatePresence>
            {clods.map((clod, index) => (
              <motion.span
                key={`${impact}-${index}`}
                className="plant-dirt__clod"
                style={{ width: clod.size, height: clod.size, background: clod.color }}
                initial={{ x: 0, y: 0, opacity: 1, rotate: 0 }}
                animate={{ x: clod.x, y: [0, clod.peak, clod.y], opacity: [1, 1, 0], rotate: clod.rotate }}
                transition={{ duration: 0.8, delay: clod.delay, times: [0, 0.45, 1], ease: "easeOut" }}
              />
            ))}
          </div>
        </motion.div>
      </div>

      <div className="claim__foot">
        <AnimatePresence mode="wait">
          {phase === "done" && result && headline ? (
            <motion.div key="done" className="claim__done" initial="hidden" animate="show" variants={{ show: { transition: { staggerChildren: 0.08, delayChildren: 0.15 } } }}>
              <motion.div className="claim__kip" variants={pop}>
                <Bubble side="to-right" style={{ position: "relative", marginBottom: 22 }}>
                  {result.outcome === "took" ? "KLEEP! It's yours now!" : result.outcome === "planted" ? "KLEEP! Flag's up!" : result.outcome === "held" ? "Still flying!" : "See you tomorrow!"}
                </Bubble>
                <Kip pose={won ? "celebrate" : "cheer"} size={84} flip />
              </motion.div>
              {result.outcome === "took" && (
                <motion.p className="plant__points" variants={pop}>
                  <span>+<RollingNumber value={points} /></span>
                  <span>{result.pointsEarned === 1 ? "point" : "points"}</span>
                </motion.p>
              )}
              {result.outcome === "planted" && (
                <motion.p className="plant__points plant__points--rate" variants={pop}>
                  <span>+1</span>
                  <span>point a day</span>
                </motion.p>
              )}
              <motion.p className="plant__detail" variants={pop}>{headline.detail}</motion.p>
              <motion.div variants={pop} className="claim__row">
                <button className="btn btn--sm btn--sun" onClick={() => leave("parks")}>
                  <Icon name="flag" size={18} /> Your parks
                </button>
                <button className="btn btn--sm btn--paper" onClick={() => leave("map")}>
                  <Icon name="map" size={18} /> Back to map
                </button>
              </motion.div>
            </motion.div>
          ) : phase === "playing" ? (
            <motion.div key="playing" className="hold" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} />
          ) : (
            <motion.div key="hold" className="hold" initial={{ y: 60, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 40, opacity: 0, scale: 0.8 }} transition={{ type: "spring", delay: 0.2 }}>
              {phase === "failed" && failure ? (
                <div className="claim-save-error plant__error" role="alert">
                  <p>{failure.message}</p>
                  <div className="claim__row">
                    {failure.action === "sign-in" ? (
                      <button className="btn btn--sm btn--sun" onClick={() => dispatch({ type: "go", screen: "account" })}>Sign in</button>
                    ) : failure.action === "handle" ? (
                      <button className="btn btn--sm btn--sun" onClick={() => game.openHandleSheet({ onDone: () => void send() })}>Pick a handle</button>
                    ) : (
                      <button className="btn btn--sm btn--sun" onClick={retry}>
                        <Icon name="refresh" size={18} /> Try again
                      </button>
                    )}
                    <button className="btn btn--sm btn--paper" onClick={() => leave("map")}>Back to map</button>
                  </div>
                </div>
              ) : (
                <>
                  <motion.button
                    className="hold__btn"
                    onPointerDown={start}
                    onPointerUp={release}
                    onPointerCancel={release}
                    onContextMenu={(event) => event.preventDefault()}
                    animate={{ scale: holding ? 0.92 : 1 }}
                    transition={{ type: "spring", stiffness: 500, damping: 20 }}
                    aria-label={`Hold to ${verb}`}
                    disabled={phase === "sending"}
                  >
                    <svg viewBox="0 0 100 100" className="hold__ring">
                      <circle cx="50" cy="50" r="46" fill="none" stroke="rgba(255,248,236,.18)" strokeWidth="7" />
                      <motion.circle cx="50" cy="50" r="46" fill="none" stroke="#FFC93C" strokeWidth="7" strokeLinecap="round" strokeDasharray="289" style={{ strokeDashoffset: ring }} transform="rotate(-90 50 50)" />
                    </svg>
                    <span className="hold__core">
                      <Icon name="flag" size={30} stroke={2.6} />
                    </span>
                  </motion.button>
                  <motion.p className="hold__label" animate={{ opacity: holding ? 0.5 : 1 }}>
                    {phase === "sending" ? "Planting…" : holding ? "Keep holding…" : `Press and hold to ${verb}`}
                  </motion.p>
                </>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </motion.div>
  );
}

const pop = {
  hidden: { y: 30, opacity: 0, scale: 0.9 },
  show: { y: 0, opacity: 1, scale: 1, transition: { type: "spring" as const, stiffness: 420, damping: 22 } },
};
