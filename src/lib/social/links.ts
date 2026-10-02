import { App } from "@capacitor/app";
import { Capacitor } from "@capacitor/core";
import { parseFriendLink, type FriendLink } from "./client";

/**
 * A friend QR is an https link to /friend/CODE on this build's App Link host. Scanned with the
 * phone's own camera it opens Parkdex (or, without the app, the web app) on that path.
 */
export async function listenForFriendLinks(handler: (friend: FriendLink) => void): Promise<() => void> {
  if (!Capacitor.isNativePlatform()) {
    // Parse the path alone: local dev pages are plain http.
    const friend = /^\/friend\//.test(location.pathname)
      ? parseFriendLink(new URL(location.pathname + location.search, "https://parkdex.invalid").href)
      : null;
    if (friend) {
      // Drop the code from the address bar so a reload doesn't add the friend again.
      history.replaceState(history.state, "", "/");
      handler(friend);
    }
    return () => {};
  }
  const seen = new Set<string>();
  const forward = (url: string | undefined) => {
    const friend = url ? parseFriendLink(url) : null;
    if (!friend || seen.has(url!)) return;
    seen.add(url!);
    handler(friend);
  };
  const listener = await App.addListener("appUrlOpen", ({ url }) => forward(url));
  forward((await App.getLaunchUrl())?.url);
  return () => { void listener.remove(); };
}
