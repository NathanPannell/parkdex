import { App } from "@capacitor/app";
import { Capacitor } from "@capacitor/core";

/**
 * Links into the app by path prefix, such as `https://<web host>/friend/CODE` (#64) and
 * `/crew/CODE` (#170). On Android these arrive as App Links (`AndroidManifest.xml` lists each
 * prefix); on the web the page itself opens at that path (`vercel.json` serves the app there).
 * Each route gets the single path segment after its prefix.
 */

export type AppLink = { prefix: string; value: string; url: URL };
export type AppLinkRoutes = Record<string, (value: string, url: URL) => void>;

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
// The same link fired twice in quick succession (launch URL and open event) is one tap.
const REPEAT_WINDOW_MS = 2000;

/** Parkdex web hosts, their Vercel previews, and loopback for local development. */
export function isParkdexLinkHost(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  if (url.protocol === "http:") return LOOPBACK.has(host);
  if (url.protocol !== "https:") return false;
  return host === "parkdex.app" || host.endsWith(".parkdex.app") || /^parkdex-kip(?:-[a-z0-9-]+)?\.vercel\.app$/.test(host) || LOOPBACK.has(host);
}

/** The route a URL belongs to and the path segment after its prefix, or null for any other URL. */
export function parseAppLink(raw: string, prefixes: readonly string[]): AppLink | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (!isParkdexLinkHost(url) || url.username || url.password) return null;
  for (const prefix of prefixes) {
    if (!url.pathname.startsWith(prefix)) continue;
    const rest = url.pathname.slice(prefix.length).replace(/\/$/, "");
    if (!rest || rest.includes("/") || rest.length > 96) return null;
    try {
      return { prefix, value: decodeURIComponent(rest), url };
    } catch {
      return null;
    }
  }
  return null;
}

let launchUrlHandled = false;
let lastLink: { href: string; at: number } | null = null;

function isRepeat(href: string, now: number): boolean {
  const repeat = lastLink !== null && lastLink.href === href && now - lastLink.at < REPEAT_WINDOW_MS;
  lastLink = { href, at: now };
  return repeat;
}

/**
 * Sends matching links to their routes: the link that opened the app (once per app process),
 * links opened while it runs, and on the web the page's own address, which is then replaced
 * with `/` so a reload does not repeat it. Returns a function that stops listening.
 */
export function listenForAppLinks(routes: AppLinkRoutes): () => void {
  const prefixes = Object.keys(routes);
  let live = true;
  const forward = (raw: string | undefined) => {
    if (!live || !raw) return;
    const link = parseAppLink(raw, prefixes);
    if (!link || isRepeat(link.url.href, Date.now())) return;
    routes[link.prefix]?.(link.value, link.url);
  };

  if (!Capacitor.isNativePlatform()) {
    if (typeof window !== "undefined" && parseAppLink(window.location.href, prefixes)) {
      const href = window.location.href;
      history.replaceState(history.state, "", "/");
      forward(href);
    }
    return () => {
      live = false;
    };
  }

  let remove: (() => void) | undefined;
  void App.addListener("appUrlOpen", ({ url }) => forward(url))
    .then((listener) => {
      if (live) remove = () => void listener.remove();
      else void listener.remove();
    })
    .catch(() => undefined);
  if (!launchUrlHandled) {
    void App.getLaunchUrl()
      .then((launch) => {
        if (!live || launchUrlHandled || !launch?.url || !parseAppLink(launch.url, prefixes)) return;
        launchUrlHandled = true;
        forward(launch.url);
      })
      .catch(() => undefined);
  }
  return () => {
    live = false;
    remove?.();
  };
}

/** Test hook: forget the launch URL and repeat guard between tests. */
export function resetAppLinksForTests(): void {
  launchUrlHandled = false;
  lastLink = null;
}
