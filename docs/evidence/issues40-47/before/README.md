# Issues 40–47 before-state browser evidence

Captured 2026-09-11 in fresh, non-persistent Chromium guest contexts at 1440×900 and 390×844. Production returned HTTP 200 with ETag `W/"7880e6841e87aa865702fd53a28d5ede"` at capture time. The UI exposes no application commit or version, so the ETag identifies the response baseline without asserting a source revision.

| Issue | Production before state | Coverage |
| --- | --- | --- |
| #40 navigation | `production-{desktop,mobile}-home.png`, `production-{desktop,mobile}-places.png` | Map navigation and Find places state at both sizes |
| #41 search Enter | `production-{desktop,mobile}-search-goldstream.png` | Goldstream query entered in the visible search field; keyboard-submit behavior remains represented by the issue-authored evidence |
| #42 account-summary photos | Issue-authored evidence only | Guest account has no visited account summary; no account was created or used |
| #43 mobile boundary fit | `production-mobile-selected-goldstream.png` | Goldstream boundary and open mobile detail sheet |
| #44 groups | Issue-authored evidence only | Groups is unavailable to the synthetic guest |
| #45 reset map | `production-mobile-map-shifted-no-selection.png` | Map panned away from the island overview with no selected place |
| #46 Near you | `production-{desktop,mobile}-nearby-victoria-simulated.png` | Browser location fixed to synthetic Victoria coordinates `48.4284, -123.3656` |
| #47 Places collections | Issue-authored evidence only | The authenticated Places collection was unavailable to the synthetic guest; `production-{desktop,mobile}-places.png` shows the public Find places surface only as supplementary context |

The production set contains 11 reviewed screenshots: five desktop and six mobile. `staging-{desktop,mobile}-home.png` records that direct anonymous staging access redirected to Vercel login; no protection bypass or login was attempted, so no staging app-state screenshots or staging revision claim are included.

`capture-report.json` records URLs, viewport dimensions, response metadata, captured filenames, unavailable guest states, and browser console/page errors. `capture-baselines.cjs` is the reproducible isolated-browser capture harness.
