import { AnimatePresence, motion } from "motion/react";
import { useEffect, useMemo, useState } from "react";
import { useFeatureFlag } from "../lib/appConfig";
import { useBackHandler } from "../lib/backStack";
import { sfx } from "../lib/feedback";
import { markBadgesSeen, MAX_PATCHES, progressLabel, readSeenBadges, shelfBadges, togglePatch, type ShelfBadge } from "../lib/game/badges";
import { gameErrorMessage } from "../lib/game/client";
import { useGame } from "../lib/game/GameProvider";
import { useKipTip } from "../lib/kipTips";
import { RARITY } from "../lib/parks";
import { AchievementBadge } from "./AchievementBadge";
import { BadgeShelfView } from "./BadgeShelfView";
import { AboveNav } from "./DexPhoto";
import { Icon } from "./Icon";
import { useToast } from "./Toast";

function dateLabel(at: string): string {
  return new Date(at).toLocaleDateString("en-CA", { year: "numeric", month: "short", day: "numeric", timeZone: "America/Vancouver" });
}

/**
 * The badge shelf at the top of My Dex (#175): earned badges in colour, locked ones as silhouettes
 * with how to earn them, and up to 3 sewn onto the player's flag. Shown to players with a handle,
 * on a server that has badges, with the `badges` flag on. Otherwise it renders nothing, so
 * Collection starts with its summary and leaves no gap.
 */
export function BadgeShelf() {
  return useFeatureFlag("badges") ? <ShelfForPlayer /> : null;
}

function ShelfForPlayer() {
  const game = useGame();
  const statuses = game.me?.badges;
  const player = game.me?.player ?? null;
  if (!player || !statuses) return null;
  return <Shelf />;
}

function Shelf() {
  const game = useGame();
  const toast = useToast();
  const me = game.me!;
  const accountId = game.accountId ?? "";
  const items = useMemo(() => shelfBadges(me.badges), [me.badges]);
  const patches = me.flagPatches ?? [];
  const earned = items.filter((item) => item.unlocked);
  const [seen, setSeen] = useState(() => readSeenBadges(accountId));
  const [open, setOpen] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const openBadge = open ? items.find((item) => item.id === open) ?? null : null;
  // The first earned badge brings Kip's Tip about sewing badges on (#172).
  useKipTip("badge-first", earned.length > 0);
  useEffect(() => setSeen(readSeenBadges(accountId)), [accountId]);

  const show = (item: ShelfBadge) => {
    sfx.pop();
    setOpen(item.id);
    if (item.unlocked && !seen.has(item.id)) {
      markBadgesSeen(accountId, [item.id]);
      setSeen((current) => new Set([...current, item.id]));
    }
  };

  const toggle = async (item: ShelfBadge) => {
    const next = togglePatch(patches, item.id, new Set(earned.map((badge) => badge.id)));
    if (next.full) {
      toast(`Your flag has room for ${MAX_PATCHES} badges. Take one off first.`, "kip");
      return;
    }
    if (!next.changed) return;
    setSaving(true);
    try {
      await game.savePatches(next.patches);
      sfx.tap();
      toast(next.patches.includes(item.id) ? `${item.name} is on your flag.` : `${item.name} is off your flag.`, "kip");
    } catch (error) {
      toast(gameErrorMessage(error), "kip");
    } finally {
      setSaving(false);
    }
  };

  return (
    <BadgeShelfView items={items} patches={patches} flagSeed={me.player?.flagSeed ?? me.flagSeed} seen={seen} onOpen={show}>
      <BadgeSheet badge={openBadge} sewn={!!openBadge && patches.includes(openBadge.id)} full={patches.length >= MAX_PATCHES} saving={saving}
        onToggle={(item) => void toggle(item)} onClose={() => setOpen(null)} />
    </BadgeShelfView>
  );
}

type SheetProps = {
  badge: ShelfBadge | null;
  sewn: boolean;
  full: boolean;
  saving: boolean;
  onToggle: (badge: ShelfBadge) => void;
  onClose: () => void;
};

function BadgeSheet({ badge, sewn, full, saving, onToggle, onClose }: SheetProps) {
  useBackHandler(onClose, !!badge);
  const progress = badge ? progressLabel(badge) : null;
  return (
    <AboveNav>
      <AnimatePresence>
        {badge && (
          <motion.div key="badge-detail" className="dex-detail badge-detail" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <button className="dex-detail__scrim" onClick={onClose} aria-label="Close" tabIndex={-1} />
            <motion.section
              className="dex-detail__sheet"
              role="dialog"
              aria-modal="true"
              aria-labelledby="badge-detail-title"
              initial={{ y: "100%" }}
              animate={{ y: 0 }}
              exit={{ y: "100%" }}
              transition={{ type: "spring", stiffness: 320, damping: 32 }}
            >
              <div className="sheet__handle" />
              <header className="dex-detail__head">
                <div>
                  <span className="eyebrow">{"★".repeat(RARITY[badge.rarity].stars)} {RARITY[badge.rarity].label} badge</span>
                  <h2 id="badge-detail-title">{badge.name}</h2>
                </div>
                <button className="park-sheet__close dex-detail__close" onClick={onClose} aria-label="Close">
                  <Icon name="close" size={18} stroke={3} />
                </button>
              </header>
              <div className="dex-detail__body badge-detail__body">
                <motion.div className="badge-detail__hero" initial={{ scale: 0.6, rotate: -8 }} animate={{ scale: 1, rotate: 0 }} transition={{ type: "spring", stiffness: 420, damping: 18 }}>
                  <AchievementBadge badge={badge} size={190} locked={!badge.unlocked} showName={badge.unlocked} />
                </motion.div>
                <p className="badge-detail__hint">{badge.hint}.</p>
                <p className="badge-detail__status">
                  {badge.unlocked
                    ? badge.unlockedAt ? `Earned ${dateLabel(badge.unlockedAt)}.` : "Earned."
                    : progress ? `${progress} so far.` : "Not earned yet."}
                </p>
                {badge.unlocked && (
                  <div className="badge-detail__actions">
                    <button className={`btn btn--sm ${sewn ? "btn--paper" : "btn--sun"}`} disabled={saving || (!sewn && full)} onClick={() => onToggle(badge)}>
                      <Icon name="flag" size={18} /> {sewn ? "Take off your flag" : "Sew onto your flag"}
                    </button>
                    {!sewn && full && <p className="account-help">Your flag has room for {MAX_PATCHES} badges. Take one off first.</p>}
                  </div>
                )}
              </div>
            </motion.section>
          </motion.div>
        )}
      </AnimatePresence>
    </AboveNav>
  );
}
