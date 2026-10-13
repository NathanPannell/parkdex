import type { FriendWeek } from "./client";

const DAY_LABEL = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

/** "12 – 18 Oct" for the game week, from its YYYY-MM-DD bounds. */
export function weekLabel(week: Pick<FriendWeek, "start" | "end">): string {
  const start = new Date(`${week.start}T00:00:00Z`);
  const end = new Date(`${week.end}T00:00:00Z`);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) return "This week";
  const sameMonth = start.getUTCMonth() === end.getUTCMonth();
  const first = sameMonth ? String(start.getUTCDate()) : DAY_LABEL.format(start);
  return `${first} – ${DAY_LABEL.format(end)}`;
}

/** "5 min ago", "3 h ago" or "2 days ago", for an offline board. */
export function sinceLabel(at: string, now: number): string {
  const minutes = Math.max(0, Math.round((now - Date.parse(at)) / 60_000));
  if (!Number.isFinite(minutes)) return "earlier";
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return `${days} ${days === 1 ? "day" : "days"} ago`;
}
