import { animate, AnimatePresence, motion, useMotionValue, useReducedMotion } from "motion/react";
import { useEffect, useState } from "react";
import { Flag } from "../../components/Flag";
import { Icon } from "../../components/Icon";
import { Bubble, Kip } from "../../components/Kip";
import { Rays } from "../../components/Motion";
import { burst, cannons } from "../../lib/confetti";
import { buzz, sfx } from "../../lib/feedback";
import type { FoundResult } from "../../lib/founders";
import { countStepMs, flagConfetti } from "../../lib/game/plantScene";
import { visitHeadline } from "../../lib/game/visit";
import "../../game.css";

type Props = {
  result: Extract<FoundResult, { outcome: "founded" }>;
  /** The approved photo as taken, so the cover shows without waiting for the network. */
  photo: string;
  flagSeed: string | null;
  onClose: (showParkId?: string) => void;
};

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function shakeFrames(amplitude: number): number[] {
  return [0, -1, 0.85, -0.62, 0.42, -0.24, 0.1, 0].map((step) => Math.round(step * amplitude * 10) / 10);
}

/**
 * The founding moment, in the flag plant's style: the cover photo slams down like a planted
 * flag with a shake and confetti, the stamp lands, and the founder points count up.
 */
export function FoundCelebration({ result, photo, flagSeed, onClose }: Props) {
  const reduce = useReducedMotion() ?? false;
  const [landed, setLanded] = useState(reduce);
  const [points, setPoints] = useState(reduce ? result.founderPoints : 0);
  const [done, setDone] = useState(reduce);
  const camX = useMotionValue(0);
  const camY = useMotionValue(0);
  const name = result.park.name;
  const visit = result.visit;
  const headline = visit ? visitHeadline(visit, name) : null;
  const visitWon = visit?.outcome === "planted" || visit?.outcome === "took";

  useEffect(() => {
    if (reduce) {
      sfx.pop();
      return;
    }
    let live = true;
    void (async () => {
      await wait(520);
      if (!live) return;
      setLanded(true);
      sfx.thud();
      sfx.boom();
      buzz([120, 40, 80, 40, 40]);
      void animate(camX, shakeFrames(16), { duration: 0.6 });
      void animate(camY, shakeFrames(9), { duration: 0.55 });
      const colours = flagConfetti(flagSeed);
      burst({ x: 0.5, y: 0.42 }, 1.3, colours);
      setTimeout(() => cannons(colours), 260);
      sfx.cheer();
      await wait(650);
      const step = countStepMs(result.founderPoints);
      for (let value = 1; value <= result.founderPoints && live; value += 1) {
        setPoints(value);
        sfx.coin(value);
        if (value % 2 === 1) buzz(6);
        await wait(step);
      }
      if (!live) return;
      sfx.claim();
      setDone(true);
    })();
    return () => { live = false; };
  }, []);

  return (
    <motion.div className="screen claim found-done" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, transition: { duration: 0.3 } }} role="dialog" aria-label={`You founded ${name}`}>
      <motion.div className="claim__glow" style={{ opacity: landed ? 1 : 0.4, background: "radial-gradient(circle, #ffc93c 0%, transparent 62%)" }} />

      <div className="claim__head">
        <AnimatePresence mode="wait">
          {landed ? (
            <motion.div key="stamp" initial={{ scale: 2.4, rotate: -16, opacity: 0 }} animate={{ scale: 1, rotate: -3, opacity: 1 }} transition={{ type: "spring", stiffness: 520, damping: 15 }}>
              <span className="claim__stamp plant__stamp">Founded!</span>
              <h1 className="found-done__title">You founded {name}</h1>
            </motion.div>
          ) : (
            <motion.div key="lead" initial={{ y: -20, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: -20, opacity: 0 }}>
              <span className="eyebrow eyebrow--light">Photo approved</span>
              <h1 className="found-done__title">{name}</h1>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <div className="claim__stage">
        {landed && (
          <div className="claim__rays">
            <Rays color="#FFE27A" size={620} opacity={0.4} speed={20} />
          </div>
        )}
        <motion.div className="found-done__camera" style={{ x: camX, y: camY }}>
          <motion.div
            className="polaroid found-done__cover"
            initial={reduce ? false : { y: -520, rotate: -18, scale: 1.25 }}
            animate={{ y: 0, rotate: -4, scale: 1 }}
            transition={{ type: "spring", stiffness: 420, damping: 22, delay: 0.1 }}
          >
            <span className="tape" />
            <div className="polaroid__img">
              <img src={photo} alt={`Cover photo of ${name}`} />
            </div>
            <span className="polaroid__caption">Founded by you</span>
          </motion.div>
          {landed && !reduce && (
            <motion.span className="found-done__ring" initial={{ scale: 0.3, opacity: 0.9 }} animate={{ scale: 2.4, opacity: 0 }} transition={{ duration: 0.7, ease: "easeOut" }} aria-hidden="true" />
          )}
        </motion.div>

        <AnimatePresence>
          {landed && (
            <motion.div
              key="points"
              className="plant-score found-done__points"
              initial={{ scale: 3, opacity: 0, rotate: -12 }}
              animate={{ scale: 1, opacity: 1, rotate: -6 }}
              transition={{ type: "spring", stiffness: 520, damping: 14, delay: 0.4 }}
              aria-live="polite"
            >
              <motion.strong key={points} initial={{ scale: 1.35 }} animate={{ scale: 1 }} transition={{ type: "spring", stiffness: 700, damping: 18 }}>
                +{points}
              </motion.strong>
              <span>founder points</span>
            </motion.div>
          )}
        </AnimatePresence>

        <AnimatePresence>
          {landed && (
            <motion.div key="kip" className="plant-kip" initial={{ y: 160, rotate: 20 }} animate={{ y: 0, rotate: 0 }} transition={{ type: "spring", stiffness: 300, damping: 13, delay: 0.25 }}>
              <Kip pose="celebrate" size={104} flip />
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <div className="claim__foot">
        <AnimatePresence>
          {done && (
            <motion.div key="done" className="claim__done" initial="hidden" animate="show" variants={{ show: { transition: { staggerChildren: 0.08, delayChildren: 0.05 } } }}>
              <motion.div className="claim__kip plant__bubble" variants={pop}>
                <Bubble side="to-right" style={{ position: "relative" }}>KLEEP! Your photo is the cover now!</Bubble>
              </motion.div>
              {headline && (
                <motion.div className={`found-done__visit${visitWon ? " is-won" : ""}`} variants={pop}>
                  {flagSeed ? <Flag seed={flagSeed} size={40} className="is-waving" /> : <Icon name="flag" size={22} />}
                  <span>
                    <strong>{headline.title}{visit && visit.outcome === "took" && visit.pointsEarned > 0 ? ` · +${visit.pointsEarned}` : ""}</strong>
                    <em>{headline.detail}</em>
                  </span>
                </motion.div>
              )}
              <motion.div variants={pop} className="claim__row">
                <button className="btn btn--sm btn--sun" onClick={() => onClose(result.park.id)}>
                  <Icon name="pin" size={18} /> See the park
                </button>
                <button className="btn btn--sm btn--paper" onClick={() => onClose()}>
                  <Icon name="map" size={18} /> Back to map
                </button>
              </motion.div>
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
