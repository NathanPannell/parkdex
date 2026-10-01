import { useEffect, useState } from "react";
import { api } from "../api";
import { Icon } from "../ui";

type Counts = { available: false } | { available: true; environment: string; feedback: Record<string, number>; proposals: Record<string, number> };

/** Tells the operator what is waiting in the database they are not looking at. */
export function OtherDatabaseNote({ board, onSwitch }: { board: "feedback" | "proposals"; onSwitch(target: string): void }) {
  const [counts, setCounts] = useState<Counts | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    api<Counts>("/api/other-database", { signal: controller.signal }).then(setCounts).catch(() => setCounts(null));
    return () => controller.abort();
  }, []);

  if (!counts?.available) return null;
  const byStatus = counts[board];
  const total = Object.values(byStatus).reduce((sum, value) => sum + value, 0);
  const fresh = byStatus.new ?? 0;
  const noun = board === "feedback" ? (total === 1 ? "feedback report" : "feedback reports") : (total === 1 ? "park proposal" : "park proposals");
  const name = counts.environment === "staging" ? "Staging" : "Production";
  return (
    <div className={`other-db other-db--${counts.environment}`} role="status">
      <Icon name="layers" size={16} />
      <span><strong>{name}</strong> has {total} {noun}{fresh ? `, ${fresh} new` : ""}.</span>
      <button type="button" className="text-button" onClick={() => onSwitch(counts.environment)}>Switch to {name.toLowerCase()}</button>
    </div>
  );
}
