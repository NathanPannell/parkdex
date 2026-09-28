import { useEffect, useState, useSyncExternalStore } from "react";
import { Badge, type BadgeState } from "./Badge";
import { scenePath, type Park } from "../lib/parks";
import type { Claim } from "../lib/store";
import { useContent, useContentRuntime, useContentStatus } from "../lib/content/provider";
import { subscribeContentConnectivity } from "../lib/content/transport";

let wifiAvailableSnapshot = false;
let stopWifiSubscription: (() => void) | null = null;
const wifiSubscribers = new Set<() => void>();

function subscribeToWifiAvailability(listener: () => void) {
  wifiSubscribers.add(listener);
  if (!stopWifiSubscription) {
    stopWifiSubscription = subscribeContentConnectivity((connectivity) => {
      const next = connectivity.connected && connectivity.wifi;
      if (next === wifiAvailableSnapshot) return;
      wifiAvailableSnapshot = next;
      for (const subscriber of wifiSubscribers) subscriber();
    });
  }
  return () => {
    wifiSubscribers.delete(listener);
    if (!wifiSubscribers.size) {
      stopWifiSubscription?.();
      stopWifiSubscription = null;
      wifiAvailableSnapshot = false;
    }
  };
}

function getWifiAvailability() {
  return wifiAvailableSnapshot;
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
  const wifiAvailable = useSyncExternalStore(subscribeToWifiAvailability, getWifiAvailability, getWifiAvailability);
  const activePark = content?.liveParks.find((candidate) => candidate.id === earnedPark.id);
  const activeSceneVersion = runtime.getSceneAssetVersion(earnedPark.id, earnedPark.scene);
  const matchesActiveArt = !!earnedPark.scene && !!claim.contentReleaseId &&
    activePark?.scene === earnedPark.scene && activeSceneVersion === claim.contentReleaseId;
  const sceneKey = `${claim.claimId}:${claim.contentReleaseId ?? ""}:${earnedPark.scene ?? ""}`;
  const [archivedScene, setArchivedScene] = useState<{ key: string; url: string } | null>(null);
  const activeSceneHref = matchesActiveArt && earnedPark.scene
    ? content?.assetUrls.get(scenePath(earnedPark.scene))
    : undefined;
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
  }, [activeSceneHref, archivedScene, claim.contentReleaseId, earnedPark.id, earnedPark.scene, runtime, sceneKey, status.phase, wifiAvailable]);

  return { sceneHref, wifiAvailable, matchesActiveArt };
}

export function useEarnedSceneAsset(park: Park, claim: Claim) {
  return useEarnedScene(park, claim);
}

export function useEarnedSceneHref(park: Park, claim: Claim) {
  return useEarnedSceneAsset(park, claim).sceneHref;
}

export function EarnedBadge({ park, claim, ...badgeProps }: Props) {
  const earnedPark = claim.parkSnapshot ?? park;
  const { sceneHref, wifiAvailable, matchesActiveArt } = useEarnedSceneAsset(earnedPark, claim);
  const needsExactScene = earnedPark.scene !== null && (!matchesActiveArt || !sceneHref);
  if (needsExactScene && !sceneHref) {
    const size = badgeProps.size ?? 120;
    const message = !claim.contentReleaseId
      ? "Art unavailable"
      : !wifiAvailable
        ? "Connect to Wi-Fi to restore art"
        : "Restoring badge art";
    return <div className="earned-badge__restoring" style={{ width: size, height: size }} role="img" aria-label={`${earnedPark.short} badge. ${message}.`}><span>{message}</span></div>;
  }
  return <Badge park={earnedPark} sceneHref={sceneHref} {...badgeProps} />;
}
