export const NATIVE_BACK_EVENT = "parkdex:back";

const consumers: Array<() => void> = [];

function consumeNativeBack(event: Event) {
  const consumer = consumers.at(-1);
  if (!consumer) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  consumer();
}

/** Dispatch Android Back to React UI before the native runtime navigates or minimizes. */
export function dispatchNativeBack(): boolean {
  return window.dispatchEvent(new CustomEvent(NATIVE_BACK_EVENT, { cancelable: true }));
}

/**
 * Register a Back consumer while an overlay is open. The returned cleanup keeps
 * consumers scoped to the overlay lifecycle.
 */
export function addNativeBackConsumer(consumer: () => void): () => void {
  if (consumers.length === 0) window.addEventListener(NATIVE_BACK_EVENT, consumeNativeBack);
  consumers.push(consumer);
  return () => {
    const index = consumers.lastIndexOf(consumer);
    if (index >= 0) consumers.splice(index, 1);
    if (consumers.length === 0) window.removeEventListener(NATIVE_BACK_EVENT, consumeNativeBack);
  };
}

export function hasNativeBackHistory(_location: Pick<Location, "pathname" | "search" | "hash">): boolean {
  void _location;
  const depth = window.history.state?.parkdexRouteDepth;
  return typeof depth === "number" && Number.isInteger(depth) && depth > 0;
}
