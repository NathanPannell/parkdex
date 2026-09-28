import { useEffect, useState } from "react";
import { Badge, type BadgeState } from "./Badge";
import type { Park } from "../lib/parks";
import type { Claim } from "../lib/store";
import { useContent, useContentRuntime, useContentStatus } from "../lib/content/provider";

type Props = {
  park: Park;
  claim: Claim;
  size?: number;
  state?: BadgeState;
  animated?: boolean;
  showName?: boolean;
};

/** Restores the exact scene release attached to an earned retired park snapshot. */
export function useEarnedSceneHref(park: Park, claim: Claim) {
  const content = useContent();
  const runtime = useContentRuntime();
  const status = useContentStatus();
  const [online, setOnline] = useState(() => typeof navigator === "undefined" || navigator.onLine);
  const isLive = !!content?.liveParks.some((candidate) => candidate.id === park.id);
  const sceneKey = `${claim.claimId}:${claim.contentReleaseId ?? ""}:${park.scene ?? ""}`;
  const [archivedScene, setArchivedScene] = useState<{ key: string; url: string } | null>(null);
  const sceneHref = !isLive && archivedScene?.key === sceneKey ? archivedScene.url : undefined;

  useEffect(() => {
    const updateOnline = () => setOnline(typeof navigator === "undefined" || navigator.onLine);
    window.addEventListener("online", updateOnline);
    window.addEventListener("offline", updateOnline);
    return () => {
      window.removeEventListener("online", updateOnline);
      window.removeEventListener("offline", updateOnline);
    };
  }, []);

  useEffect(() => {
    let live = true;
    if (isLive || !park.scene || !claim.contentReleaseId) {
      setArchivedScene(null);
      return () => { live = false; };
    }
    setArchivedScene((current) => current?.key === sceneKey ? current : null);
    // This lookup first checks the durable local archive, so reconnect retries also
    // render from cache while offline. Status and network changes retry a pending miss.
    void runtime.ensureArchivedScene(claim.contentReleaseId, park.scene)
      .then((url) => { if (live) setArchivedScene({ key: sceneKey, url }); })
      .catch(() => {});
    return () => { live = false; };
  }, [claim.contentReleaseId, isLive, online, park.id, park.scene, runtime, sceneKey, status.phase]);

  return sceneHref;
}

export function EarnedBadge({ park, claim, ...badgeProps }: Props) {
  const sceneHref = useEarnedSceneHref(park, claim);
  const content = useContent();
  const status = useContentStatus();
  const isRetiredScene = park.scene !== null && !content?.liveParks.some((candidate) => candidate.id === park.id);
  if (isRetiredScene && !sceneHref) {
    const size = badgeProps.size ?? 120;
    const message = !claim.contentReleaseId
      ? "Art unavailable"
      : status.waitingForWifi || (typeof navigator !== "undefined" && !navigator.onLine)
        ? "Connect to restore art"
        : "Restoring badge art";
    return <div className="earned-badge__restoring" style={{ width: size, height: size }} role="img" aria-label={`${park.short} badge. ${message}.`}><span>{message}</span></div>;
  }
  return <Badge park={park} sceneHref={sceneHref} {...badgeProps} />;
}
