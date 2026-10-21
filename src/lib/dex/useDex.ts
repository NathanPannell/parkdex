import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "../accounts/AuthProvider";
import {
  createPersonalClaim,
  listPersonalClaims,
  listPersonalPhotos,
  removePersonalPhoto,
  setPersonalPhotoCover,
  setPersonalPhotoCrop,
  type ProgressOwner,
} from "../accounts/personalStore";
import { useContent } from "../content/provider";
import type { Park } from "../parks";
import type { PhotoCrop } from "../photoCrop";
import type { CapturedPhoto } from "../photoEncode";
import { progressOwnerKey, useStore } from "../store";
import { fetchDex } from "./client";
import { mergeVisits, type DexPhoto, type DexVisit, type LocalDexClaim, type ServerDexPark } from "./collection";

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
 * Saves a photo as its own claim (#174), with its crop, then refreshes the collection and starts
 * a backup. The claim keeps a frozen snapshot of the park, like every claim.
 */
export function useSaveDexPhoto() {
  const auth = useAuth();
  const { dispatch } = useStore();
  const content = useContent();
  const owner = useProgressOwner();
  return useCallback(
    async (park: Park, captured: CapturedPhoto) => {
      if (!owner) throw new Error("Your photos can't be saved right now. Try again in a moment.");
      const claim = await createPersonalClaim(owner, {
        park,
        photo: captured.original.blob,
        crop: captured.crop,
        contentReleaseId: content?.releaseId ?? null,
      });
      dispatch({
        type: "claim",
        ownerKey: progressOwnerKey(owner)!,
        id: park.id,
        claimId: claim.claimId,
        at: claim.claimedAt,
        photo: "",
        parkSnapshot: claim.parkSnapshot!,
        contentReleaseId: claim.contentReleaseId,
      });
      if (owner.kind === "account" && auth.phase === "authenticated") void auth.syncBackup({ retryAfterFlight: true });
      return claim;
    },
    [auth, content?.releaseId, dispatch, owner],
  );
}

/** Everything My Dex shows: visits from the server and this device, and this device's photos. */
export function useDex(active: boolean) {
  const auth = useAuth();
  const { state } = useStore();
  const owner = useProgressOwner();
  const ownerKey = progressOwnerKey(owner);
  const accountId = auth.phase === "authenticated" ? (auth.account?.id ?? null) : null;
  const [server, setServer] = useState<ServerDexPark[] | null>(() => (accountId ? (remembered.get(accountId) ?? null) : null));
  const [serverStatus, setServerStatus] = useState<"idle" | "loading" | "ready" | "offline">("idle");
  const [claims, setClaims] = useState<LocalDexClaim[]>([]);
  const [photos, setPhotos] = useState<DexPhoto[]>([]);
  const [localReady, setLocalReady] = useState(false);
  const [localRevision, setLocalRevision] = useState(0);
  const latestOwner = useRef(ownerKey);
  latestOwner.current = ownerKey;

  useEffect(() => {
    if (!owner || !ownerKey) return;
    let live = true;
    void Promise.all([listPersonalClaims(owner), listPersonalPhotos(owner)])
      .then(([savedClaims, savedPhotos]) => {
        if (!live || latestOwner.current !== ownerKey) return;
        const byClaim = new Map(savedClaims.map((claim) => [claim.claimId, claim]));
        setClaims(savedClaims.map((claim) => ({ claimId: claim.claimId, parkId: claim.parkId, claimedAt: claim.claimedAt, parkSnapshot: claim.parkSnapshot })));
        setPhotos(
          savedPhotos.flatMap((photo): DexPhoto[] => {
            const claim = byClaim.get(photo.claimId);
            if (!claim || !(photo.blob instanceof Blob)) return [];
            return [
              {
                claimId: photo.claimId,
                parkId: claim.parkId,
                claimedAt: claim.claimedAt,
                blob: photo.blob,
                crop: photo.crop ?? null,
                coverAt: photo.coverAt ?? null,
                removed: photo.removed === true,
              },
            ];
          }),
        );
        setLocalReady(true);
      })
      .catch(() => {
        if (live) setLocalReady(true);
      });
    return () => {
      live = false;
    };
  }, [owner, ownerKey, auth.progressRevision, state.claimRevision, localRevision]);

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

  const change = useCallback(
    async (work: (owner: ProgressOwner) => Promise<unknown>) => {
      if (!owner) return;
      await work(owner);
      setLocalRevision((value) => value + 1);
      if (owner.kind === "account" && auth.phase === "authenticated") void auth.syncBackup({ retryAfterFlight: true });
    },
    [auth, owner],
  );

  const status: DexStatus = !accountId ? (localReady ? "guest" : "loading") : server ? "ready" : serverStatus === "offline" ? "offline" : "loading";

  return {
    status,
    signedIn: !!accountId || auth.phase === "offline-account",
    /** True while the server list is refreshing or could not be read; local visits still show. */
    serverStale: !!accountId && serverStatus === "offline",
    visits,
    photos,
    refresh: refreshServer,
    setCover: (claimId: string) => change((current) => setPersonalPhotoCover(current, claimId)),
    recrop: (claimId: string, crop: PhotoCrop | null) => change((current) => setPersonalPhotoCrop(current, claimId, crop)),
    remove: (claimId: string) => change((current) => removePersonalPhoto(current, claimId)),
    reload: () => setLocalRevision((value) => value + 1),
  };
}
