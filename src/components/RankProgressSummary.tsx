import { formatRarityRequirements } from "../lib/rarityUi";
import { RARITY } from "../lib/parks";
import type { CollectionRankProgress } from "../lib/progression";

export function RankProgressSummary({ progress }: { progress: CollectionRankProgress }) {
  const openTierNames = progress.openTiers.map((rarity) => RARITY[rarity].label);
  const openTierSummary = openTierNames.length < 2
    ? openTierNames[0] ?? ""
    : `${openTierNames.slice(0, -1).join(", ")} and ${openTierNames[openTierNames.length - 1]}`;

  return (
    <div className="rank-progress-summary">
      <div className="rank-progress-summary__current">
        <span>Current rank</span>
        <strong>{progress.available ? progress.rank : "Checking your rank"}</strong>
      </div>
      <div className="rank-progress-summary__next">
        {progress.available && progress.next ? (
          <>
            <span>Next rank</span>
            <strong>{progress.next.rank}</strong>
            <p>{formatRarityRequirements(progress.next.remaining)} to go</p>
          </>
        ) : progress.available ? (
          <p>All four ranks unlocked</p>
        ) : (
          <p>Saved visits and the current park list are loading.</p>
        )}
      </div>
      {progress.available && <p className="rank-progress-summary__open">{openTierSummary} parks open</p>}
    </div>
  );
}
