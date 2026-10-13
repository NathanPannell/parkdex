// Parkdex web service worker. It is here only so Chrome offers to install Parkdex.
// It caches nothing: app files and park content have their own update paths
// (docs/ota-updates.md and the content store), and the API must always reach the network.
// Native builds never register it.

const OFFLINE_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#FFF8EC"><title>Parkdex</title></head>
<body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#FFF8EC;color:#14231C;font-family:system-ui,sans-serif;text-align:center;padding:24px;box-sizing:border-box">
<div><h1 style="margin:0 0 8px">You're offline</h1><p style="margin:0 0 20px">Parkdex on the web needs a connection to open.</p>
<button onclick="location.reload()" style="font:inherit;font-weight:800;padding:12px 22px;border-radius:16px;border:2px solid #14231C;background:#FF5A1F;color:#FFF8EC">Try again</button></div>
</body></html>`;

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

// Only page loads of the app itself pass through here, straight to the network. API calls,
// sign-in callbacks, the account pages and every other request never reach this handler.
self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.mode !== "navigate") return;
  const path = new URL(request.url).pathname;
  if (path.startsWith("/api/") || path === "/account" || path.startsWith("/account/")) return;
  event.respondWith(
    fetch(request).catch(() => new Response(OFFLINE_PAGE, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } })),
  );
});
