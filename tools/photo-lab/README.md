# Photo check lab

A local tool for tuning the founder photo check (`worker/founderPhoto.ts`). It sends 100 labelled
photos through the same check the API runs, saves the model's raw probabilities, and shows them in a
dashboard where you can move every flag threshold and see the decisions change straight away.

The rule is the production one: a photo is approved when no flag's "yes" probability is above that
flag's threshold, and rejected otherwise, naming those flags. There is no overall verdict and no
unsure outcome. The defaults are production's `DEFAULT_FLAG_THRESHOLDS`: people 0.8, lighting 0.8,
not_park 0.95, inappropriate 0.9, not_photo 0.95 and personal_info 0.9.

## Quick start

```bash
npm ci                      # first time
npm run photo-lab:fetch     # download and prepare the 100 photos (Python 3 with Pillow)
npm run photo-lab:run       # classify them once (needs OPENROUTER_API_KEY, about $0.02)
npm run photo-lab           # dashboard on http://127.0.0.1:5199
```

`OPENROUTER_API_KEY` is read from the environment, or on Windows from the user environment, so a
shell opened before the key was set still works. It is only sent to OpenRouter. The model is
`OPENROUTER_MODERATION_MODEL` when set, otherwise the production default in `worker/moderation.ts`.

## Where things live

| What | Where |
| --- | --- |
| Labelled photo list, with source, author and licence | `tools/photo-lab/manifest.json` (committed) |
| Downloaded originals and the prepared upload JPEGs | `<data>/images/` (not committed) |
| Saved runs | `<data>/results/run-*.json` (not committed) |

`<data>` is `PHOTO_LAB_DIR` when set, otherwise `.codex/photo-lab` in the nearest folder above the
repository that has a `.codex` folder (the workspace), else `.codex/photo-lab` inside the repository,
which is ignored by Git.

## The same pipeline as production

- **Prepare** (`fetch.py`). Like `src/lib/photoEncode.ts`, each photo has its orientation applied, is
  fitted within 1,280 px and re-encoded as JPEG at quality 82, stepping down if it would pass 1.5 MB.
- **Check** (`lab.ts`). The JPEG goes through `stripJpegMetadata` from `worker/jpeg.ts`, then
  `createPhotoChecker` from `worker/founderPhoto.ts`. The questions (the six flags), the context
  line and the Decisions API call are the production ones. Every photo uses the same park context, Beacon Hill
  Park (leisure=park).
- **Decide** (`evaluate.ts`). The dashboard loads `decidePhoto` from `worker/founderPhoto.ts` in the
  browser, so its decisions are the production decisions for the chosen thresholds.

Runs saved before the verdict question was dropped still load. They are scored with the flags only,
and their cards show the old verdict, which plays no part in the decision. Their
`questionsSha256` differs from newer runs.

Calls run four at a time and retry 429 and 5xx responses with backoff. Each run records the model,
the per-photo cost the API reports, and the key's usage before and after (which can lag).

## The dashboard

- **Thresholds.** One per flag, and an "All flags" control that sets the six together. A flag counts
  when its yes is above its threshold. "Production thresholds" puts them back. The page remembers
  your thresholds in this browser.
- **Summary.** Accuracy over photos labelled approve or reject, a matrix of expected against decided,
  false approvals (bad photos approved), false rejections (good photos rejected), and precision and
  recall per flag.
- **Grid.** Filter by category or agreement, or click a matrix cell. Each card shows every flag's
  probability with its current threshold marked. Click a photo to open it full size.
- **Rerun.** Query the API again for all photos, the shown ones or the selected ones. A partial rerun
  carries the other results over from the current run, so every run is complete. A rerun asks only
  the six flags, as production does. Pick an earlier run under "Compare with" to see what changed.
- **Export.** The flag thresholds as JSON, and the `DEFAULT_FLAG_THRESHOLDS` constant to paste into
  `worker/founderPhoto.ts`.

Starting a run is refused unless the request comes from the dashboard's own page.

Other commands:

```bash
npm run photo-lab:run -- --only good-01,dark-02 --based-on <run id> --label "after a prompt change"
npm run photo-lab:fetch -- --force          # download and prepare again
PHOTO_LAB_PORT=5200 npm run photo-lab       # another port
```

## The dataset

`manifest.json` lists each photo's category, expected outcome (approve, reject or either) and
expected flags. Optional flags may fire either way and are not scored. A bad photo is labelled with
its main defect only, so its other flags are not scored either.

| Category | Photos | Expected |
| --- | --- | --- |
| good | 40 | approve |
| people | 12 | reject: people |
| blurry | 7 | reject: lighting |
| dark | 8 | reject: lighting |
| not_park | 11 | reject: not_park |
| not_photo | 6 | reject: not_photo |
| personal_info | 4 | reject: personal_info |
| borderline | 12 | either |

All photos come from Wikimedia Commons under the licence recorded for each. Ten are generated from
other Commons photos by `fetch.py` (blur, camera shake, darkening, overexposure, a pocket shot), and
are marked as derived. Borderline photos include small, distant people: the people question asks
about "small or distant figures", so production may reject them. The inappropriate flag is not covered:
the set has no explicit, violent or hateful content.

## Tests

`tools/photo-lab/lab.test.ts` (part of `npm test`) covers the manifest schema, the decision and
scoring logic, the export, retries and versioned runs with a fake API.
