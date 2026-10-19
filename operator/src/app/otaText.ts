import type { BundlePointer, Channel, ChannelState, OtaPublish } from "./types";

/** Plain-words helpers for the Updates page. No React, so the wording is easy to keep consistent. */

export const CHANNEL_NAME: Record<Channel, string> = { staging: "Staging", production: "Production" };

export const STATE_LABEL: Record<ChannelState, string> = {
  live: "Live",
  none: "No bundle yet",
  not_served: "CDN not serving",
  invalid: "Invalid pointer",
  unavailable: "Unreachable",
};

export const ACTION_LABEL: Record<OtaPublish["action"], string> = {
  publish: "Published",
  rollback: "Rolled back",
  promote: "Promoted",
  repoint: "Repointed",
};

export const OUTCOME_LABEL: Record<OtaPublish["outcome"], string> = {
  confirmed: "Confirmed",
  cdn_pending: "CDN pending",
  conflict: "Conflict",
};

export function shortSha(sha: string | null | undefined, length = 10): string {
  return sha ? sha.slice(0, length) : "—";
}

export function megabytes(bytes: number | null | undefined): string {
  if (typeof bytes !== "number" || !Number.isFinite(bytes)) return "—";
  return bytes >= 1_000_000 ? `${(bytes / 1_000_000).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1000))} kB`;
}

export function buildRange(minimum: number, maximum: number): string {
  return minimum === maximum ? `build ${minimum}` : `builds ${minimum} to ${maximum}`;
}

export type BuildEffect = { tone: "update" | "keep" | "stop"; text: string };

/** What installed builds do with a pointer, following worker/appUpdates.ts and src/lib/ota.ts. */
export function buildEffects(pointer: BundlePointer | null): BuildEffect[] {
  if (!pointer) return [{ tone: "keep", text: "Every build keeps the code it shipped with. The endpoint answers no_bundle_published." }];
  const effects: BuildEffect[] = [];
  if (pointer.minimumNativeBuild > 1)
    effects.push({
      tone: "keep",
      text: `Builds below ${pointer.minimumNativeBuild} keep what they run now: they lack native code this bundle calls (native_build_out_of_range).`,
    });
  effects.push({
    tone: "update",
    text: `${capitalize(buildRange(pointer.minimumNativeBuild, pointer.maximumNativeBuild))} download ${pointer.version} on their next update check and switch at the next cold start, or after 30 minutes in the background.`,
  });
  effects.push({
    tone: "keep",
    text: `Builds above ${pointer.maximumNativeBuild} keep their newer built-in code; raise the maximum once a build is checked with this bundle.`,
  });
  effects.push({ tone: "keep", text: `A device that already rolled back from ${pointer.version} never switches to it again.` });
  return effects;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The lines of the confirmation popup: what changes, for which builds. */
export function moveSummary(current: BundlePointer | null, next: { version: string; minimumNativeBuild: number; maximumNativeBuild: number }): string[] {
  const lines = [
    `${capitalize(buildRange(next.minimumNativeBuild, next.maximumNativeBuild))} download ${next.version} on their next update check and switch at the next cold start.`,
  ];
  if (current) {
    if (current.version === next.version) lines[0] = `Devices already on ${next.version} stay on it; only the native build range changes.`;
    const dropped: string[] = [];
    if (current.minimumNativeBuild < next.minimumNativeBuild)
      dropped.push(buildRange(current.minimumNativeBuild, Math.min(current.maximumNativeBuild, next.minimumNativeBuild - 1)));
    if (current.maximumNativeBuild > next.maximumNativeBuild)
      dropped.push(buildRange(Math.max(current.minimumNativeBuild, next.maximumNativeBuild + 1), current.maximumNativeBuild));
    if (dropped.length) lines.push(`${capitalize(dropped.join(" and "))} stop getting updates from this channel and keep the bundle they already have.`);
  }
  lines.push("Builds outside the range keep what they run now. Nothing is downloaded until each device checks in.");
  return lines;
}

export function nextApplyCommand(channel: Channel, generation: number, etag: string | null, minimumNativeBuild: number | null): string {
  const build = minimumNativeBuild ?? "<build>";
  const base = `node scripts/publish-app-bundle.mjs --channel ${channel} --min-native-build ${build} --apply --expected-generation ${generation}`;
  return generation === 0 || !etag ? `${base} --record` : `${base} --expected-etag '${etag}' --record`;
}
