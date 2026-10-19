import { animate, AnimatePresence, motion, useAnimationFrame, useMotionValue, useReducedMotion, useTransform, type MotionValue } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { BadgeUnlock } from "../components/BadgeUnlock";
import { AddDexPhoto } from "../components/DexPhoto";
import { Flag } from "../components/Flag";
import { Icon } from "../components/Icon";
import { Kip } from "../components/Kip";
import { Rays } from "../components/Motion";
import { burst, cannons } from "../lib/confetti";
import { buzz, sfx } from "../lib/feedback";
import { startPhotoCapture } from "../lib/captureMode";
import { useAuth } from "../lib/accounts/AuthProvider";
import { useFeatureFlag } from "../lib/appConfig";
import { useContent } from "../lib/content/provider";
import { createVisitId, GameError, gameErrorMessage, joinCrew, sendVisit, type Crew, type GameErrorCode, type VisitResult } from "../lib/game/client";
import { Pennant } from "../components/CrewList";
import { friendOffers } from "../lib/game/crew";
import { useCrew } from "../lib/game/CrewProvider";
import { useFriends } from "../lib/friends/FriendsProvider";
import { badgeById } from "../lib/game/badges";
import { flagAgeDays } from "../lib/game/flag";
import { useGame } from "../lib/game/GameProvider";
import { countStepMs, dirtClods, flagConfetti, plantPlan, standingRival, startsPlanted } from "../lib/game/plantScene";
import { parkHolder, plantCheer, visitHeadline } from "../lib/game/visit";
import { handleFit } from "../lib/game/handleFit";
import { useKipTip } from "../lib/kipTips";
import { canLeavePlant, leavePlant, reportPlantPhase, type PlantPhase } from "../lib/game/plantExit";
import { openDexOn } from "../lib/dex/prefs";
import { useStore } from "../lib/store";
import "../game.css";

const HOLD_MS = 1100;
// Where the flag is carried, how high the hold lifts it, and where it hangs before the slam.
const ALOFT = -70;
const HOLD_LIFT = 34;
const HANG = -112;
const FURLED = 0.16;
const CARRY_X = -74;
const CARRY_TILT = -12;
const ZOOM = 0.1;
const DIM = 0.72;

type Failure = { message: string; action: "retry" | "sign-in" | "handle" | "none" };
// A crew join refused for one of these reasons will be refused again, so it offers no retry (#171).
const FINAL_JOIN_ERRORS = new Set<GameErrorCode>([
  "invalid_code",
  "code_not_found",
  "code_expired",
  "crew_full",
  "already_today",
  "park_not_found",
  "account_deleting",
  "visit_id_reused",
]);
// Where the pennant waits low on the leader's pole before it is hoisted (#171).
const PENNANT_LOW = 112;
// The scene's own size; it scales down to fit the space the result text leaves it.
const SCENE_WIDTH = 280;
const SCENE_HEIGHT = 330;
type Score = { value: number; target: number };

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function failureFor(error: unknown): Failure {
  if (error instanceof GameError) {
    if (error.code === "offline") return { message: "You need a connection to plant your flag. Check your signal and try again.", action: "retry" };
    if (error.code === "unauthenticated") return { message: "Sign in again to plant your flag.", action: "sign-in" };
    if (error.code === "handle_required") return { message: "Pick a handle first. Your flag comes with it.", action: "handle" };
    if (FINAL_JOIN_ERRORS.has(error.code)) return { message: error.message, action: "none" };
  }
  return { message: gameErrorMessage(error), action: "retry" };
}

/** A decaying shake: big at the moment of impact, settling to nothing. */
function shakeFrames(amplitude: number): number[] {
  return [0, -1, 0.85, -0.62, 0.42, -0.24, 0.1, 0].map((step) => Math.round(step * amplitude * 10) / 10);
}

function run(value: MotionValue<number>, to: number | number[], options: Parameters<typeof animate>[2]) {
  return animate(value, to as never, options);
}

/**
 * How far the flag scene shrinks to fit its stage, which gets shorter as the result text and
 * buttons arrive below it. The flag, Kip and the points scale together, so none of them ever
 * runs into the text.
 */
