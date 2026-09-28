import { useEffect, useId, useRef, useState } from "react";
import { RARITY, type Rarity } from "../lib/parks";
import type { ParkRarityEligibility } from "../lib/progression";
import { formatRarityRequirements } from "../lib/rarityUi";

type Props = {
  rarity: Rarity;
  eligibility: ParkRarityEligibility;
  progressReady: boolean;
  ownerKey: string | null;
};

const STORAGE_PREFIX = "parkdex:ui:rarity-intro:v1:";
const TIERS: readonly Rarity[] = ["uncommon", "rare", "epic", "legendary"];

function storageKey(ownerKey: string) {
  return `${STORAGE_PREFIX}${encodeURIComponent(ownerKey)}`;
}

function readSeen(ownerKey: string, rarity: Rarity): boolean {
  if (typeof window === "undefined") return false;
  try {
    const value = JSON.parse(window.localStorage.getItem(storageKey(ownerKey)) ?? "null") as { version?: unknown; seen?: unknown } | null;
    return value?.version === 1 && Array.isArray(value.seen) && value.seen.includes(rarity);
  } catch {
    return false;
  }
}

function markSeen(ownerKey: string, rarity: Rarity) {
  if (typeof window === "undefined") return;
  try {
    const key = storageKey(ownerKey);
    const value = JSON.parse(window.localStorage.getItem(key) ?? "null") as { version?: unknown; seen?: unknown } | null;
    const seen = value?.version === 1 && Array.isArray(value.seen)
      ? value.seen.filter((tier): tier is string => typeof tier === "string")
      : [];
    if (!seen.includes(rarity)) seen.push(rarity);
    window.localStorage.setItem(key, JSON.stringify({ version: 1, seen }));
  } catch {
    // The guide still works when this browser blocks local storage.
  }
}

function explanation(rarity: Rarity, requirements: ParkRarityEligibility["requirements"]) {
  if (rarity === "epic") return "Epic is a legacy tier. Badges you already earned stay in your Dex, and new Epic claims are unavailable.";
  const needs = formatRarityRequirements(requirements);
  return `${RARITY[rarity].label} parks unlock after ${needs}. Each badge you claim counts once.`;
}

export function RarityGuide({ rarity, eligibility, progressReady, ownerKey }: Props) {
  const explanationId = `rarity-guide-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const processed = useRef(new Set<string>());
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const tier = TIERS.includes(rarity) ? rarity : null;
  const ready = progressReady && eligibility.reason !== "unavailable" && !!ownerKey && !!tier;
  const currentKey = ready ? `${ownerKey}:${rarity}` : null;
  const isCurrent = currentKey !== null && activeKey === currentKey;
  const isExpanded = isCurrent && expanded;
  const requirements = Object.entries(eligibility.requirements) as ["common" | "uncommon" | "rare", number][];

  useEffect(() => {
    if (!ready || !ownerKey || !tier || !currentKey) {
      setActiveKey(null);
      setExpanded(false);
      return;
    }
    if (processed.current.has(currentKey)) return;
    processed.current.add(currentKey);
    const seen = readSeen(ownerKey, tier);
    if (!seen) markSeen(ownerKey, tier);
    setActiveKey(currentKey);
    setExpanded(!seen);
  }, [currentKey, ownerKey, ready, tier]);

  if (rarity === "common") return null;

  const state = eligibility.reason === "locked" || eligibility.reason === "unsupported-rarity"
    ? "locked"
    : eligibility.reason === "unavailable"
      ? "loading"
      : eligibility.reason === "already-earned"
        ? "earned"
        : "unlocked";

  return (
    <section className={`rarity-guide rarity-guide--${state}`} aria-label={`${RARITY[rarity].label} rarity requirements`}>
      <div className="rarity-guide__head">
        <span className="eyebrow">Rarity progression</span>
        <span className={`rarity-guide__status rarity-guide__status--${state}`}>
          {state === "locked" ? "Locked" : state === "loading" ? "Checking" : state === "earned" ? "Earned" : "Unlocked"}
        </span>
      </div>

      {state === "loading" ? (
        <p className="rarity-guide__loading">Checking your saved progress…</p>
      ) : rarity === "epic" ? (
        <p className="rarity-guide__loading">New Epic claims are unavailable. Any Epic badge you already earned remains in your Dex.</p>
      ) : eligibility.reason === "already-earned" && requirements.length === 0 ? (
        <p className="rarity-guide__loading">Already earned. Checking current rarity requirements…</p>
      ) : requirements.length > 0 ? (
        <ul className="rarity-guide__requirements">
          {requirements.map(([requiredRarity, required]) => {
            const current = eligibility.current[requiredRarity] ?? 0;
            const remaining = eligibility.remaining[requiredRarity] ?? 0;
            return (
              <li key={requiredRarity}>
                <span>{RARITY[requiredRarity].label}</span>
                <strong>{current} of {required}</strong>
                {remaining > 0 && <em>{remaining} to go</em>}
                {remaining === 0 && <em>Met</em>}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="rarity-guide__loading">This rarity is open to claim.</p>
      )}

      {isExpanded && (
        <p className="rarity-guide__explanation" id={explanationId}>
          {explanation(rarity, eligibility.requirements)}
        </p>
      )}

      {ready && (
        <button
          type="button"
          className="rarity-guide__toggle"
          aria-expanded={isExpanded}
          aria-controls={explanationId}
          onClick={() => {
            setActiveKey(currentKey);
            setExpanded((value) => activeKey === currentKey ? !value : true);
          }}
        >
          {isExpanded ? "Hide rarity guide" : "How rarity unlocks work"}
        </button>
      )}
    </section>
  );
}
