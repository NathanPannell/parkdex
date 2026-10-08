import { animate, AnimatePresence, motion, useMotionValue, useTransform } from "motion/react";
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
import { parkHolder, visitHeadline } from "../lib/game/visit";
import { useStore } from "../lib/store";
import "../game.css";

const HOLD_MS = 1200;

type Phase = "charge" | "sending" | "done" | "failed";
type Failure = { message: string; action: "retry" | "sign-in" | "handle" };

function failureFor(error: unknown): Failure {
  if (error instanceof GameError) {
    if (error.code === "offline") return { message: "You need a connection to plant your flag. Check your signal and try again.", action: "retry" };
    if (error.code === "unauthenticated") return { message: "Sign in again to plant your flag.", action: "sign-in" };
    if (error.code === "handle_required") return { message: "Pick a handle first. Your flag comes with it.", action: "handle" };
  }
  return { message: gameErrorMessage(error), action: "retry" };
}

/** The flag visit: hold to plant, take or visit, then show what the server decided. */
export function Plant() {
  const { state, dispatch } = useStore();
  const auth = useAuth();
  const game = useGame();
  const content = useContent();
  const [parkId] = useState(() => state.tripId ?? "");
  // One id per visit attempt, reused on retries so the server can deduplicate.
  const [visitId] = useState(createVisitId);
  const [accountId] = useState(() => auth.ownerAccountId);
  const park = content?.parkById.get(parkId);
  const parkName = park?.short ?? park?.name ?? "this park";
  const me = game.me?.player ?? null;
  const [holder] = useState(() => parkHolder(parkId, game.flags?.byPark, me?.handle));
  const [phase, setPhase] = useState<Phase>("charge");
  const [holding, setHolding] = useState(false);
  const [result, setResult] = useState<VisitResult | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [points, setPoints] = useState(0);
  const progress = useMotionValue(0);
  const ring = useTransform(progress, (p) => 289 * (1 - p));
  const lift = useTransform(progress, (p) => -p * 14);
  const anim = useRef<ReturnType<typeof animate> | null>(null);
  const lastTick = useRef(0);
  const sending = useRef(false);

  const before = holder.kind === "other" || holder.kind === "mine" ? holder.flag : null;
  const beforeDays = before ? flagAgeDays(before.since, game.serverNow()) : 0;
  const title = holder.kind === "other" ? `Take it from @${holder.flag.handle}` : holder.kind === "mine" ? "Visit your flag" : "Plant your flag";
  const verb = holder.kind === "other" ? "take it" : holder.kind === "mine" ? "visit" : "plant";

  useEffect(() => {
    if (!parkId || !accountId) dispatch({ type: "go", screen: "map" });
  }, [accountId, dispatch, parkId]);

  async function send() {
    if (sending.current || !accountId) return;
    sending.current = true;
    setPhase("sending");
    setFailure(null);
    try {
      const visit = await sendVisit(accountId, { visitId, parkId });
      setResult(visit);
      setPhase("done");
      celebrate(visit);
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

  function celebrate(visit: VisitResult) {
    if (visit.outcome === "planted" || visit.outcome === "took") {
      sfx.claim();
      buzz([40, 40, 80, 40, 160]);
      burst({ x: 0.5, y: 0.4 }, 1.2);
      setTimeout(cannons, 350);
      setTimeout(() => setPoints(visit.pointsEarned), 700);
      setTimeout(() => sfx.chirp(), 900);
    } else {
      sfx.pop();
      buzz(20);
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
          buzz(6 + step * 2);
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

  const leave = (screen: "map" | "parks") => {
    dispatch({ type: "trip", id: null });
    if (screen === "map" && park) dispatch({ type: "focus", id: park.id });
    dispatch({ type: "go", screen });
  };

  const won = result && (result.outcome === "planted" || result.outcome === "took");
  const flying: { seed: string; days: number; key: string } | null = won && me
    ? { seed: me.flagSeed, days: 0, key: "mine" }
    : result && me && (result.outcome === "held" || result.outcome === "already_today")
      ? { seed: me.flagSeed, days: result.flagSince ? flagAgeDays(result.flagSince, game.serverNow()) : beforeDays, key: "mine" }
      : before
        ? { seed: before.flagSeed, days: beforeDays, key: "before" }
        : null;
  const headline = result ? visitHeadline(result, parkName) : null;

  return (
    <motion.div className="screen claim plant" exit={{ opacity: 0, transition: { duration: 0.3 } }} initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
      <motion.div className="claim__glow" style={{ opacity: won ? 1 : 0.5, background: "radial-gradient(circle, #ffc93c 0%, transparent 62%)" }} />

      <div className="claim__head">
        <AnimatePresence mode="wait">
          {!headline ? (
            <motion.div key="a" initial={{ y: -20, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: -20, opacity: 0 }}>
              <span className="eyebrow eyebrow--light">At {parkName}</span>
              <h1>{title}</h1>
            </motion.div>
          ) : (
            <motion.div key="b" initial={{ scale: 2.4, rotate: -16, opacity: 0 }} animate={{ scale: 1, rotate: -3, opacity: 1 }} transition={{ type: "spring", stiffness: 520, damping: 15, delay: 0.2 }}>
              <span className={`claim__stamp plant__stamp ${won ? "" : "plant__stamp--quiet"}`}>{headline.title}</span>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <div className="claim__stage">
        {won && (
          <>
            <div className="claim__rays">
              <Rays color="#FFE27A" size={620} opacity={0.45} speed={20} />
            </div>
            {[0, 1, 2].map((i) => (
              <motion.span key={i} className="shock" initial={{ scale: 0.2, opacity: 0.9 }} animate={{ scale: 3.2, opacity: 0 }} transition={{ duration: 1, delay: i * 0.12, ease: "easeOut" }} />
            ))}
          </>
        )}
        <div className="plant__pole-wrap">
          <span className="plant__pole" />
          <span className="plant__finial" />
          <motion.div className="plant__cloth" style={{ y: lift }}>
            <AnimatePresence>
              {won && before && (
                <motion.div key="fallen" className="plant__flag" initial={{ y: 0, opacity: 1, rotate: 0 }} animate={{ y: 220, opacity: 0, rotate: 30 }} transition={{ duration: 0.9, ease: "easeIn" }}>
                  <Flag seed={before.flagSeed} size={150} days={beforeDays} />
                </motion.div>
              )}
            </AnimatePresence>
            <AnimatePresence mode="wait">
              {flying ? (
                <motion.div
                  key={flying.key}
                  className={`plant__flag ${phase === "done" ? "plant__flag--wave" : ""}`}
                  initial={won ? { y: 200, opacity: 0 } : { opacity: 0 }}
                  animate={{ y: 0, opacity: 1 }}
                  transition={won ? { type: "spring", stiffness: 120, damping: 14, delay: 0.5 } : { duration: 0.3 }}
                >
                  <Flag seed={flying.seed} size={150} days={flying.days} label={flying.key === "before" && before ? `Flag of @${before.handle}` : "Your flag"} />
                </motion.div>
              ) : (
                <motion.div key="empty" className="plant__flag plant__flag--empty" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                  <Flag seed={null} size={150} />
                </motion.div>
              )}
            </AnimatePresence>
          </motion.div>
        </div>
      </div>

      <div className="claim__foot">
        <AnimatePresence mode="wait">
          {phase === "done" && result && headline ? (
            <motion.div key="done" className="claim__done" initial="hidden" animate="show" variants={{ show: { transition: { staggerChildren: 0.08, delayChildren: 0.5 } } }}>
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
                      <button className="btn btn--sm btn--sun" onClick={() => void send()}>
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
