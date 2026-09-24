# Review photo leads locally

The [September 2026 shortlist](../data/photo-review-leads-2026-09-24.csv) is a fixed, unreviewed set of 299 image candidates for 134 Parkdex places. The review page runs only on your computer. It does not change the Parkdex catalogue or publish images.

## Open the reviewer

From this repository's root:

```powershell
python scripts/photo_review_server.py
```

The script opens `http://127.0.0.1:8765/` in your browser. If it does not open automatically, visit that URL yourself. Keep the terminal open while reviewing; press Ctrl+C to stop the server. To use another port, pass `--port 8766`. The server binds to `127.0.0.1` only.

The page groups candidates by park and shows a thumbnail, source page, original image, creator, license claim, license terms, and location lead. You can approve or reject each image, approve multiple images for one park, clear a decision, and add an optional note. A decision is written to disk after each click. Notes save when you leave their field. The page supports park search, status filters, previous/next navigation, and left/right arrow keys outside form fields.

## Saved files

The server writes these ignored local files after the first decision:

| File | Purpose |
| --- | --- |
| `.codex/photo-source-audit-v3/photo-review-decisions.json` | Source of truth for every reviewed candidate, its status, note, timestamp, and shortlist fingerprint. |
| `.codex/photo-source-audit-v3/photo-review-approved.csv` | Approved candidates with all source fields and review notes. |
| `.codex/photo-source-audit-v3/photo-review-rejected.csv` | Rejected candidates with all source fields and review notes. |

The three download links at the bottom of the page provide copies for backup or sharing. The saved files remain available after you close the browser or restart the server. Codex can read the local JSON and CSV files later when you ask it to process or send the results. No results leave your computer automatically.

The reviewer refuses to mix decisions with a changed shortlist. If you intentionally replace the input, first keep a copy of the existing decisions and exports. You can point the server at another shortlist and state file with `--shortlist` and `--state`.

An **approval is an editorial choice**, not proof that a photo is ready to publish. Before adding an approved image to Parkdex, verify the actual subject and location, source page, photographer, license terms and version, resolution, and attribution. Follow the [place image policy](../frontend/public/places/README.md).
