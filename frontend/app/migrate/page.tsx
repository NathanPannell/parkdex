"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { resolveApiBaseUrl } from "@/lib/api-base-url";

import {
  GUEST_MIGRATION_READY_TYPE,
  GUEST_MIGRATION_RESULT_TYPE,
  fetchRemoteGuestProgress,
  guestMigrationPairForAppOrigin,
  receiveGuestMigrationMessage,
  type GuestMigrationStatus,
} from "@/lib/guest-migration";

type PageStatus = GuestMigrationStatus | "connecting" | "unavailable";

const RESULT_STATUSES = new Set<GuestMigrationStatus>([
  "imported",
  "conflict",
  "invalid",
  "oversized",
  "storage-error",
]);

function isResultStatus(value: unknown): value is GuestMigrationStatus {
  return typeof value === "string" && RESULT_STATUSES.has(value as GuestMigrationStatus);
}

export default function GuestProgressMigrationPage() {
  const [status, setStatus] = useState<PageStatus>("connecting");

  useEffect(() => {
    const opener = window.opener;
    const pair = guestMigrationPairForAppOrigin(window.location.origin);
    if (!opener || !pair) {
      const unavailableTimer = window.setTimeout(() => setStatus("unavailable"), 0);
      return () => window.clearTimeout(unavailableTimer);
    }

    let handled = false;
    let processing = false;
    let navigationTimer: number | undefined;
    const onMessage = (event: MessageEvent<unknown>) => {
      if (handled || processing || event.origin !== pair.sourceOrigin || event.source !== opener) return;
      processing = true;
      void (async () => {
        let result;
        try {
          result = await receiveGuestMigrationMessage({
            origin: event.origin,
            source: event.source,
            expectedOrigin: pair.sourceOrigin,
            expectedSource: opener,
            payload: event.data,
            storage: window.localStorage,
            checkRemoteProgress: (collectionKey) => fetchRemoteGuestProgress(
              resolveApiBaseUrl(process.env.NEXT_PUBLIC_API_BASE_URL ?? "", window.location.origin),
              window.location.origin,
              collectionKey,
            ),
          });
        } catch {
          result = { status: "storage-error" as const };
        }
        if (result.status === "ignored") {
          processing = false;
          return;
        }

        handled = true;
        window.removeEventListener("message", onMessage);
        const resultStatus = isResultStatus(result.status) ? result.status : "invalid";
        opener.postMessage({
          type: GUEST_MIGRATION_RESULT_TYPE,
          version: 1,
          status: resultStatus,
        }, pair.sourceOrigin);
        setStatus(resultStatus);

        if (resultStatus === "imported") {
          navigationTimer = window.setTimeout(() => window.location.replace("/"), 500);
        }
      })();
    };

    window.addEventListener("message", onMessage);
    opener.postMessage({ type: GUEST_MIGRATION_READY_TYPE, version: 1 }, pair.sourceOrigin);

    return () => {
      window.removeEventListener("message", onMessage);
      if (navigationTimer !== undefined) window.clearTimeout(navigationTimer);
    };
  }, []);

  return (
    <main style={{
      maxWidth: 640,
      margin: "10vh auto 24px",
      padding: "28px 24px",
      borderRadius: 16,
      background: "var(--paper-bright)",
      color: "var(--forest)",
      boxShadow: "var(--soft-shadow)",
      fontFamily: "var(--font-body)",
      lineHeight: 1.5,
    }}>
      <h1 style={{
        margin: "0 0 12px",
        color: "var(--forest)",
        font: "750 clamp(28px, 8vw, 38px)/1.05 var(--font-display)",
        letterSpacing: "-.02em",
      }}>Move your guest progress</h1>
      <div role="status" aria-live="polite" aria-atomic="true" style={{ color: "var(--forest-2)" }}>
        {status === "connecting" && <p style={{ margin: 0 }}>Connecting to the Parkdex page that started this transfer…</p>}
        {status === "unavailable" && <p style={{ margin: 0 }}>Start this transfer from the Parkdex landing page. Your saved progress has not been changed.</p>}
        {status === "imported" && <p style={{ margin: 0 }}>Your guest progress is saved here. Opening Parkdex…</p>}
        {status === "conflict" && (
          <p style={{ margin: 0 }}>This app already has guest progress, or its saved state could not be confirmed empty. The transfer stopped to protect it. Keep the original Parkdex page open while you decide which copy to use.</p>
        )}
        {status === "invalid" && <p style={{ margin: 0 }}>The transfer did not pass its safety checks. Your original progress is still on the Parkdex landing page.</p>}
        {status === "oversized" && <p style={{ margin: 0 }}>The saved progress is too large for this transfer. Your original progress remains on the Parkdex landing page.</p>}
        {status === "storage-error" && <p style={{ margin: 0 }}>This browser could not save and verify the transfer. Your original progress remains on the Parkdex landing page.</p>}
      </div>
      <p style={{ margin: "20px 0 0" }}>
        <Link href="/" style={{
          display: "inline-flex",
          minHeight: 44,
          alignItems: "center",
          padding: "0 16px",
          borderRadius: 11,
          background: "var(--forest)",
          color: "var(--paper-bright)",
          fontWeight: 850,
          textDecoration: "none",
        }}>Open Parkdex</Link>
      </p>
    </main>
  );
}
