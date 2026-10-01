export type ContentChannel = "staging" | "main";

let override: ContentChannel | null = null;

/** Set once at startup, before content loads, from the build's remote configuration. */
export function setContentChannelOverride(channel: ContentChannel | null): void {
  override = channel;
}

/** A remote switch to a content database other than the one this build was made for. */
export function contentChannelOverride(): ContentChannel | null {
  return override;
}
