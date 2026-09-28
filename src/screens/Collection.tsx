import { AnimatePresence, motion } from "motion/react";
import { useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Badge } from "../components/Badge";
import { EarnedBadge } from "../components/EarnedBadge";
import { Icon } from "../components/Icon";
import { Bubble, Kip } from "../components/Kip";
import { RollingNumber, Tilt } from "../components/Motion";
import { sfx } from "../lib/feedback";
import { distanceKm } from "../lib/geo";
import { badgeTotal, CATEGORY_LABEL, RARITY, type Park, type Rarity } from "../lib/parks";
import { getRarityProgress, RARITY_TIERS, type ProgressionRarity, type RarityCounts, type RarityProgress, type RarityTierProgress } from "../lib/progression";
import { useStore, type Claim } from "../lib/store";
import { useContent, useContentRuntime, useContentStatus } from "../lib/content/provider";

export function Collection() {
  const { state, dispatch } = useStore();
  const content = useContent();
  const status = useContentStatus();
  const runtime = useContentRuntime();
  const [open, setOpen] = useState<string | null>(null);
  const claimedIds = Object.keys(state.claims);
  const claimed = claimedIds.map((id) => content?.parkById.get(id) ?? state.claims[id]?.parkSnapshot ?? undefined).filter((park): park is Park => !!park);
  const count = claimedIds.length;
  const totalBadges = content ? badgeTotal(content.parks, claimedIds) : undefined;
  const rarityProgress = useMemo(
    () => getRarityProgress(
      state.claims,
      state.progressReady && state.progressOwnerKey && content ? content.parkById : undefined,
    ),
    [state.claims, state.progressReady, state.progressOwnerKey, content],
  );

  const next = useMemo(
    () => (content?.parks ?? []).filter((p) => !state.claims[p.id]).sort((a, b) => distanceKm(state.user, [a.lng, a.lat]) - distanceKm(state.user, [b.lng, b.lat])),
    [content?.parks, state.claims, state.user],
  );
  // The case shows the current catalogue, including parks without published art.
  const ghosts = next;

  // Known park IDs follow the current catalogue. Removed parks retain their saved label.
  const tally = claimed.reduce<Partial<Record<Rarity, number>>>((t, p) => ({ ...t, [p.rarity]: (t[p.rarity] ?? 0) + 1 }), {});
  const rarityChips: Rarity[] = [];
  for (const rarity of RARITY_TIERS) {
    if (rarity === "legendary" && (tally.epic ?? 0) > 0) rarityChips.push("epic");
    rarityChips.push(rarity);
  }
  const openPark = state.progressReady && open ? content?.parkById.get(open) ?? state.claims[open]?.parkSnapshot ?? undefined : undefined;
  const openClaim = open ? state.claims[open] : undefined;

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
            <small> / {totalBadges?.toLocaleString("en-CA") ?? "…"}</small>
          </h1>
        </div>
        <div className="col-head__tools">
          <motion.div className="col-head__kip" animate={{ rotate: [0, -3, 3, 0] }} transition={{ duration: 3, repeat: Infinity }}>
            <Kip size={82} pose={count ? "idle" : "sleep"} />
          </motion.div>
          <button className="btn btn--paper btn--sm collection-account" onClick={() => dispatch({ type: "go", screen: "account" })}>
            <Icon name="link" size={17} /> Account
          </button>
        </div>
      </header>

      <div className="col-progress">
        <motion.div
          className="col-progress__fill"
          initial={{ width: 0 }}
          animate={{ width: `${totalBadges ? Math.max(1.5, Math.min(100, (count / totalBadges) * 100)) : 1.5}%` }}
          transition={{ type: "spring", stiffness: 80, damping: 16, delay: 0.3 }}
        />
      </div>
      <div className="col-rarity-label eyebrow">Earned parks by current rarity</div>
      <div className="col-rarity" aria-label="Earned parks by current rarity; removed parks use saved rarity">
        {rarityChips.map((r) => (
          <span key={r} className={`col-rarity__chip ${tally[r] ? "" : "is-empty"}`} style={{ background: RARITY[r].color, color: RARITY[r].ink }}>
            <b>{tally[r] ?? 0}</b> {RARITY[r].label}
          </span>
        ))}
      </div>

      <section className="collection-rarity-progress" aria-label="Current rarity progression">
        <div className="collection-rarity-progress__head">
          <strong>Rarity progression</strong>
          <span>{rarityProgress.available ? `${RARITY[rarityProgress.highestUnlocked].label} tier open` : "Checking progress"}</span>
        </div>
        {rarityProgress.available ? (
          <div className="collection-rarity-progress__requirements">
            {RARITY_TIERS.map((rarity) => (
              <RarityProgressRow key={rarity} rarity={rarity} progress={rarityProgress} />
            ))}
          </div>
        ) : (
          <p>Saved visits and the current park list are loading.</p>
        )}
      </section>

      <div className="case">
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
            <Bubble side="left" style={{ position: "relative", marginBottom: 14 }}>
              {status.error ? "I couldn't download the park guides." : status.waitingForWifi ? "Park guides are waiting for Wi-Fi." : status.phase === "offline" ? "Connect to download your park guides." : "Loading your park guides…"}
              {status.totalBytes > 0 && ` ${Math.floor((status.downloadedBytes / status.totalBytes) * 100)}%`}
            </Bubble>
            {(status.error || status.phase === "offline") && <button className="btn btn--sm btn--paper" onClick={() => void runtime.retry()}>Try again</button>}
          </div>
        ) : count === 0 && (
          <div className="case__empty">
            <Bubble side="left" style={{ position: "relative", marginBottom: 14 }}>
              Your Dex is empty. I’m saving this spot for badge #1.
            </Bubble>
          </div>
        )}
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
          {ghosts.map((p, i) => (
            <motion.button
              key={p.id}
              className="slot"
              onClick={() => {
                dispatch({ type: "focus", id: p.id });
                dispatch({ type: "go", screen: "map" });
              }}
              initial={{ opacity: 0, scale: 0.6 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ delay: 0.3 + (count + i) * 0.04 }}
            >
              <Badge park={p} size={88} state="silhouette" showName={false} />
              <span className="slot__q">?</span>
              <span className="slot__plate slot__plate--ghost">{p.short}</span>
            </motion.button>
          ))}
        </div>
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

function requirementProgress(tier: RarityTierProgress) {
  return Object.entries(tier.requirements).flatMap(([rarity, required]) => {
    if (required === undefined) return [];
    const key = rarity as keyof RarityCounts;
    const label = RARITY[key].label;
    return [`${label} ${tier.current[key] ?? 0}/${required}`];
  }).join(" · ");
}

function RarityProgressRow({ rarity, progress }: { rarity: ProgressionRarity; progress: RarityProgress }) {
  const tier = progress.tiers[rarity];
  const open = rarity === "common" || tier.unlocked;
  const detail = rarity === "common"
    ? `${progress.counts.common} Common parks in Dex`
    : requirementProgress(tier);
  const status = rarity === "common" ? "Open" : open ? "Unlocked" : "Locked";

  return (
    <div className="collection-rarity-progress__row" data-state={open ? "unlocked" : "locked"} aria-label={`${RARITY[rarity].label}: ${detail}. ${status}`}>
      <span style={{ background: RARITY[rarity].color, color: RARITY[rarity].ink }}>{RARITY[rarity].label}</span>
      <span>{detail}</span>
      <strong>{status}</strong>
    </div>
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
