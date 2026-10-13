import type { CSSProperties } from "react";

/** Handles longer than this take their own line on the Your parks score card, above the score. */
export const SCORE_CARD_HANDLE_CHARS = 8;

/**
 * Hands a handle's length, with its @, to CSS as `--handle-chars`. An @handle never wraps: the
 * styles that read it shrink a long one to fit its line, and cut it with an ellipsis only when
 * even the smallest size does not fit.
 */
export function handleFit(handle: string | null | undefined): CSSProperties | undefined {
  return handle ? ({ "--handle-chars": handle.length + 1 } as CSSProperties) : undefined;
}

/** Whether the score card moves this handle onto its own line. */
export function hasLongHandle(handle: string): boolean {
  return handle.length > SCORE_CARD_HANDLE_CHARS;
}
