import { useEffect, useRef } from "react";

/**
 * Steps inside a screen that the Android back button (and Escape) should walk back through,
 * newest first. The app's back handler asks here before its own screen-level rules.
 */

type Handler = () => void;
const stack: Handler[] = [];

/** Adds a handler on top; the returned function removes it. */
export function pushBackHandler(handler: Handler): () => void {
  stack.push(handler);
  return () => {
    const index = stack.lastIndexOf(handler);
    if (index >= 0) stack.splice(index, 1);
  };
}

/** Runs the newest handler. False when nothing claimed the back press. */
export function handleBack(): boolean {
  const top = stack[stack.length - 1];
  if (!top) return false;
  top();
  return true;
}

/** Claims back presses while `active`, always calling the latest `handler`. */
export function useBackHandler(handler: Handler, active = true): void {
  const latest = useRef(handler);
  latest.current = handler;
  useEffect(() => (active ? pushBackHandler(() => latest.current()) : undefined), [active]);
}
