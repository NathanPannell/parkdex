import { Capacitor } from "@capacitor/core";
import { accountApiUrl } from "../accounts/authClient";
import { FRIEND_CODE_LENGTH, normalizeSocialCode } from "../social/codes";
import { parseAppLink } from "../social/links";

/** Friend links are `https://<web host>/friend/CODE`, on the same host as account links. */
export const FRIEND_LINK_PREFIX = "/friend/";

/** The friend code in a scanned QR or typed text: a friend link or a bare code. Null for anything else. */
export function friendCodeFromText(input: string): string | null {
  const value = input.trim();
  const link = parseAppLink(value, [FRIEND_LINK_PREFIX]);
  return normalizeSocialCode(link ? link.value : value, FRIEND_CODE_LENGTH);
}

/** The web host links point at: this page's own host, or in the Android app its account API host, which the App Link filter names. */
export function friendLinkOrigin(): string {
  if (!Capacitor.isNativePlatform() && typeof location !== "undefined") return location.origin;
  return new URL(accountApiUrl("/")).origin;
}

export function friendLink(code: string, origin = friendLinkOrigin()): string {
  return `${origin}${FRIEND_LINK_PREFIX}${code}`;
}
