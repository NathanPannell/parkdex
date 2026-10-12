# Hiding parks

Parks can be hidden without deleting anything. A hidden park keeps its row in `public.parks`, its boundary, drive data, claims, visits and flags, and can be shown again later. `database/migrations/content_005_park_visibility.sql` adds the two tables.

| Table | What it holds |
| --- | --- |
| `public.content_park_hidden` | One row per hidden park: `reason`, `source` (`category` or `operator`) and `hidden_at`. Deleting the park removes the row by cascade. |
| `public.content_hidden_categories` | A standing rule per category with its reason. A park inserted later in that category (an import, the operator dashboard) is hidden on insert. The rule never touches parks that already exist, and changing an existing park's category does not hide it. |

Parks players proposed stay visible whatever their category: anything whose id starts with `proposed-` or `osm-`, or whose draft in `kip_park_drafts.drafts` carries a `proposal` in its source (`public.content_park_is_player_proposal`). They are sparse and added on purpose, so the category rule skips them, both when hiding existing parks and when a proposal is approved later.

## What a hidden park does

- **Older installed builds (readers 1 and 2) and this build.** Hiding writes `park`, `boundary` and `drive` tombstones into the change feed, the same changes a deleted park writes, which every installed build applies. The snapshot leaves hidden parks out for every reader. The changes feed also drops later upserts for a hidden park, so editing it cannot bring it back; a batch left empty reaches older readers as the unchanged hub list (`docs/content-catalogue.md`). Parks already in a player's Dex keep showing from their saved snapshot, as for any removed park.
- **CDN catalogue.** `scripts/content_catalogue.py build` leaves hidden parks out. Until a new release is pointed at, reader 3 installs load the previous release and then apply the tombstones from the changes feed, so the map is right either way; the new release only makes first sync smaller.
- **Flag game.** `POST /api/game/visits` answers `404 park_not_found` for a hidden park. A replay of a visit stored before the park was hidden still returns its stored result. Held flags keep earning until they fall 30 days after the holder's last visit, and visits, tenures, scores and the leaderboard are unchanged. Founding refuses hidden parks (`404 park_not_found`), the outline search leaves them out, and their cover photos and summaries answer 404 (`docs/park-founders.md`). `worker/parkVisibility.ts` (`isParkHidden`, `hiddenParks`) answers whether a park is hidden for any other worker code, such as matching an OpenStreetMap candidate against the catalogue.
- **Unhiding** deletes the rows and writes the park, boundary, drive and any scene descriptor back as upserts with their current values.

## Hide or unhide by category

`scripts/park_visibility.py` plans and applies one reviewed change, like `import_legacy_parks.py`. `--min-reader-floor N` limits a hide to parks whose content reader floor is at least `N`; with `3` that is the legacy BC import (`database/imports/legacy-bc-20261007/`, see `docs/legacy-park-import.md`), and the curated catalogue that older builds get stays visible. Planning only reads. The plan lists every park it will change, the player proposals it keeps visible, and counts per category, including how many of the changed parks older builds currently receive. Apply holds the content clock, rechecks that the same parks would change (a new or recategorised park means a new plan), and writes everything in one transaction, which emits one content revision. A replay is a no-op. Unhide reverses only what the category rule hid; parks hidden by an operator stay hidden.

```powershell
python scripts/park_visibility.py plan hide --category municipal --category community --min-reader-floor 3 --reason "<why>" --target-host <host> --target-environment <env> --out <plan.json>
python scripts/park_visibility.py apply --plan <plan.json> --reviewed-plan-sha <planSha256> --expected-target-host <host> --target-environment <env>
python scripts/park_visibility.py plan unhide --category municipal --category community --target-host <host> --target-environment <env> --out <plan.json>
```

After either, rebuild and point the CDN catalogue release (`docs/content-catalogue.md`).

## Tests

- `scripts/test_park_visibility.py`: plan contents, proposal exemptions, unhide scope and plan hash checks.
- `scripts/qa-park-visibility-sql.mjs` (part of `npm run test:sql`, own throwaway database): plan and apply, snapshots for readers 1 to 3, the strict and current readers applying the tombstones, edits to hidden parks, new parks under a hidden category, player proposals, the CDN release builder, the flag game, and unhide.
- `worker/parkVisibility.test.ts`: the lookup, including a database without the migration.
