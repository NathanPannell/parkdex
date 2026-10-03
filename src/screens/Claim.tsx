import { animate, AnimatePresence, motion, useAnimationFrame, useMotionValue, useTransform } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { Badge } from "../components/Badge";
import { ContentGate } from "../components/ContentGate";
import { Icon } from "../components/Icon";
import { Bubble, Kip } from "../components/Kip";
import { RollingNumber, Rays, Tilt } from "../components/Motion";
import { burst, cannons } from "../lib/confetti";
import { buzz, sfx } from "../lib/feedback";
import { badgeTotal, PALETTES, RARITY, scenePath, type Park } from "../lib/parks";
import { assertParkClaimEligible, getRarityProgress, ParkAlreadyClaimedError, ParkClaimEligibilityError, rankUpAfter, type Rank } from "../lib/progression";
import { RankUp } from "../components/Rank";
import { progressOwnerKey, useStore } from "../lib/store";
import { useContent, useContentRuntime } from "../lib/content/provider";
import { useAuth } from "../lib/accounts/AuthProvider";
import { createPersonalClaim } from "../lib/accounts/personalStore";
import { claimEventContext } from "../lib/accounts/progressSync";
import { recordParkClaimed } from "../lib/interactions";
import { isNative } from "../lib/native";

const HOLD_MS = 1500;
const CHEERS = ["KLEEP! Beauty!", "Into the Dex!", "Look at that shine!", "Another one!"];

type ClaimEntry = { park: Park; contentReleaseId: string | null; sceneHref: string | null };

export function Claim() {
  const { state } = useStore();
  const content = useContent();
  const runtime = useContentRuntime();
  const [parkId] = useState(() => state.tripId ?? "");
  const entryRef = useRef<ClaimEntry | null>(null);
  const currentPark = content?.parkById.get(parkId);

  if (!entryRef.current && state.progressReady && content && currentPark) {
    const park = { ...currentPark };
    const contentReleaseId = park.scene ? runtime.getSceneAssetVersion(park.id, park.scene) : null;
    if (!park.scene || contentReleaseId) {
      entryRef.current = {
        park,
        contentReleaseId,
        sceneHref: park.scene ? content.assetUrls.get(scenePath(park.scene)) ?? null : null,
      };
    }
  }

  const entry = entryRef.current;
  if (entry?.park.scene && entry.sceneHref === null && content && currentPark?.scene === entry.park.scene &&
    runtime.getSceneAssetVersion(entry.park.id, entry.park.scene) === entry.contentReleaseId) {
    const sceneHref = content.assetUrls.get(scenePath(entry.park.scene));
    if (sceneHref) entryRef.current = { ...entry, sceneHref };
  }

  // Only art near the visitor downloads automatically; fetch this park's now if it is still missing.
  const missingArtParkId = entryRef.current?.park.scene && entryRef.current.sceneHref === null ? entryRef.current.park.id : null;
  useEffect(() => {
    if (missingArtParkId) void runtime.ensureParkArt?.(missingArtParkId).catch(() => {});
  }, [missingArtParkId, runtime]);

  if (!state.progressReady) return <div className="screen claim-progress-wait"><div className="card"><Kip pose="think" size={72} /><strong>Opening your saved Dex…</strong><span>Your photo is still here. Kip will save this badge as soon as your Dex is ready.</span></div></div>;
  if (!entryRef.current) return <ContentGate />;
  return <ClaimReady identity={entryRef.current} />;
}

