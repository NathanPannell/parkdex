# Independent fixture review

Reviewed at `http://localhost:3127` in an isolated synthetic-account fixture. The review recorded no page or HTTP errors.

| Issue | Reviewed result | Evidence |
| --- | --- | --- |
| #40 | Desktop navigation/search checks passed; the 390px dock fills the bar with five equal authenticated targets. | `independent-mobile-strathcona-final.png` |
| #41 | Collapsing search retains its filter; the final lake result clears the fixed utility. | `independent-fixture-review-report.json` |
| #42 | Account catalogue-photo and missing-photo fallback states passed. | `independent-mobile-account-fallback.png` |
| #43 | Compact mobile detail framing passed for Strathcona and Wrigglesworth within the usable map area. | `independent-mobile-strathcona-final.png`, `independent-mobile-wrigglesworth-final.png` |
| #44 | Synthetic groups persisted after reload; rename, map add, styled delete cancel/confirm, accessible map action, and suppressed inline credits passed. | `independent-fixture-review-report.json`, `independent-mobile-group-detail.png` |
| #45 | Re-invoking the active Map tab closed detail and restored overview state. | `independent-fixture-review-report.json` |
| #46 | Nearby showed only unvisited fixtures and its close control worked. | `independent-fixture-review-report.json`, `independent-mobile-nearby.png` |
| #47 | Guest collection search/filter/reset review passed; account-only collection checks used the isolated fixture. | `independent-fixture-review-report.json` |

The fixture stores account and group state only in memory and does not use staging credentials or shared user data.
