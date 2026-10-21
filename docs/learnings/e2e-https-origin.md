# The web build needs an HTTPS origin in e2e

Recorded: 2026-10-19. Applies to: `e2e/`, `playwright.config.ts`, content transport in `src/lib/content/transport.ts`.

## What went wrong

The first Playwright run against `vite preview` at `http://localhost:5190` showed "Park guides couldn't be loaded" and never requested content. The web build only reads content from a secure origin on the default port (`getContentApiOrigin`), so a plain local URL can never load parks. Routing `/api` with `page.route` also did nothing at first, because the app's service worker answered those fetches before Playwright saw them.

## Rule

Serve the app to the browser from `https://parkdex.e2e.test` and let `e2e/fixtures.ts` forward its requests to `vite preview` and the e2e API server. Keep `serviceWorkers: "block"` in `playwright.config.ts`. Do not loosen the HTTPS check in the app to make tests easier.

## How to check

`npm run build` then `npm run e2e` with the `PG*` variables set: the first journey sees "Parks near you" with real park names, which only appear when content loaded from the API.

## History

- 2026-10-19: created while moving the preview browser checks into CI.