function useSceneFit() {
  const stage = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState(1);
  useEffect(() => {
    const element = stage.current;
    if (!element) return;
    const measure = () => {
      const { clientWidth, clientHeight } = element;
      if (!clientWidth || !clientHeight) return;
      setFit(Math.max(0.5, Math.min(1, clientHeight / SCENE_HEIGHT, clientWidth / (SCENE_WIDTH + 60))));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [stage, fit] as const;
}

/**
 * The flag visit as a reward moment. Holding dims the world, zooms toward the mound and lifts
 * your flag high. When the server answers: a rival's flag is yanked out and thrown away, yours
 * hangs for a beat and slams down with squash, a shockwave, a dirt explosion and a decaying
 * camera shake, the cloth unfurls into a steady wave, confetti in your colours bursts, Kip
 * cheers and the points slam in and count up coin by coin.
 */
export function Plant() {
  const { state, dispatch } = useStore();
  const auth = useAuth();
  const game = useGame();
  const content = useContent();
  const reduce = useReducedMotion() ?? false;
  const [parkId] = useState(() => state.tripId ?? "");
  // A crew join (#171) arrives with its code and its own visit ID from the join card.
  const crewUi = useCrew();
  const friends = useFriends();
  const [ticket] = useState(() => (crewUi.joining && crewUi.joining.parkId === parkId ? crewUi.joining : null));
  // One id per visit attempt, reused on retries so the server can deduplicate.
  const [visitId] = useState(() => ticket?.visitId ?? createVisitId());
  const [accountId] = useState(() => auth.ownerAccountId);
  const park = content?.parkById.get(parkId);
  const parkName = park?.short ?? park?.name ?? "this park";
  const me = game.me?.player ?? null;
  const [holder] = useState(() => parkHolder(parkId, game.flags?.byPark, me?.handle, game.me?.parks));
  const rival = standingRival(holder);
  const rivalDays = rival ? flagAgeDays(rival.since, game.serverNow()) : 0;
  const mineFirst = startsPlanted(holder);
  const ownDays = holder.kind === "mine" ? flagAgeDays(holder.flag.since, game.serverNow()) : 0;
  const [phase, setPhase] = useState<PlantPhase>("charge");
  const [holding, setHolding] = useState(false);
  const [result, setResult] = useState<VisitResult | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [impact, setImpact] = useState<{ key: number; power: number } | null>(null);
  const [waving, setWaving] = useState(mineFirst);
  const [cheering, setCheering] = useState(false);
  const [score, setScore] = useState<Score | null>(null);
  const [joinedCrew, setJoinedCrew] = useState<Crew | null>(null);
  const [alreadyMember, setAlreadyMember] = useState(false);
  // "Add a photo" after the visit (#174): the camera, the crop, then the photo joins My Dex.
  const [adding, setAdding] = useState(false);
  const [stage, fit] = useSceneFit();

  const progress = useMotionValue(0);
  const ring = useTransform(progress, (p) => 289 * (1 - p));
  const start = mineFirst ? 0 : ALOFT;
  const base = useMotionValue(start);
  const flagY = useMotionValue(start);
  const tremble = useMotionValue(0);
  const flagX = useMotionValue(rival ? CARRY_X : 0);
  const tilt = useMotionValue(rival ? CARRY_TILT : 0);
  const flagRotate = useTransform(() => tilt.get() + tremble.get());
  const cloth = useMotionValue(mineFirst ? 1 : FURLED);
  const poleX = useMotionValue(1);
  const poleY = useMotionValue(1);
  const rivalX = useMotionValue(0);
  const rivalY = useMotionValue(0);
  const rivalRotate = useMotionValue(0);
  const camX = useMotionValue(0);
  const camY = useMotionValue(0);
  const camRotate = useMotionValue(0);
  const zoom = useMotionValue(1);
  const dim = useMotionValue(0);
  const moundX = useMotionValue(1);
  const moundY = useMotionValue(1);
  const pennantY = useMotionValue(PENNANT_LOW);
  const anim = useRef<ReturnType<typeof animate> | null>(null);
  const lastTick = useRef(0);
  const sending = useRef(false);
  // Read by the frame loop, which can run once more before React re-renders with a new phase.
  const charging = useRef(true);

  // The flag already standing: the leader's, when joining their crew.
  const standing = holder.kind === "other" || holder.kind === "mine" ? holder.flag : null;
  const title = ticket
    ? `Join ${standing ? `@${standing.handle}'s` : "the"} crew`
    : holder.kind === "other"
      ? `Take it from @${holder.flag.handle}`
      : holder.kind === "mine"
        ? "Visit your flag"
        : "Plant your flag";
  // The part of the title that cannot wrap: the @handle, with its 's when joining a crew.
  const titleHandle = ticket ? (standing ? `${standing.handle}'s` : null) : holder.kind === "other" ? holder.flag.handle : null;
  const verb = ticket ? "join" : holder.kind === "other" ? "take it" : holder.kind === "mine" ? "visit" : "plant";
  const flagSeed = me?.flagSeed ?? game.me?.flagSeed ?? null;

  useEffect(() => {
    if (!parkId || !accountId) dispatch({ type: "go", screen: "map" });
  }, [accountId, dispatch, parkId]);

  // Android back is handled in App, which asks for the phase; a hold in progress must not
  // finish and send a visit after the screen has gone.
  useEffect(() => reportPlantPhase(phase), [phase]);
  const endJoin = useRef(crewUi.endJoin);
  endJoin.current = crewUi.endJoin;
  useEffect(
    () => () => {
      reportPlantPhase(null);
      anim.current?.stop();
      if (ticket) endJoin.current();
    },
    [ticket],
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && canLeavePlant(phase)) leave("map");
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  // While charging, the world dims and leans in, and the flag rises trembling in your hands.
  useAnimationFrame((t) => {
    if (!charging.current) return;
    const p = progress.get();
    if (phase === "charge") {
      flagY.set(base.get() - p * HOLD_LIFT);
      pennantY.set(PENNANT_LOW - p * 24);
      zoom.set(1 + p * ZOOM);
      dim.set(p * DIM);
    }
    tremble.set(reduce ? 0 : Math.sin(t / 24) * p * p * 5);
  });

  async function send() {
    if (sending.current || !accountId) return;
    sending.current = true;
    setPhase("sending");
    setFailure(null);
    // Hang the flag high while the server decides; at least a beat, so the slam lands.
    const hang = reduce ? Promise.resolve() : run(flagY, mineFirst ? HANG / 2 : HANG, { duration: 0.32, ease: [0.2, 0.9, 0.3, 1] }).then(() => wait(200));
    try {
      let visit: VisitResult;
      if (ticket) {
        const [answer] = await Promise.all([joinCrew(accountId, { visitId, code: ticket.code }), hang]);
        charging.current = false;
        setJoinedCrew(answer.crew);
        if (answer.status === "already_member") {
          // A second scan by someone already in the crew changes nothing.
          setAlreadyMember(true);
          void run(pennantY, 0, { type: "spring", stiffness: 200, damping: 18 });
          void run(zoom, 1, { duration: 0.3 });
          void run(dim, 0, { duration: 0.3 });
          setCheering(true);
          setPhase("done");
          return;
        }
        visit = answer.visit;
      } else {
        [visit] = await Promise.all([sendVisit(accountId, { visitId, parkId }), hang]);
        charging.current = false;
      }
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
      void run(flagY, base.get(), { type: "spring", stiffness: 260, damping: 20 });
      void run(zoom, 1, { duration: 0.3 });
      void run(dim, 0, { duration: 0.3 });
      if (next.action === "handle") game.openHandleSheet({ onDone: () => void send() });
    } finally {
      sending.current = false;
    }
  }

  async function countUp(target: number) {
    setScore({ value: 0, target });
    sfx.thud();
    buzz(40);
    await wait(260);
    const step = countStepMs(target);
    for (let value = 1; value <= target; value += 1) {
      setScore({ value, target });
      sfx.coin(value);
      if (value % 2 === 1) buzz(6);
      await wait(step);
    }
    sfx.claim();
    buzz([30, 30, 60]);
  }

  async function play(visit: VisitResult) {
    const plan = plantPlan(visit);
    tremble.set(0);
    if (reduce) {
      // Reduced motion: land on the final picture with one gentle cue.
      if (plan.yank) rivalY.set(900);
      if (plan.raise) {
        pennantY.set(0);
        setWaving(true);
      }
      if (plan.slam) {
        flagY.set(0);
        flagX.set(0);
        tilt.set(0);
        cloth.set(1);
        setWaving(true);
      } else {
        flagY.set(start);
      }
      zoom.set(1);
      dim.set(0);
      setCheering(true);
      if (plan.count !== null) setScore({ value: plan.count, target: plan.count });
      sfx.pop();
      buzz(30);
      return;
    }

    if (plan.yank) {
      // Yank the rival's flag out of the dirt and fling it off screen, spinning.
      sfx.yank();
      buzz(35);
      await run(rivalY, -70, { duration: 0.14, ease: "easeOut" });
      sfx.swish(true);
      void run(rivalX, 360, { duration: 0.85, ease: "easeIn" });
      void run(rivalY, [-70, -260, 700], { duration: 0.85, times: [0, 0.35, 1], ease: "easeIn" });
      void run(rivalRotate, 900, { duration: 0.85, ease: "easeIn" });
      setImpact({ key: Date.now(), power: 0.35 });
      await wait(260);
    }

    if (plan.slam) {
      const big = plan.slam === "big";
      if (!big) await run(flagY, -64, { duration: 0.18, ease: "easeOut" });
      // Swing over the mound, a tiny wind-up, then drive the pole home.
      void run(flagX, 0, { duration: 0.18, ease: "easeOut" });
      void run(tilt, 0, { duration: 0.18, ease: "easeOut" });
      sfx.swish(false);
      await run(flagY, flagY.get() - (big ? 26 : 12), { duration: 0.12, ease: "easeOut" });
      await run(flagY, 0, { duration: big ? 0.13 : 0.11, ease: [0.8, 0, 1, 0.7] });
      sfx.thud();
      if (big) sfx.boom();
      buzz(big ? [120, 40, 80, 40, 40] : [50, 30, 20]);
      setImpact({ key: Date.now(), power: big ? 1 : 0.45 });
      void run(poleY, [1, 0.74, 1.12, 0.95, 1.02, 1], { duration: 0.55 });
      void run(poleX, [1, 1.22, 0.9, 1.04, 1], { duration: 0.5 });
      void run(moundY, [1, big ? 0.74 : 0.88, 1.08, 0.98, 1], { duration: 0.5 });
      void run(moundX, [1, big ? 1.16 : 1.07, 0.96, 1.01, 1], { duration: 0.5 });
      void run(camX, shakeFrames(big ? 18 : 7), { duration: big ? 0.65 : 0.4 });
      void run(camY, shakeFrames(big ? 10 : 4), { duration: big ? 0.6 : 0.35 });
      void run(camRotate, shakeFrames(big ? 2 : 0.8), { duration: 0.6 });
      void run(zoom, 1, { type: "spring", stiffness: 140, damping: 16 });
      void run(dim, 0, { duration: 0.5 });
      await wait(big ? 170 : 110);
      sfx.flap();
      await run(cloth, [cloth.get(), 1.16, 0.9, 1.05, 1], { duration: 0.7, ease: "easeOut" });
      setWaving(true);
    }

    if (plan.settle) {
      void run(zoom, 1, { duration: 0.4 });
      void run(dim, 0, { duration: 0.4 });
      await run(flagY, start, { type: "spring", stiffness: 240, damping: 16 });
      sfx.pop();
      buzz(15);
      await run(tilt, [0, -9, 7, -4, 2, 0], { duration: 0.6 });
    }

    if (plan.raise) {
      // Hoist the pennant up the leader's pole, a little past its spot, and let it settle and flap.
      void run(zoom, 1, { duration: 0.4 });
      void run(dim, 0, { duration: 0.4 });
      sfx.swish(false);
      await run(pennantY, -10, { duration: 0.42, ease: [0.2, 0.9, 0.3, 1] });
      sfx.flap();
      buzz([40, 30, 60]);
      setImpact({ key: Date.now(), power: 0.35 });
      await run(pennantY, 0, { type: "spring", stiffness: 320, damping: 12 });
      setWaving(true);
    }

    if (plan.payoff) {
      const colours = flagConfetti(flagSeed);
      setCheering(true);
      if (plan.payoff === "big") {
        burst({ x: 0.5, y: 0.5 }, 1.4, colours);
        setTimeout(() => cannons(colours), 260);
        sfx.cheer();
        setTimeout(() => sfx.chirp(), 700);
      } else {
        burst({ x: 0.5, y: 0.5 }, plan.payoff === "small" ? 0.55 : 0.22, colours);
        sfx.chirp();
      }
    }

    if (plan.count !== null) {
      await wait(250);
      await countUp(plan.count);
    }
  }

  const begin = (event: React.PointerEvent) => {
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
    charging.current = true;
    progress.set(0);
    flagY.set(base.get());
    void send();
  };

  function leave(screen: "map" | "parks", segment: "flags" | "collection" = "flags") {
    if (screen === "parks") openDexOn(segment);
    for (const action of leavePlant(park ? park.id : null, screen)) dispatch(action);
  }

  const won = !!result && (result.outcome === "planted" || result.outcome === "took" || result.outcome === "joined");
  // Kip explains hourly points (#169) on the first visit result that earned any.
  useKipTip("points", phase === "done" && !!result && result.pointsEarned > 0 && result.outcome !== "joined");
  useKipTip("crew-joined", phase === "done" && result?.outcome === "joined");
  const headline = alreadyMember
    ? { title: "Already in this crew", detail: `You hold ${parkName} with this crew already.` }
    : result?.outcome === "joined" && joinedCrew
      ? { ...visitHeadline(result, parkName), title: `You joined @${joinedCrew.leader.handle}'s crew` }
      : result
        ? visitHeadline(result, parkName)
        : null;
  // The stamp names the crew's leader or the player the flag was taken from.
  const headlineHandle = alreadyMember
    ? null
    : result?.outcome === "joined" && joinedCrew
      ? `${joinedCrew.leader.handle}'s`
      : result?.outcome === "took"
        ? result.previousHolder?.handle
        : null;
  // Friends (#64): after joining, offer the crew members who aren't friends yet.
  const friendsBoard = friends.enabled ? friends.board : null;
  const refreshFriends = useRef(friends.refresh);
  refreshFriends.current = friends.refresh;
  useEffect(() => {
    if (joinedCrew && friends.enabled && !friends.board) void refreshFriends.current();
  }, [joinedCrew, friends.enabled, friends.board]);
  const offers =
    joinedCrew && friendsBoard ? friendOffers(joinedCrew, me?.handle, new Set(friendsBoard.players.map((player) => player.handle))).slice(0, 3) : [];
  // Badges this visit unlocked (#175), shown only with the `badges` flag on.
  const badgesOn = useFeatureFlag("badges");
  const unlockShown = badgesOn && (result?.newBadges ?? []).some((unlock) => badgeById(unlock.id));
  const flagDays = result?.outcome === "held" && result.flagSince ? flagAgeDays(result.flagSince, game.serverNow()) : mineFirst ? ownDays : 0;
  const clods = impact && !reduce ? dirtClods(impact.power >= 1 ? 30 : 12, impact.key, impact.power) : [];
  const puffs = impact && !reduce ? [-1, -0.55, -0.15, 0.2, 0.6, 1].map((side) => side * 120 * Math.max(impact.power, 0.5)) : [];

  return (
    <motion.div className="screen claim plant" exit={{ opacity: 0, transition: { duration: 0.3 } }} initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
      <motion.div
        className="claim__glow"
        style={{ opacity: won && phase === "done" ? 1 : 0.45, background: "radial-gradient(circle, #ffc93c 0%, transparent 62%)" }}
      />
      <motion.div className="plant-vignette" style={{ opacity: dim }} aria-hidden="true" />

      <AnimatePresence>
        {(phase === "charge" || phase === "failed") && (
          <motion.button
            key="close"
            className="plant__close"
            onClick={() => leave("map")}
            initial={{ opacity: 0, x: -12 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -12 }}
            transition={{ type: "spring", stiffness: 420, damping: 28 }}
          >
            <Icon name="close" size={16} stroke={3} /> Not now
          </motion.button>
        )}
      </AnimatePresence>

      <div className="claim__head">
        <AnimatePresence mode="wait">
          {!headline || phase === "playing" ? (
            <motion.div key="a" initial={{ y: -20, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: -20, opacity: 0 }}>
              <span className="eyebrow eyebrow--light">At {parkName}</span>
              <h1 style={handleFit(titleHandle)}>{title}</h1>
            </motion.div>
          ) : (
            <motion.div
              key="b"
              initial={{ scale: 2.4, rotate: -16, opacity: 0 }}
              animate={{ scale: 1, rotate: -3, opacity: 1 }}
              transition={{ type: "spring", stiffness: 520, damping: 15 }}
            >
              <span className={`claim__stamp plant__stamp ${won ? "" : "plant__stamp--quiet"}`} style={handleFit(headlineHandle)}>
                {headline.title}
              </span>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <div className="claim__stage" ref={stage}>
        {won && (phase === "done" || score) && (
          <div className="claim__rays">
            <Rays color="#FFE27A" size={620} opacity={0.4} speed={20} />
          </div>
        )}
        <motion.div className="plant-camera" style={{ x: camX, y: camY, rotate: camRotate, scale: zoom, width: SCENE_WIDTH * fit, height: SCENE_HEIGHT * fit }}>
          <div className="plant-scene" style={{ scale: fit }}>
            <AnimatePresence>
              {impact && !reduce && (
                <motion.span
                  key={`ring-${impact.key}`}
                  className="plant-ring"
                  initial={{ scale: 0.2, opacity: 0.95 }}
                  animate={{ scale: 2.8 * Math.max(impact.power, 0.5), opacity: 0 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.6, ease: "easeOut" }}
                />
              )}
            </AnimatePresence>
            {ticket && (
              <div className="plant-flag plant-flag--crew" aria-label={standing ? `Flag of @${standing.handle}, with your pennant` : "Your pennant"} role="img">
                <span className="plant-flag__pole" />
                {standing && (
                  <span className="plant-flag__cloth plant-flag__cloth--wave">
                    <Flag seed={standing.flagSeed} size={124} days={flagAgeDays(standing.since, game.serverNow())} />
                  </span>
                )}
                {flagSeed && (
                  <motion.span className={`plant-pennant ${waving ? "plant-pennant--wave" : ""}`} style={{ y: pennantY }}>
                    <Pennant seed={flagSeed} size={64} />
                  </motion.span>
                )}
              </div>
            )}
            {rival && !ticket && (
              <motion.div
                className="plant-flag plant-flag--rival"
                style={{ x: rivalX, y: rivalY, rotate: rivalRotate }}
                aria-label={`Flag of @${rival.handle}`}
                role="img"
              >
                <span className="plant-flag__pole" />
                <span className="plant-flag__cloth plant-flag__cloth--wave">
                  <Flag seed={rival.flagSeed} size={124} days={rivalDays} />
                </span>
              </motion.div>
            )}
            {flagSeed && !ticket && (
              <motion.div className="plant-flag" style={{ x: flagX, y: flagY, rotate: flagRotate }} aria-label="Your flag" role="img">
                <motion.span className="plant-flag__pole" style={{ scaleX: poleX, scaleY: poleY }} />
                <motion.span className={`plant-flag__cloth ${waving ? "plant-flag__cloth--wave" : ""}`} style={{ scaleX: cloth }}>
                  <Flag seed={flagSeed} size={124} days={flagDays} />
                </motion.span>
              </motion.div>
            )}
            <motion.svg className="plant-mound" viewBox="0 0 260 90" style={{ scaleX: moundX, scaleY: moundY }} aria-hidden="true">
              <ellipse cx="130" cy="82" rx="122" ry="8" fill="rgba(0,0,0,.35)" />
              <path d="M8 80 C 40 30, 90 14, 130 14 C 170 14, 220 30, 252 80 Z" fill="#6B4423" />
              <path d="M30 62 C 60 30, 100 22, 130 22 C 160 22, 200 30, 230 62 C 190 50, 70 50, 30 62 Z" fill="#8B5A2B" />
              <path
                d="M120 16 l4 -10 l3 10 M136 17 l5 -9 l1 10 M96 22 l2 -8 l4 8 M160 22 l4 -8 l2 9"
                stroke="#7A9A3A"
                strokeWidth="3"
                strokeLinecap="round"
                fill="none"
              />
              <path d="M60 70 q6 -3 12 0 M180 66 q6 -3 12 0 M120 54 q5 -3 10 0" stroke="#5A3A1E" strokeWidth="3" strokeLinecap="round" fill="none" />
            </motion.svg>
            <div className="plant-dirt" aria-hidden="true">
              {puffs.map((dx, index) => (
                <motion.span
                  key={`puff-${impact?.key}-${index}`}
                  className="plant-dirt__puff"
                  initial={{ x: 0, y: 0, scale: 0.3, opacity: 0.8 }}
                  animate={{ x: dx, y: -20 - Math.abs(dx) * 0.15, scale: 1.6 + Math.abs(dx) / 160, opacity: 0 }}
                  transition={{ duration: 1.1, ease: "easeOut", delay: index * 0.02 }}
                />
              ))}
              {clods.map((clod, index) => (
                <motion.span
                  key={`${impact?.key}-${index}`}
                  className="plant-dirt__clod"
                  style={{ width: clod.size, height: clod.size, background: clod.color }}
                  initial={{ x: 0, y: 0, opacity: 1, rotate: 0 }}
                  animate={{
                    x: [0, clod.x * 0.7, clod.x, clod.x * 1.06, clod.x * 1.08],
                    y: [0, clod.peak, clod.land, clod.hop, clod.land],
                    rotate: clod.rotate,
                    opacity: [1, 1, 1, 1, 0],
                  }}
                  transition={{
                    default: { duration: 1.05, delay: clod.delay, times: [0, 0.38, 0.72, 0.86, 1], ease: "easeOut" },
                    opacity: { duration: 2.6, delay: clod.delay, times: [0, 0.4, 0.6, 0.8, 1] },
                  }}
                />
              ))}
            </div>
            {/* The points land left of the pole and Kip cheers right of the mound, inside the scene. */}
            <AnimatePresence>
              {score && (
                <motion.div
                  key="score"
                  className="plant-score"
                  initial={{ scale: 3, opacity: 0, rotate: -12 }}
                  animate={{ scale: 1, opacity: 1, rotate: -4 }}
                  transition={{ type: "spring", stiffness: 520, damping: 14 }}
                  aria-live="polite"
                >
                  <motion.strong
                    key={score.value}
                    initial={{ scale: 1.35 }}
                    animate={{ scale: 1 }}
                    transition={{ type: "spring", stiffness: 700, damping: 18 }}
                  >
                    +{score.value}
                  </motion.strong>
                  <span>{score.target === 1 ? "point" : "points"}</span>
                </motion.div>
              )}
            </AnimatePresence>
            <AnimatePresence>
              {cheering && (
                <motion.div
                  key="kip"
                  className="plant-kip"
                  initial={{ y: 160, rotate: 20 }}
                  animate={{ y: 0, rotate: 0 }}
                  transition={{ type: "spring", stiffness: 300, damping: 13, delay: 0.15 }}
                >
                  <motion.div animate={reduce ? undefined : { y: [0, -14, 0], rotate: [0, -6, 6, 0] }} transition={{ duration: 0.7, repeat: 2, delay: 0.5 }}>
                    <Kip pose={won ? "celebrate" : "cheer"} size={92} flip />
                  </motion.div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </motion.div>

        <AnimatePresence>
          {impact && !reduce && impact.power >= 1 && (
            <motion.div
              key={`flash-${impact.key}`}
              className="claim__flash"
              initial={{ opacity: 0.9 }}
              animate={{ opacity: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.35 }}
            />
          )}
        </AnimatePresence>
      </div>

      <div className="claim__foot">
        <AnimatePresence mode="wait">
          {phase === "done" && (result || alreadyMember) && headline ? (
            <motion.div
              key="done"
              className="claim__done"
              initial="hidden"
              animate="show"
              variants={{ show: { transition: { staggerChildren: 0.08, delayChildren: 0.1 } } }}
            >
              {/* One headline above, the points in the scene, then one sentence and at most two buttons. */}
              <motion.p className="plant__detail" variants={pop}>
                {headline.detail}
              </motion.p>
              {result && <span className="plant__cheer">{plantCheer(result)}</span>}
              {(joinedCrew || unlockShown) && (
                <motion.div variants={pop} className="plant__extras">
                  {/* The badges this visit unlocked (#175). */}
                  <BadgeUnlock unlocks={result?.newBadges} compact onOpen={() => leave("parks", "collection")} />
                  {joinedCrew && (
                    <span className="plant__chip">
                      <Icon name="flag" size={16} /> Crew of {joinedCrew.size}
                    </span>
                  )}
                  {offers.length > 0 && (
                    <button className="plant__chip plant__chip--button" onClick={() => friends.setAddSheet("open")}>
                      <Icon name="qr" size={16} /> {offers.length === 1 ? `Add @${offers[0].handle} as a friend` : `Add ${offers.length} crewmates as friends`}
                    </button>
                  )}
                </motion.div>
              )}
              <motion.div variants={pop} className="claim__row">
                {park && (
                  <button
                    className="btn btn--sm btn--sun"
                    onClick={() => {
                      sfx.pop();
                      startPhotoCapture();
                      setAdding(true);
                    }}
                  >
                    <Icon name="camera" size={18} /> Add a photo
                  </button>
                )}
                <button className="btn btn--sm btn--paper" onClick={() => leave("map")}>
                  <Icon name="map" size={18} /> Back to map
                </button>
              </motion.div>
            </motion.div>
          ) : phase === "playing" ? (
            <motion.div key="playing" className="hold" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} />
          ) : (
            <motion.div
              key="hold"
              className="hold"
              initial={{ y: 60, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              exit={{ y: 40, opacity: 0, scale: 0.8 }}
              transition={{ type: "spring", delay: 0.2 }}
            >
              {phase === "failed" && failure ? (
                <div className="claim-save-error plant__error" role="alert">
                  <p>{failure.message}</p>
                  <div className="claim__row">
                    {failure.action === "sign-in" ? (
                      <button className="btn btn--sm btn--sun" onClick={() => dispatch({ type: "go", screen: "account" })}>
                        Sign in
                      </button>
                    ) : failure.action === "none" ? null : failure.action === "handle" ? (
                      <button className="btn btn--sm btn--sun" onClick={() => game.openHandleSheet({ onDone: () => void send() })}>
                        Pick a handle
                      </button>
                    ) : (
                      <button className="btn btn--sm btn--sun" onClick={retry}>
                        <Icon name="refresh" size={18} /> Try again
                      </button>
                    )}
                    <button className="btn btn--sm btn--paper" onClick={() => leave("map")}>
                      Back to map
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <motion.button
                    className="hold__btn"
                    onPointerDown={begin}
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
                      <motion.circle
                        cx="50"
                        cy="50"
                        r="46"
                        fill="none"
                        stroke="#FFC93C"
                        strokeWidth="7"
                        strokeLinecap="round"
                        strokeDasharray="289"
                        style={{ strokeDashoffset: ring }}
                        transform="rotate(-90 50 50)"
                      />
                    </svg>
                    <span className="hold__core">
                      <Icon name="flag" size={30} stroke={2.6} />
                    </span>
                  </motion.button>
                  <motion.p className="hold__label" animate={{ opacity: holding ? 0.5 : 1 }}>
                    {phase === "sending" ? "Here it comes…" : holding ? "Keep holding…" : `Press and hold to ${verb}`}
                  </motion.p>
                </>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
      {park && <AddDexPhoto park={park} open={adding} onClose={() => setAdding(false)} />}
    </motion.div>
  );
}

const pop = {
  hidden: { y: 30, opacity: 0, scale: 0.9 },
  show: { y: 0, opacity: 1, scale: 1, transition: { type: "spring" as const, stiffness: 420, damping: 22 } },
};
