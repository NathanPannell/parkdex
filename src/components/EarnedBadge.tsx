import { useEffect, useState, useSyncExternalStore } from "react";
import { Badge, type BadgeState } from "./Badge";
import { scenePath, type Park } from "../lib/parks";
import { resolveEarnedParkDisplay } from "../lib/earnedParkDisplay";
import type { Claim } from "../lib/store";
import { useContent, useContentRuntime, useContentStatus } from "../lib/content/provider";
import { canDownloadContent, isWaitingForContentWifi, type Connectivity } from "../lib/content/contracts";
import { subscribeContentConnectivity } from "../lib/content/transport";

let contentNetworkSnapshot: Connectivity = { connected: false, wifi: false, contentDownloadAllowed: false };
let stopContentNetworkSubscription: (() => void) | null = null;
const contentNetworkSubscribers = new Set<() => void>();

function subscribeToContentNetwork(listener: () => void) {
  contentNetworkSubscribers.add(listener);
  if (!stopContentNetworkSubscription) {
    stopContentNetworkSubscription = subscribeContentConnectivity((connectivity) => {
      if (
        connectivity.connected === contentNetworkSnapshot.connected &&
        connectivity.wifi === contentNetworkSnapshot.wifi &&
        connectivity.contentDownloadAllowed === contentNetworkSnapshot.contentDownloadAllowed
      ) return;
      contentNetworkSnapshot = { ...connectivity };
      for (const subscriber of contentNetworkSubscribers) subscriber();
    });
  }
  return () => {
    contentNetworkSubscribers.delete(listener);
    if (!contentNetworkSubscribers.size) {
      stopContentNetworkSubscription?.();
      stopContentNetworkSubscription = null;
      contentNetworkSnapshot = { connected: false, wifi: false, contentDownloadAllowed: false };
    }
  };
}

function getContentNetworkSnapshot() {
  return contentNetworkSnapshot;
}

type Props = {
  park: Park;
  claim: Claim;
  size?: number;
  state?: BadgeState;
  animated?: boolean;
  showName?: boolean;
};

/** Reuses active art only when its scene and immutable version match the frozen claim. */
function useEarnedScene(park: Park, claim: Claim) {
  const earnedPark = claim.parkSnapshot ?? park;
  const content = useContent();
  const runtime = useContentRuntime();
  const status = useContentStatus();
  const connectivity = useSyncExternalStore(subscribeToContentNetwork, getContentNetworkSnapshot, getContentNetworkSnapshot);
  const contentDownloadAvailable = canDownloadContent(connectivity);
  const waitingForWifi = isWaitingForContentWifi(connectivity);
  const activePark = content?.parkById.get(earnedPark.id);
  const currentSceneHref = activePark?.scene ? content?.assetUrls.get(scenePath(activePark.scene)) : undefined;
  const display = resolveEarnedParkDisplay(park, claim, activePark, !!currentSceneHref);
  const displayPark = display.park;
  const activeSceneVersion = runtime.getSceneAssetVersion(earnedPark.id, earnedPark.scene);
  const matchesArchivedReleaseArt = !!earnedPark.scene && !!claim.contentReleaseId &&
    activePark?.scene === earnedPark.scene && activeSceneVersion === claim.contentReleaseId;
  const sceneKey = `${claim.claimId}:${claim.contentReleaseId ?? ""}:${earnedPark.scene ?? ""}`;
  const [archivedScene, setArchivedScene] = useState<{ key: string; url: string } | null>(null);
  const activeSceneHref = display.usesCurrentArt && activePark?.scene
    ? currentSceneHref
    : matchesArchivedReleaseArt && earnedPark.scene
      ? content?.assetUrls.get(scenePath(earnedPark.scene))
      : undefined;
  const matchesActiveArt = display.usesCurrentArt ? !!activeSceneHref : matchesArchivedReleaseArt;
  const sceneHref = activeSceneHref ?? (archivedScene?.key === sceneKey ? archivedScene.url : undefined);

  useEffect(() => {
    let live = true;
    if (!earnedPark.scene || !claim.contentReleaseId) {
      setArchivedScene(null);
      return () => { live = false; };
    }
    if (activeSceneHref) {
      setArchivedScene(null);
      return () => { live = false; };
    }
    if (archivedScene?.key === sceneKey) return () => { live = false; };
    setArchivedScene((current) => current?.key === sceneKey ? current : null);
    // This lookup first checks the durable local archive, so reconnect retries also
    // render from cache while offline. Status and network changes retry a pending miss.
    void runtime.ensureArchivedScene(claim.contentReleaseId, earnedPark.scene)
      .then((url) => { if (live) setArchivedScene({ key: sceneKey, url }); })
      .catch(() => {});
    return () => { live = false; };
  }, [activeSceneHref, archivedScene, claim.contentReleaseId, earnedPark.id, earnedPark.scene, runtime, sceneKey, status.phase, contentDownloadAvailable]);

  return { displayPark, sceneHref, contentDownloadAvailable, waitingForWifi, matchesActiveArt, adoptedCurrentArt: display.usesCurrentArt };
}

export function useEarnedSceneAsset(park: Park, claim: Claim) {
  return useEarnedScene(park, claim);
}

export function useEarnedSceneHref(park: Park, claim: Claim) {
  return useEarnedSceneAsset(park, claim).sceneHref;
}

export function EarnedBadge({ park, claim, ...badgeProps }: Props) {
  const { displayPark, sceneHref, contentDownloadAvailable, waitingForWifi, matchesActiveArt, adoptedCurrentArt } = useEarnedSceneAsset(park, claim);
  const earnedPark = claim.parkSnapshot ?? park;
  const needsExactScene = displayPark.scene !== null && (!matchesActiveArt || !sceneHref);
  if (needsExactScene && !sceneHref) {
    const size = badgeProps.size ?? 120;
    const message = !claim.contentReleaseId && !adoptedCurrentArt
      ? "Art unavailable"
      : waitingForWifi
        ? "Connect to Wi-Fi to restore art"
        : !contentDownloadAvailable
          ? "Go online to restore art"
          : "Restoring badge art";
    return <div className="earned-badge__restoring" style={{ width: size, height: size }} role="img" aria-label={`${earnedPark.short} badge. ${message}.`}><span>{message}</span></div>;
  }
  return <Badge park={displayPark} sceneHref={sceneHref} {...badgeProps} />;
}
