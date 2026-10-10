import { useEffect, useState } from "react";
import { api } from "../api";

/** The pending founding review count for the sidebar badge and the Parks tabs. */

const EVENT = "operator:reviews-changed";
const REFRESH_MS = 60_000;

/** Call after a decision so every badge refreshes at once. */
export function notifyReviewsChanged(): void {
  window.dispatchEvent(new Event(EVENT));
}

export function useReviewCount(): number {
  const [pending, setPending] = useState(0);
  useEffect(() => {
    let alive = true;
    const load = () => {
      api<{ available: boolean; pending: number }>("/api/parks/review/count")
        .then((result) => { if (alive) setPending(result.available ? result.pending : 0); })
        // A badge is not worth an error; the Review page says what went wrong.
        .catch(() => undefined);
    };
    load();
    const timer = window.setInterval(load, REFRESH_MS);
    window.addEventListener(EVENT, load);
    return () => {
      alive = false;
      window.clearInterval(timer);
      window.removeEventListener(EVENT, load);
    };
  }, []);
  return pending;
}
