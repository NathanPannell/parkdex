import { RARITY, type Rarity } from "../lib/parks";
import { isRankProgressionEnabled, rankFor, type ParkRarityEligibility } from "../lib/progression";
import { parksLabel } from "../lib/rarityUi";
import { RankEmblem } from "./Rank";

type Props = {
  rarity: Rarity;
  eligibility: ParkRarityEligibility;
};

/** Tells a visitor, on the park itself, which rank opens this park and how close they are. */
export function RarityGuide({ rarity, eligibility }: Props) {
  if (!isRankProgressionEnabled() || rarity === "common" || eligibility.reason === "already-earned") return null;
  const label = RARITY[rarity].label;

  if (eligibility.reason === "unavailable") {
    return <section className="rarity-guide" aria-live="polite"><p>Checking your saved progress…</p></section>;
  }
  if (rarity === "epic" || eligibility.reason === "unsupported-rarity") {
    return <section className="rarity-guide"><p>Epic is a retired tier. Epic badges you already earned stay in your Dex.</p></section>;
  }

  const rank = rankFor(rarity);
  const locked = eligibility.reason === "locked";
  return (
    <section className={`rarity-guide ${locked ? "rarity-guide--locked" : ""}`} aria-label={`${label} rarity`}>
      <RankEmblem rank={rank} size={46} locked={locked} />
      <div className="rarity-guide__text">
        <strong>{locked ? `${label} parks open at ${rank.name}` : `Unlocked at ${rank.name}`}</strong>
        {locked ? (
          <>
            <span className="rarity-guide__bar" aria-hidden="true">
              <span style={{ width: `${Math.max(6, (eligibility.visited / eligibility.required) * 100)}%`, background: RARITY[rarity].ink }} />
            </span>
            <span>{eligibility.visited} of {parksLabel(eligibility.required)} visited · <b>{eligibility.remaining} to go</b>. Any park counts.</span>
          </>
        ) : (
          <span>You've visited {parksLabel(eligibility.visited)}, so {label} parks are open to claim.</span>
        )}
      </div>
    </section>
  );
}
