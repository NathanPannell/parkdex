import type { ReactNode } from "react";
import { MAX_PATCHES, progressLabel, type ShelfBadge } from "../lib/game/badges";
import { RARITY } from "../lib/parks";
import { AchievementBadge } from "./AchievementBadge";
import { Flag } from "./Flag";
import { Icon } from "./Icon";

type ViewProps = {
  items: readonly ShelfBadge[];
  patches: readonly string[];
  flagSeed: string | null;
  /** Earned badges already celebrated on this device; the rest are marked New. */
  seen: ReadonlySet<string>;
  onOpen: (badge: ShelfBadge) => void;
  children?: ReactNode;
};

/** The shelf itself: the player's flag with its patches, then every badge, earned or locked. */
export function BadgeShelfView({ items, patches, flagSeed, seen, onOpen, children }: ViewProps) {
  const earned = items.filter((item) => item.unlocked).length;
  // Earned badges first, so the start of the row is what the player has; then the rest in order.
  const ordered = [...items.filter((item) => item.unlocked), ...items.filter((item) => !item.unlocked)];
  return (
    <section className="account-card card badge-shelf" aria-labelledby="badge-shelf-title">
      <header className="badge-shelf__head">
        <div className="badge-shelf__title">
          <span className="eyebrow" id="badge-shelf-title">Badges</span>
          <strong>{earned} of {items.length} earned</strong>
          <span className="badge-shelf__help">Tap a badge to sew it onto your flag. Swipe for more.</span>
        </div>
        <div className="badge-shelf__flag">
          <Flag seed={flagSeed} size={76} patches={patches} className="is-waving" label={`Your flag with ${patches.length} ${patches.length === 1 ? "badge" : "badges"}`} />
          <span>{patches.length} of {MAX_PATCHES} sewn on</span>
        </div>
      </header>
      <ul className="badge-shelf__grid">
        {ordered.map((item) => {
          const sewn = patches.includes(item.id);
          const fresh = item.unlocked && !seen.has(item.id);
          return (
            <li key={item.id}>
              <button
                className={`badge-shelf__item ${item.unlocked ? "is-earned" : "is-locked"} ${sewn ? "is-sewn" : ""}`}
                onClick={() => onOpen(item)}
                aria-label={`${item.name}. ${item.unlocked ? (sewn ? "Earned, on your flag" : "Earned") : `Locked. ${item.hint}`}`}
              >
                <span className="badge-shelf__art">
                  <AchievementBadge badge={item} size={64} locked={!item.unlocked} />
                  {sewn && <span className="badge-shelf__sewn" aria-hidden="true"><Icon name="flag" size={12} stroke={2.6} /></span>}
                  {fresh && <span className="badge-shelf__new" aria-hidden="true">New</span>}
                </span>
                <span className="badge-shelf__name">{item.name}</span>
                <span className="badge-shelf__hint">{item.unlocked ? RARITY[item.rarity].label : progressLabel(item) ?? item.hint}</span>
              </button>
            </li>
          );
        })}
      </ul>
      {children}
    </section>
  );
}
