import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "../accounts/AuthProvider";
import { listPersonalClaims, type ProgressOwner } from "../accounts/personalStore";
import { progressOwnerKey, useStore } from "../store";
import { fetchDex } from "./client";
import { mergeVisits, type DexVisit, type LocalDexClaim, type ServerDexPark } from "./collection";

export type DexStatus = "guest" | "loading" | "ready" | "offline";

// The last server answer per account, so reopening My Dex shows it at once while it refreshes.
const remembered = new Map<string, ServerDexPark[]>();

/** The progress owner the rest of the app reads claims for: the guest, or the signed-in account. */
export function useProgressOwner(): ProgressOwner | null {
  const auth = useAuth();
  return useMemo<ProgressOwner | null>(() => {
    if (auth.phase === "guest") return { kind: "guest" };
    if ((auth.phase === "authenticated" || auth.phase === "offline-account") && auth.ownerAccountId) return { kind: "account", accountId: auth.ownerAccountId };
    return null;
  }, [auth.phase, auth.ownerAccountId]);
}

/**
 * Everything My Dex shows: visits from the server and the claims saved on this device. Photos
 * players took before photos were retired stay on the device and in their backup, but the Dex
 * shows each park's official photo instead (collection.ts).
 */
export function useDex(active: boolean) {
  const auth = useAuth();
  const { state } = useStore();
  const owner = useProgressOwner();
  const ownerKey = progressOwnerKey(owner);
  const accountId = auth.phase === "authenticated" ? (auth.account?.id ?? null) : null;
  const [server, setServer] = useState<ServerDexPark[] | null>(() => (accountId ? (remembered.get(accountId) ?? null) : null));
  const [serverStatus, setServerStatus] = useState<"idle" | "loading" | "ready" | "offline">("idle");
  const [claims, setClaims] = useState<LocalDexClaim[]>([]);
  const [localReady, setLocalReady] = useState(false);
  const latestOwner = useRef(ownerKey);
  latestOwner.current = ownerKey;

  useEffect(() => {
    if (!owner || !ownerKey) return;
    let live = true;
    void listPersonalClaims(owner)
      .then((savedClaims) => {
        if (!live || latestOwner.current !== ownerKey) return;
        setClaims(savedClaims.map((claim) => ({ claimId: claim.claimId, parkId: claim.parkId, claimedAt: claim.claimedAt, parkSnapshot: claim.parkSnapshot })));
        setLocalReady(true);
      })
      .catch(() => {
        if (live) setLocalReady(true);
      });
    return () => {
      live = false;
    };
  }, [owner, ownerKey, auth.progressRevision, state.claimRevision]);

  const refreshServer = useCallback(async () => {
    if (!accountId) return;
    setServerStatus("loading");
    try {
      const parks = await fetchDex(accountId);
      remembered.set(accountId, parks);
      setServer(parks);
      setServerStatus("ready");
    } catch {
      setServerStatus("offline");
    }
  }, [accountId]);

  useEffect(() => {
    setServer(accountId ? (remembered.get(accountId) ?? null) : null);
    if (active && accountId) void refreshServer();
  }, [accountId, active, refreshServer, auth.progressRevision]);

  const visits = useMemo<Map<string, DexVisit>>(() => mergeVisits(server ?? [], claims), [server, claims]);

  const status: DexStatus = !accountId ? (localReady ? "guest" : "loading") : server ? "ready" : serverStatus === "offline" ? "offline" : "loading";

  return {
    status,
    signedIn: !!accountId || auth.phase === "offline-account",
    /** True while the server list is refreshing or could not be read; local visits still show. */
    serverStale: !!accountId && serverStatus === "offline",
    visits,
    refresh: refreshServer,
  };
}