function ClaimReady({ identity }: { identity: ClaimEntry }) {
  const { park, contentReleaseId, sceneHref } = identity;
  const { state, dispatch } = useStore();
  const auth = useAuth();
  const content = useContent();
  const contentRef = useRef(content);
  contentRef.current = content;
  const [photo] = useState(() => state.pendingPhoto ?? "");
  const [owner] = useState(() => auth.ownerAccountId ? { kind: "account" as const, accountId: auth.ownerAccountId } : { kind: "guest" as const });
  const ownerKey = progressOwnerKey(owner)!;
  const stateRef = useRef(state);
  stateRef.current = state;
  const authRef = useRef(auth);
  authRef.current = auth;
  const claimOwnerIsCurrent = () => {
    const currentAuth = authRef.current;
    const currentOwnerKey = currentAuth.phase === "guest"
      ? "guest"
      : currentAuth.ownerAccountId
        ? `account:${currentAuth.ownerAccountId.toLowerCase()}`
        : null;
    return currentOwnerKey === ownerKey && stateRef.current.progressOwnerKey === ownerKey && stateRef.current.progressReady;
  };
  const currentClaimBlockMessage = () => {
    if (!claimOwnerIsCurrent()) return "Your saved Dex is still loading. Return to the map and try again.";
    const currentClaims = stateRef.current.claims;
    if (currentClaims[park.id]) return "This badge is already in your Dex. Your photo is still here. Return to the park list.";
    const currentContent = contentRef.current;
    if (!currentContent) return "The park catalogue is still loading. Return to the map and try again.";
    const currentPark = currentContent.parkById.get(park.id);
    if (!currentPark) return "This park is no longer in the current catalogue. Your photo is still here.";
    try {
      assertParkClaimEligible(currentPark, currentClaims, currentContent.parkById);
      return null;
    } catch (error) {
      return describeClaimEligibilityFailure(error);
    }
  };
  const [firstClaim] = useState(() => !state.claims[park.id]);
  const totalBadges = badgeTotal(content?.liveParks ?? [], Object.keys(state.claims));
  const [rankUp, setRankUp] = useState<Rank | null>(null);
  const pal = PALETTES[park.biome];
  const rarity = RARITY[park.rarity];
  const [phase, setPhase] = useState<"charge" | "done">("charge");
  const [holding, setHolding] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const [eligibilityMessage, setEligibilityMessage] = useState<string | null>(null);
  // Frozen at mount: the claim itself bumps the live count mid-ceremony.
  const [before] = useState(() => Object.keys(state.claims).length);
  const [count, setCount] = useState(before);
  const number = before + 1;

  const progress = useMotionValue(0);
  const ring = useTransform(progress, (p) => 289 * (1 - p));
  // Fading a pre-dimmed copy is compositor-only; animating filter repainted the badge every frame.
  const dim = useTransform(progress, (p) => 1 - p);
  const badgeArt = (
    <div className="claim__badge-art">
      <Badge park={park} sceneHref={park.scene ? sceneHref ?? "" : undefined} size={236} state={phase === "done" ? "earned" : "preview"} />
      <motion.div className="claim__badge-dim" style={{ opacity: dim }} aria-hidden="true">
        <Badge park={park} sceneHref={park.scene ? sceneHref ?? "" : undefined} size={236} state="preview" />
      </motion.div>
    </div>
  );
  // Android WebView mispaints SVG badge text under Tilt's 3D transform.
  const presentedBadge = isNative ? badgeArt : <Tilt idle={phase === "done"} max={22}>{badgeArt}</Tilt>;
  const glow = useTransform(progress, (p) => p * 0.9);
  const shakeX = useMotionValue(0);
  const shakeR = useMotionValue(0);
  const anim = useRef<ReturnType<typeof animate> | null>(null);
  const savingRef = useRef(false);
  const lastTick = useRef(0);

  useAnimationFrame((t) => {
    if (phase !== "charge") return;
    const p = progress.get();
    shakeX.set(Math.sin(t / 22) * p * p * 7);
    shakeR.set(Math.sin(t / 31) * p * p * 6);
  });

  const start = (e: React.PointerEvent) => {
    if (phase !== "charge" || savingRef.current) return;
    const blockMessage = currentClaimBlockMessage();
    if (blockMessage || (park.scene !== null && !contentReleaseId)) {
      setEligibilityMessage(blockMessage);
      setSaveError(true);
      progress.set(0);
      lastTick.current = 0;
      return;
    }
    setEligibilityMessage(null);
    setSaveError(false);
    e.currentTarget.setPointerCapture(e.pointerId);
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
      onComplete: () => { void saveClaim(); },
    });
  };

  const release = () => {
    if (phase !== "charge" || savingRef.current || progress.get() >= 1) return;
    setHolding(false);
    lastTick.current = 0;
    anim.current?.stop();
    anim.current = animate(progress, 0, { type: "spring", stiffness: 300, damping: 24 });
  };

  async function saveClaim() {
    if (phase !== "charge" || savingRef.current) return;
    const blockMessage = currentClaimBlockMessage();
    if (blockMessage || (park.scene !== null && !contentReleaseId)) {
      setHolding(false);
      setEligibilityMessage(blockMessage);
      setSaveError(true);
      progress.set(0);
      lastTick.current = 0;
      return;
    }
    savingRef.current = true;
    setHolding(false);
    setSaving(true);
    setSaveError(false);
    setEligibilityMessage(null);
    const claimedAt = new Date().toISOString();
    const parkSnapshot = park;
    try {
      // The personal store resolves only after claim metadata, photo bytes and the
      // account sync outbox have committed in one durable transaction.
      const saved = await createPersonalClaim(owner, { park: parkSnapshot, claimedAt, contentReleaseId, photo: photo || null });
      const event = claimEventContext(saved, firstClaim);
      const interactionReleaseId = contentRef.current?.releaseId ?? contentReleaseId ?? "";
      void recordParkClaimed({ parkId: event.parkId, claimId: event.claimId, claimStatus: event.firstClaim ? "first" : "repeat", contentReleaseId: interactionReleaseId }).catch(() => {});
      if (!claimOwnerIsCurrent()) {
        setSaveError(true);
        progress.set(0);
        lastTick.current = 0;
        return;
      }
      const catalogue = contentRef.current?.parkById;
      const claimsBefore = stateRef.current.claims;
      const reached = rankUpAfter(
        getRarityProgress(claimsBefore, catalogue),
        getRarityProgress({ ...claimsBefore, [parkSnapshot.id]: { parkSnapshot } }, catalogue),
      );
      dispatch({ type: "claim", ownerKey, id: parkSnapshot.id, claimId: saved.claimId, at: saved.claimedAt, photo, parkSnapshot, contentReleaseId });
      if (authRef.current.phase === "authenticated" && authRef.current.ownerAccountId?.toLowerCase() === ownerKey.slice("account:".length)) void authRef.current.syncBackup({ retryAfterFlight: true });
      celebrate();
      // Let the badge moment land before the rank-up takes the stage.
      if (reached) setTimeout(() => { setRankUp(reached); sfx.claim(); burst({ x: 0.5, y: 0.3 }, 1.1); }, 2600);
    } catch {
      setSaveError(true);
      progress.set(0);
      lastTick.current = 0;
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  function celebrate() {
    setPhase("done");
    sfx.claim();
    buzz([40, 40, 80, 40, 160]);
    shakeX.set(0);
    shakeR.set(0);
    burst({ x: 0.5, y: 0.42 }, 1.3);
    setTimeout(cannons, 350);
    setTimeout(() => setCount(number), 700);
    setTimeout(() => sfx.chirp(), 900);
  }

  return (
    <motion.div
      className="screen claim"
      style={{ ["--spot" as string]: pal.skyTop }}
      // No fade-in: the camera is fading out underneath, and a transparent claim screen let the map show through.
      exit={{ opacity: 0, transition: { duration: 0.3 } }}
    >
      <motion.div className="claim__spot" style={{ opacity: phase === "done" ? 1 : undefined }} />
      <motion.div className="claim__glow" style={{ opacity: phase === "done" ? 1 : glow, background: `radial-gradient(circle, ${pal.skyTop} 0%, transparent 62%)` }} />

      <div className="claim__head">
        <AnimatePresence mode="wait">
          {phase === "charge" ? (
            <motion.div key="a" initial={{ y: -20, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: -20, opacity: 0 }}>
              <span className="eyebrow eyebrow--light">Checked in · {new Date().toLocaleTimeString("en-CA", { hour: "numeric", minute: "2-digit" })}</span>
              <h1>{park.short}</h1>
            </motion.div>
          ) : (
            <motion.div key="b" className="claim__stamp" initial={{ scale: 3.2, rotate: -24, opacity: 0 }} animate={{ scale: 1, rotate: -5, opacity: 1 }} transition={{ type: "spring", stiffness: 520, damping: 15, delay: 0.25 }}>
              Badge claimed!
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <motion.div
        className="claim__photo"
        initial={{ x: -200, rotate: -40 }}
        animate={phase === "done" ? { x: 0, rotate: -9, y: 0, scale: 1 } : { x: 0, rotate: -12, y: 0, scale: 1 }}
        transition={{ type: "spring", stiffness: 200, damping: 16, delay: 0.2 }}
      >
        <span className="tape" />
        {photo && <img src={photo} alt="Your check-in" />}
      </motion.div>

      <div className="claim__stage">
        {phase === "done" && (
          <>
            <div className="claim__rays">
              <Rays color="#FFE27A" size={620} opacity={0.5} speed={20} />
            </div>
            {[0, 1, 2].map((i) => (
              <motion.span
                key={i}
                className="shock"
                initial={{ scale: 0.2, opacity: 0.9 }}
                animate={{ scale: 3.4, opacity: 0 }}
                transition={{ duration: 1, delay: i * 0.12, ease: "easeOut" }}
              />
            ))}
          </>
        )}
        {phase === "charge" && (
          <div className={`orbit ${holding ? "orbit--pull" : ""}`}>
            {Array.from({ length: 18 }, (_, i) => (
              <span key={i} style={{ ["--a" as string]: `${i * 20}deg`, ["--d" as string]: `${(i % 6) * 0.12}s`, background: i % 3 ? pal.skyTop : "#FFC93C" }} />
            ))}
          </div>
        )}
        <motion.div
          className="claim__badge"
          style={{ x: shakeX, rotate: shakeR }}
          initial={{ scale: 0.2, y: 120, opacity: 0 }}
          animate={
            phase === "done"
              ? { scale: [0.8, 1.28, 1], rotate: [0, -10, 7, 0], y: 0, opacity: 1 }
              : { scale: holding ? 1.08 : 1, y: 0, opacity: 1 }
          }
          transition={
            phase === "done"
              ? { duration: 0.9, ease: [0.2, 1.4, 0.4, 1] }
              : { type: "spring", stiffness: 240, damping: 18 }
          }
        >
          {presentedBadge}
        </motion.div>
        {phase === "done" && <motion.div className="claim__flash" initial={{ opacity: 1 }} animate={{ opacity: 0 }} transition={{ duration: 0.7 }} />}
      </div>

      <div className="claim__foot">
        <AnimatePresence mode="wait">
          {phase === "charge" ? (
            <motion.div key="hold" className="hold" initial={{ y: 60, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 40, opacity: 0, scale: 0.8 }} transition={{ type: "spring", delay: 0.4 }}>
              <motion.button
                className="hold__btn"
                onPointerDown={start}
                onPointerUp={release}
                onPointerCancel={release}
                onContextMenu={(e) => e.preventDefault()}
                animate={{ scale: holding ? 0.92 : 1 }}
                transition={{ type: "spring", stiffness: 500, damping: 20 }}
                aria-label="Hold to claim"
                disabled={saving || !state.progressReady}
              >
                <svg viewBox="0 0 100 100" className="hold__ring">
                  <circle cx="50" cy="50" r="46" fill="none" stroke="rgba(255,248,236,.18)" strokeWidth="7" />
                  <motion.circle cx="50" cy="50" r="46" fill="none" stroke="#FFC93C" strokeWidth="7" strokeLinecap="round" strokeDasharray="289" style={{ strokeDashoffset: ring }} transform="rotate(-90 50 50)" />
                </svg>
                <span className="hold__core">
                  <Icon name="sparkle" size={30} stroke={2.6} />
                </span>
              </motion.button>
              <motion.p className="hold__label" animate={{ opacity: holding ? 0.5 : 1 }}>
                {saving ? "Saving your badge…" : holding ? "Keep holding…" : "Press and hold to claim"}
              </motion.p>
              {saveError && eligibilityMessage ? (
                <div className="claim-save-error" role="alert">
                  <p>{eligibilityMessage}</p>
                  <button
                    className="btn btn--sm btn--paper"
                    onClick={() => {
                      dispatch({ type: "trip", id: null });
                      dispatch({ type: "select", id: park.id });
                      dispatch({ type: "go", screen: "map" });
                    }}
                  >
                    Return to the park
                  </button>
                </div>
              ) : saveError ? (
                <p className="claim-save-error" role="alert">That badge couldn’t be saved yet. Your photo is still here. Release and try again.</p>
              ) : null}
            </motion.div>
          ) : (
            <motion.div key="done" className="claim__done" initial="hidden" animate="show" variants={{ show: { transition: { staggerChildren: 0.08, delayChildren: 0.6 } } }}>
              {/* Kip sits in the layout flow so he never covers the badge or the buttons. */}
              <motion.div className="claim__kip" variants={pop}>
                <Bubble side="to-right" style={{ position: "relative", marginBottom: 22 }}>
                  {number === 1 ? "Your first badge! KLEEP!" : CHEERS[number % CHEERS.length]}
                </Bubble>
                <Kip pose="celebrate" size={84} flip />
              </motion.div>
              <motion.div className="claim__rarity" variants={pop}>
                <span className="pill" style={{ background: rarity.color, color: rarity.ink }}>
                  {"★".repeat(rarity.stars)} {rarity.label}
                </span>
                <span className="claim__count">
                  Badge #<RollingNumber value={count} />&nbsp;of {totalBadges.toLocaleString("en-CA")}
                </span>
              </motion.div>
              <motion.button variants={pop} className="btn btn--block btn--sun" onClick={() => dispatch({ type: "go", screen: "share" })}>
                <Icon name="share" /> Share it
              </motion.button>
              <motion.div variants={pop} className="claim__row">
                <button className="btn btn--sm btn--ink" onClick={() => dispatch({ type: "go", screen: "collection" })}>
                  <Icon name="case" size={18} /> See my Dex
                </button>
                <button
                  className="btn btn--sm btn--paper"
                  onClick={() => {
                    dispatch({ type: "trip", id: null });
                    dispatch({ type: "go", screen: "map" });
                  }}
                >
                  <Icon name="map" size={18} /> Find next park
                </button>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <AnimatePresence>
        {rankUp && (
          <RankUp
            key="rankup"
            rank={rankUp}
            onExplore={() => {
              dispatch({ type: "trip", id: null });
              dispatch({ type: "go", screen: "map" });
            }}
            onDone={() => setRankUp(null)}
          />
        )}
      </AnimatePresence>
    </motion.div>
  );
}

function describeClaimEligibilityFailure(error: unknown): string {
  if (error instanceof ParkAlreadyClaimedError) return "This badge is already in your Dex. Your photo is still here. Return to the park list.";
  if (!(error instanceof ParkClaimEligibilityError)) return "Your claim is not ready yet. Your photo is still here. Return to the map and try again.";
  if (error.eligibility.reason === "locked") {
    const { remaining } = error.eligibility;
    return `This rarity is locked. Visit ${remaining} more ${remaining === 1 ? "park" : "parks"} to unlock it. Your photo is still here.`;
  }
  if (error.eligibility.reason === "unsupported-rarity") return "New Epic parks are not open for claims yet. Your photo is still here.";
  if (error.eligibility.reason === "unavailable") return "The park catalogue is still loading. Your photo is still here. Return to the map and try again.";
  return "Your claim is not ready yet. Your photo is still here. Return to the map and try again.";
}

const pop = {
  hidden: { y: 30, opacity: 0, scale: 0.9 },
  show: { y: 0, opacity: 1, scale: 1, transition: { type: "spring" as const, stiffness: 420, damping: 22 } },
};
