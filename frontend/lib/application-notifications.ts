export type ApplicationNotification = {
  id: number;
  kind: "error" | "info";
  message: string;
};

export type ApplicationNotificationSnapshot = {
  active: ApplicationNotification | null;
  queued: readonly ApplicationNotification[];
};

const DEFAULT_ERROR_MESSAGE = "Something went wrong. Please try again.";
const listeners = new Set<() => void>();
let nextNotificationId = 1;
let snapshot: ApplicationNotificationSnapshot = { active: null, queued: [] };

/** Returns the same object until the notification state changes. */
export function getSnapshot(): ApplicationNotificationSnapshot {
  return snapshot;
}

export function getServerSnapshot(): ApplicationNotificationSnapshot {
  return EMPTY_SNAPSHOT;
}

const EMPTY_SNAPSHOT: ApplicationNotificationSnapshot = { active: null, queued: [] };

export function subscribe(onStoreChange: () => void) {
  listeners.add(onStoreChange);
  return () => listeners.delete(onStoreChange);
}

function publish(next: ApplicationNotificationSnapshot) {
  snapshot = next;
  listeners.forEach((listener) => listener());
}

function enqueue(kind: ApplicationNotification["kind"], message: string) {
  const notification: ApplicationNotification = { id: nextNotificationId++, kind, message };
  if (snapshot.active) {
    publish({ active: snapshot.active, queued: [...snapshot.queued, notification] });
    return;
  }
  publish({ active: notification, queued: snapshot.queued });
}

/** Shows user-facing error copy without exposing arbitrary object serialization. */
export function notifyError(error: unknown, fallback?: string) {
  const safeFallback = fallback?.trim() || DEFAULT_ERROR_MESSAGE;
  const message = fallback !== undefined
    ? safeFallback
    : typeof error === "string"
      ? error.trim()
      : error instanceof Error && !(error instanceof TypeError)
        ? error.message.trim()
        : "";
  enqueue("error", message || safeFallback);
}

export function notifyInfo(message: string) {
  const trimmed = message.trim();
  if (trimmed) enqueue("info", trimmed);
}

/** Dismiss only the notification whose timer or button initiated this call. */
export function dismissNotification(id?: number) {
  const active = snapshot.active;
  if (!active || (id !== undefined && active.id !== id)) return;
  const [next = null, ...queued] = snapshot.queued;
  publish({ active: next, queued });
}
