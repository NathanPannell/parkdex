import { AnimatePresence, motion } from "motion/react";
import { useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { EarnedBadge } from "../components/EarnedBadge";
import { Icon } from "../components/Icon";
import { Bubble, Kip } from "../components/Kip";
import { RollingNumber, Tilt } from "../components/Motion";
import { RankCard, RankTrail } from "../components/Rank";
import { sfx } from "../lib/feedback";
import { badgeTotal, CATEGORY_LABEL, type Park } from "../lib/parks";
import { getCollectionRankProgress, getRarityProgress } from "../lib/progression";
import { useStore, type Claim } from "../lib/store";
import { useContent, useContentRuntime, useContentStatus } from "../lib/content/provider";

export function Collection() {
  const { state, dispatch } = useStore();
  const content = useContent();
  const status = useContentStatus();
  const runtime = useContentRuntime();
  const [open, setOpen] = useState<string | null>(null);
  const [trailOpen, setTrailOpen] = useState(false);
  const claimedIds = Object.keys(state.claims);
  const claimed = claimedIds.map((id) => content?.parkById.get(id) ?? state.claims[id]?.parkSnapshot ?? undefined).filter((park): park is Park => !!park);
  const count = claimedIds.length;
  const showContentRetry = !status.waitingForWifi && (status.error || status.phase === "offline");
  const catalogueMessage = status.waitingForWifi
    ? null
    : status.phase === "offline"
      ? "Connect to the internet to download your park guides."
      : status.error
        ? "I couldn't download the park guides."
        : "Loading your park guides…";
  const totalBadges = content ? badgeTotal(content.liveParks, claimedIds) : undefined;
  const rarityProgress = useMemo(
    () => getRarityProgress(
      state.claims,
      state.progressReady && state.progressOwnerKey && content ? content.parkById : undefined,
    ),
    [state.claims, state.progressReady, state.progressOwnerKey, content],
  );
  const rankProgress = getCollectionRankProgress(rarityProgress);
  const openPark = state.progressReady && open ? content?.parkById.get(open) ?? state.claims[open]?.parkSnapshot ?? undefined : undefined;
  const openClaim = open ? state.claims[open] : undefined;
  const findPark = () => {
    setTrailOpen(false);
    dispatch({ type: "go", screen: "map" });
  };

  return (
    <motion.div
      className="screen collection scroll"
      initial={{ x: "100%" }}
      animate={{ x: 0 }}
      exit={{ x: "100%" }}
      transition={{ type: "spring", stiffness: 300, damping: 34 }}
    >
      <header className="col-head">
        <div>
          <span className="eyebrow">Your Dex</span>
          <h1>
            <RollingNumber value={count} />
            <small> / {totalBadges?.toLocaleString("en-CA") ?? "…"} badges</small>
          </h1>
        </div>
        <button className="btn btn--paper btn--sm collection-account" onClick={() => dispatch({ type: "go", screen: "account" })}>
          <Icon name="link" size={17} /> Account
        </button>
      </header>

      <RankCard progress={rankProgress} onOpen={() => { sfx.pop(); setTrailOpen(true); }} />

      <div className={`case ${count === 0 ? "case--empty" : ""}`}>
        <div className="case__glass" />
        {!state.progressReady ? (
          <div className="case__empty">
            <Bubble side="left" style={{ position: "relative", marginBottom: 14 }}>
              {state.progressError ? "Your saved Dex needs attention." : "Opening your saved Dex…"}
            </Bubble>
            {state.progressError && <button className="btn btn--sm btn--paper" onClick={() => dispatch({ type: "go", screen: "account" })}>Account help</button>}
          </div>
        ) : !content ? (
          <div className="case__empty">
            {catalogueMessage && (
              <Bubble side="left" style={{ position: "relative", marginBottom: 14 }}>
                {catalogueMessage}
                {status.syncStage === "downloading" && status.totalBytes > 0 && ` ${Math.floor((status.downloadedBytes / status.totalBytes) * 100)}%`}
              </Bubble>
            )}
            {showContentRetry && <button className="btn btn--sm btn--paper" onClick={() => void runtime.retry()}>Try again</button>}
          </div>
        ) : count === 0 ? (
          <div className="case__first">
            <Bubble side="left" style={{ position: "relative" }}>
              Nothing here yet. Your first badge goes right on this shelf!
            </Bubble>
            <motion.div className="case__first-kip" animate={{ rotate: [0, -3, 3, 0] }} transition={{ duration: 3, repeat: Infinity }}>
              <Kip size={96} pose="sleep" />
            </motion.div>
            <button className="btn btn--sun btn--sm" onClick={findPark}>
              <Icon name="map" size={18} /> Find a park near me
            </button>
          </div>
        ) : null}
        {claimed.length > 0 && (
          <div className="case__grid">
            {claimed.map((p, i) => (
              <motion.button
                key={p.id}
                className="slot slot--filled"
                onClick={() => {
                  sfx.pop();
                  setOpen(p.id);
                }}
                initial={{ y: -60, opacity: 0, rotate: -12 }}
                animate={{ y: 0, opacity: 1, rotate: 0 }}
                transition={{ type: "spring", stiffness: 380, damping: 16, delay: 0.2 + i * 0.07 }}
                whileTap={{ scale: 0.92 }}
              >
                <EarnedBadge park={p} claim={state.claims[p.id]} size={88} state="earned" showName={false} />
                <span className="slot__plate">{p.short}</span>
              </motion.button>
            ))}
          </div>
        )}
        {state.progressReady && content && claimedIds.some((id) => !content.parkById.has(id)) && (
          <div className="case__empty account-case-note">
            <Bubble side="left" style={{ position: "relative" }}>
              Some saved badge details are not in this guide yet. Your visits remain saved for your account backup.
            </Bubble>
          </div>
        )}
      </div>

      <section className="fb-cta card">
        <Kip pose="think" size={64} />
        <div>
          <strong>Found a bug or have an idea?</strong>
          <span>Tell the Parkdex team without leaving the app.</span>
        </div>
        <button className="btn btn--sm btn--paper" onClick={() => dispatch({ type: "feedback", open: true })}>
          <Icon name="chat" size={18} /> Send feedback
        </button>
      </section>

      <div className="col-foot" />

      <AnimatePresence>
        {trailOpen && <RankTrail key="trail" progress={rankProgress} onClose={() => setTrailOpen(false)} onExplore={findPark} />}
      </AnimatePresence>

      {/* Portalled to the device so the detail covers the bottom nav too. */}
      {createPortal(
        <AnimatePresence>
          {openPark && openClaim && (
            <BadgeDetail
              park={openPark}
              claim={openClaim}
              onClose={() => setOpen(null)}
              onShare={() => {
                dispatch({ type: "shareClaim", claimId: state.claims[openPark.id]?.claimId ?? null });
                dispatch({ type: "go", screen: "share" });
              }}
            />
          )}
        </AnimatePresence>,
        document.querySelector(".device") ?? document.body,
      )}
    </motion.div>
  );
}

function BadgeDetail({ park, claim, onClose, onShare }: { park: Park; claim: Claim; onClose: () => void; onShare: () => void }) {
  const [flipped, setFlipped] = useState(false);
  const date = new Date(claim.at).toLocaleDateString("en-CA", { weekday: "short", month: "long", day: "numeric", year: "numeric" });

  return (
    <motion.div className="detail" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose}>
      <motion.div
        className="detail__inner"
        onClick={(e) => e.stopPropagation()}
        initial={{ scale: 0.6, y: 80 }}
        animate={{ scale: 1, y: 0 }}
        exit={{ scale: 0.7, y: 80, opacity: 0 }}
        transition={{ type: "spring", stiffness: 300, damping: 22 }}
      >
        <button
          className="flip"
          onClick={() => {
            sfx.whoosh();
            setFlipped((f) => !f);
          }}
          aria-label="Flip badge"
        >
          <motion.div className="flip__card" animate={{ rotateY: flipped ? 180 : 0 }} transition={{ type: "spring", stiffness: 160, damping: 16 }}>
            <div className="flip__face">
              <Tilt>
                <EarnedBadge park={park} claim={claim} size={250} animated state="earned" />
              </Tilt>
            </div>
            <div className="flip__face flip__face--back">
              <div className="polaroid polaroid--detail">
                <div className="polaroid__img">
                  <img src={claim.photo} alt="" />
                </div>
                <span className="polaroid__caption">{park.short}</span>
              </div>
            </div>
          </motion.div>
          <span className="flip__hint">
            <Icon name="flip" size={14} /> Tap to see your {flipped ? "badge" : "photo"}
          </span>
        </button>
        <div className="detail__text">
          <h2>{park.name}</h2>
          <p>
            {CATEGORY_LABEL[park.category]} · {park.region}
          </p>
          <p className="detail__date">Claimed {date}</p>
        </div>
        <div className="detail__actions">
          <button className="btn btn--sun btn--sm" onClick={onShare}>
            <Icon name="share" size={18} /> Share
          </button>
          <button className="btn btn--paper btn--sm" onClick={onClose}>
            Done
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}
