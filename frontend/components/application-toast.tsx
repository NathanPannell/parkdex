"use client";

import { useEffect, useSyncExternalStore } from "react";
import { X } from "lucide-react";
import { dismissNotification, getServerSnapshot, getSnapshot, subscribe } from "@/lib/application-notifications";
import styles from "./application-toast.module.css";

const DISMISS_AFTER_MS = 5_000;

export function ApplicationToast() {
  const { active } = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  useEffect(() => {
    if (!active) return;
    const timeout = window.setTimeout(() => dismissNotification(active.id), DISMISS_AFTER_MS);
    return () => window.clearTimeout(timeout);
  }, [active, active?.id]);

  if (!active) return null;
  const isError = active.kind === "error";

  return <div className={styles.toast} data-kind={active.kind} role={isError ? "alert" : "status"} aria-live={isError ? "assertive" : "polite"} aria-atomic="true" onKeyDown={(event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      dismissNotification(active.id);
    }
  }}>
    <span className={styles.message}>{active.message}</span>
    <button className={styles.dismiss} type="button" aria-label="Dismiss notification" onClick={() => dismissNotification(active.id)}><X size={18} /></button>
  </div>;
}
