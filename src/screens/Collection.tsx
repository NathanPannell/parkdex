import { AnimatePresence, motion } from "motion/react";
import { useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Badge } from "../components/Badge";
import { Icon } from "../components/Icon";
import { Bubble, Kip } from "../components/Kip";
import { RollingNumber, Tilt } from "../components/Motion";
import { sfx } from "../lib/feedback";
import { distanceKm } from "../lib/geo";
import { CATEGORY_LABEL, LIVE_PARKS, PARK_BY_ID, RARITY, TOTAL_BADGES, type Park, type Rarity } from "../lib/parks";
import { useStore } from "../lib/store";

export function Collection() {
  const { state, dispatch } = useStore();
  const [open, setOpen] = useState<string | null>(null);
  const claimedIds = Object.keys(state.claims);
  const claimed = claimedIds.map((id) => PARK_BY_ID.get(id)!).filter(Boolean);
  const count = claimed.length;

  const next = useMemo(
    () => LIVE_PARKS.filter((p) => !state.claims[p.id]).sort((a, b) => distanceKm(state.user, [a.lng, a.lat]) - distanceKm(state.user, [b.lng, b.lat])),
    [state.claims, state.user],
  );
  // The case always shows every live badge: claimed ones shine, the rest wait as silhouettes.
  const ghosts = next;

  const tally = claimed.reduce<Partial<Record<Rarity, number>>>((t, p) => ({ ...t, [p.rarity]: (t[p.rarity] ?? 0) + 1 }), {});
  const openPark = open ? PARK_BY_ID.get(open) : undefined;

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
          <span className="eyebrow">Your case</span>
          <h1>
            <RollingNumber value={count} />
            <small> / {TOTAL_BADGES.toLocaleString("en-CA")}</small>
          </h1>
        </div>
        <motion.div className="col-head__kip" animate={{ rotate: [0, -3, 3, 0] }} transition={{ duration: 3, repeat: Infinity }}>
          <Kip size={82} pose={count ? "idle" : "sleep"} />
        </motion.div>
      </header>

      <div className="col-progress">
        <motion.div
          className="col-progress__fill"
          initial={{ width: 0 }}
          animate={{ width: `${Math.max(1.5, (count / TOTAL_BADGES) * 100)}%` }}
          transition={{ type: "spring", stiffness: 80, damping: 16, delay: 0.3 }}
        />
      </div>
      <div className="col-rarity">
        {(Object.keys(RARITY) as Rarity[]).map((r) => (
          <span key={r} className={`col-rarity__chip ${tally[r] ? "" : "is-empty"}`} style={{ background: RARITY[r].color, color: RARITY[r].ink }}>
            <b>{tally[r] ?? 0}</b> {RARITY[r].label}
          </span>
        ))}
      </div>

      <div className="case">
        <div className="case__glass" />
        {count === 0 && (
          <div className="case__empty">
            <Bubble side="left" style={{ position: "relative", marginBottom: 14 }}>
              Your case is empty. I'm saving this spot for badge #1.
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
              <Badge park={p} size={88} state="earned" showName={false} />
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
          {openPark && (
            <BadgeDetail
              park={openPark}
              onClose={() => setOpen(null)}
              onShare={() => {
                dispatch({ type: "trip", id: openPark.id });
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

function BadgeDetail({ park, onClose, onShare }: { park: Park; onClose: () => void; onShare: () => void }) {
  const { state } = useStore();
  const claim = state.claims[park.id];
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
                <Badge park={park} size={250} animated state="earned" />
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
