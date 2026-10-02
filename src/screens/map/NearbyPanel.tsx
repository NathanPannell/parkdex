import { AnimatePresence, motion } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Badge } from "../../components/Badge";
import { Icon } from "../../components/Icon";
import { formatDistance } from "../../lib/geo";
import { isLive, RARITY, type Park } from "../../lib/parks";
import { searchParks } from "../../lib/parkSearch";
import type { ParkRarityEligibility } from "../../lib/progression";
import { rarityLockMessage } from "../../lib/rarityUi";

type Item = { park: Park; km: number; eligibility: ParkRarityEligibility; claimed: boolean };

type Props = {
  nearby: Item[];
  all: Item[];
  onSelect: (id: string) => void;
};

const spring = { type: "spring" as const, stiffness: 380, damping: 30 };
// Results appear a few at a time so a long list streams in instead of landing at once.
const STREAM_STEP = 8;
const STREAM_MS = 70;

export function NearbyPanel({ nearby, all, onSelect }: Props) {
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const hits = useMemo(() => searchParks(all, query), [all, query]);
  const shown = useStreamedCount(hits.length, query);
  const items = searching && query.trim() ? hits.slice(0, shown) : nearby;

  const close = () => {
    setSearching(false);
    setQuery("");
  };

  return (
    <div className="nearby__inner">
      <motion.div className="nearby__head" layout transition={spring}>
        <AnimatePresence mode="popLayout" initial={false}>
          {searching ? (
            <motion.label
              key="search"
              className="nearby__search"
              initial={{ width: 150, opacity: 0.4 }}
              animate={{ width: "100%", opacity: 1 }}
              exit={{ width: 150, opacity: 0 }}
              transition={spring}
            >
              <Icon name="search" size={18} stroke={2.8} />
              <input
                ref={input}
                autoFocus
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search parks"
                aria-label="Search parks"
                enterKeyHint="search"
              />
              <button className="nearby__search-close" onClick={close} aria-label="Close search">
                <Icon name="close" size={14} stroke={3} />
              </button>
            </motion.label>
          ) : (
            <motion.div key="label" className="nearby__label" initial={{ opacity: 0, x: -12 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -12 }} transition={spring}>
              <span className="eyebrow">Badges near you</span>
              <motion.button className="nearby__search-open" onClick={() => setSearching(true)} aria-label="Search parks" whileTap={{ scale: 0.88 }}>
                <Icon name="search" size={16} stroke={2.8} />
              </motion.button>
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>
      <div className="nearby__rail scroll">
        <AnimatePresence initial={false}>
          {searching && query.trim() && !hits.length ? (
            <motion.p key="empty" className="nearby__empty card" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
              No parks match "{query.trim()}"
            </motion.p>
          ) : (
            items.map((item, i) => <ParkCard key={item.park.id} item={item} index={i % STREAM_STEP} onSelect={onSelect} />)
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

function ParkCard({ item, index, onSelect }: { item: Item; index: number; onSelect: (id: string) => void }) {
  const { park, km, eligibility, claimed } = item;
  const status = claimed ? "In your Dex" : eligibility.eligible ? `${formatDistance(km)} away` : eligibility.reason === "unavailable" ? "Checking" : "Locked";
  return (
    <motion.button
      layout
      className={`nearby__card card ${eligibility.eligible || claimed ? "" : "nearby__card--locked"}`}
      onClick={() => onSelect(park.id)}
      aria-label={`${park.name}, ${RARITY[park.rarity].label}. ${claimed || eligibility.eligible ? status : rarityLockMessage(eligibility)}${isLive(park) ? "" : ". Badge art coming soon"}`}
      initial={{ y: 60, opacity: 0, rotate: 4 }}
      animate={{ y: 0, opacity: 1, rotate: 0 }}
      exit={{ y: 40, opacity: 0, transition: { duration: 0.15 } }}
      transition={{ type: "spring", stiffness: 380, damping: 22, delay: 0.04 + index * 0.04 }}
      whileTap={{ scale: 0.94, rotate: -2 }}
    >
      <span className="nearby__badge">
        <Badge park={park} size={64} showName={false} state="preview" />
      </span>
      <span className="nearby__name">{park.short}</span>
      <span className="nearby__meta">
        <i style={{ background: RARITY[park.rarity].ink }} />
        {status}
      </span>
    </motion.button>
  );
}

function useStreamedCount(total: number, key: string): number {
  const [count, setCount] = useState(STREAM_STEP);
  useEffect(() => {
    setCount(STREAM_STEP);
    const timer = window.setInterval(() => {
      setCount((current) => {
        if (current >= total) window.clearInterval(timer);
        return Math.min(total, current + STREAM_STEP);
      });
    }, STREAM_MS);
    return () => window.clearInterval(timer);
  }, [total, key]);
  return count;
}
