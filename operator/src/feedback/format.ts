import type { FeedbackReport } from "./types";

/** Archived reports are deleted this long after "Clear done" (worker/feedbackArchive.ts). */
export const ARCHIVE_RETENTION_DAYS = 90;

/**
 * The app version and build in a few words. Over-the-air bundles report their version as
 * "<native build> bundle <bundle version>" (docs/ota-updates.md), so show that as a bundle.
 */
export function appBuildLabel(context: FeedbackReport["context"]): string | null {
  const version = context.version?.trim() ?? "";
  const build = context.build?.trim() ?? "";
  const bundle = /^(\d+) bundle ([A-Za-z0-9._-]+)$/.exec(version);
  if (bundle) return `Build ${bundle[1]} · bundle ${bundle[2].slice(0, 7)}`;
  const parts = [version ? (/^\d/.test(version) ? `v${version}` : version) : "", build && build !== version ? `build ${build}` : ""].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}

export function deletesOn(archivedAt: string): string {
  return new Date(Date.parse(archivedAt) + ARCHIVE_RETENTION_DAYS * 86_400_000).toISOString();
}

export function shortDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Unknown"
    : new Intl.DateTimeFormat(undefined, {
        month: "short",
        day: "numeric",
        year: date.getFullYear() === new Date().getFullYear() ? undefined : "numeric",
      }).format(date);
}
