import { motion, type Variants } from "motion/react";
import { useFeatureFlag } from "../lib/appConfig";
import { badgeById } from "../lib/game/badges";
import type { BadgeUnlock as Unlock } from "../lib/game/client";
import { useKipTip } from "../lib/kipTips";
import { AchievementBadge } from "./AchievementBadge";

type Props = {
  /** The badges a visit or founding unlocked; IDs this build does not know are left out. */
  unlocks: readonly Unlock[] | undefined;
  /** Opens the badge shelf. */
  onOpen: () => void;
  /** Motion variants, so the card pops in with the rest of the result. */
  variants?: Variants;
  /** A small chip in a row with other results, instead of a card. */
  compact?: boolean;
};

/**
 * The unlock moment (#175): the new badge spins in on the result of the visit or founding that
 * earned it, and the first one brings Kip's Tip about sewing badges onto your flag. Nothing at all
 * while the `badges` flag is off, even when the server reports an unlock.
 */
export function BadgeUnlock({ unlocks, onOpen, variants, compact = false }: Props) {
  const enabled = useFeatureFlag("badges");
  const badges = enabled ? (unlocks ?? []).flatMap((unlock) => badgeById(unlock.id) ?? []) : [];
  useKipTip("badge-first", badges.length > 0);
  if (!badges.length) return null;
  const [first] = badges;
  return (
    <motion.button
      variants={variants}
      className={compact ? "badge-unlock badge-unlock--compact" : "badge-unlock"}
      onClick={onOpen}
      aria-label={`Badge earned: ${badges.map((badge) => badge.name).join(", ")}. Open your badges.`}
    >
      <motion.span initial={{ rotate: -20, scale: 0.4 }} animate={{ rotate: 0, scale: 1 }} transition={{ type: "spring", stiffness: 420, damping: 12, delay: 0.3 }}>
        <AchievementBadge badge={first} size={compact ? 30 : 58} />
      </motion.span>
      <span className="badge-unlock__text">
        <span>{badges.length === 1 ? "Badge earned" : `${badges.length} badges earned`}</span>
        <strong>{badges.length === 1 ? first.name : `${first.name} +${badges.length - 1}`}</strong>
      </span>
    </motion.button>
  );
}
