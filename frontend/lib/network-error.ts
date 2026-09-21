/** Translate browser transport errors without hiding useful API validation messages. */
export function networkErrorMessage(error: unknown, action: string): string {
  if (typeof navigator !== "undefined" && navigator.onLine === false) return `You are offline. Reconnect to ${action}.`;
  if (error instanceof TypeError) return "Could not reach Parkdex. Check your connection and try again.";
  return error instanceof Error ? error.message : `Could not ${action}. Please try again.`;
}
