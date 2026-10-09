import { useEffect, useState } from "react";
import { api } from "../api";
import { Icon } from "../ui";

type Counts = { available: false } | { available: true; environment: string; feedback: Record<string, number> };

/** Tells the operator what feedback is waiting in the database they are not looking at. */
export function OtherDatabaseNote({ onSwitch }: { onSwitch(target: string): void }) {
  const [counts, setCounts] = useState<Counts | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    api<Counts>("/api/feedback/other-database", { signal: controller.signal }).then(setCounts).catch(() => setCounts(null));
    return () => controller.abort();
  }, []);

  if (!counts?.available) return null;
  const total = Object.values(counts.feedback).reduce((sum, value) => sum + value, 0);
  const fresh = counts.feedback.new ?? 0;
  const name = counts.environment === "staging" ? "Staging" : "Production";
  return (
    <div className={`other-db other-db--${counts.environment}`} role="status">
      <Icon name="layers" size={16} />
      <span><strong>{name}</strong> has {total} {total === 1 ? "feedback report" : "feedback reports"}{fresh ? `, ${fresh} new` : ""}.</span>
      <button type="button" className="text-button" onClick={() => onSwitch(counts.environment)}>Switch to {name.toLowerCase()}</button>
    </div>
  );
}
