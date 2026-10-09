# Analytics events

Every API database query and a few named game events are stored in `kip_analytics.events`, next to the app's interaction events (`park_viewed`, `directions_opened`, `park_claimed`). When `POSTHOG_PROJECT_KEY` is set, writes and game events also go to PostHog.

## How events are recorded

- Every store uses `database(url)` from `worker/db.ts` instead of `neon(url)`. It behaves the same and records one `db_read` or `db_write` per query, and one per transaction. New stores must use it too.
- Read or write comes from the SQL text: `INSERT`, `UPDATE`, `DELETE`, `MERGE`, DDL and `nextval` are writes, and so are calls to the database functions listed in `WRITE_FUNCTIONS` in `worker/db.ts` (today `kip_game.record_visit`). Add a function there when it changes data. `tables` holds the schema-qualified tables and functions the SQL mentions (`kip_*` and `public`). SQL text and parameters are never stored.
- The API router and the content sync functions run each request inside a context (`worker/requestContext.ts`). It holds the route, account, installation, app version and bundle ID. After the response, `waitUntil` writes all of the request's events in one insert. Analytics failures never affect the request, and the insert itself is not recorded.
- Game code calls `emitEvent(type, properties)` from `worker/requestContext.ts`. Types: `flag_planted`, `flag_taken`, `flag_held`, `visit_already_today`, `flag_fell`, `leaderboard_viewed`, `takeover_message_seen`, `handle_set`, and for founding parks `park_founded` and `founder_photo_checked` (`docs/park-founders.md`). Every counted visit emits exactly one of the first four outcomes. A `parkId` property fills `park_id`; other properties are small scalars stored in `properties` with snake_case names.

## Request labels

The app sends these on every API call. The server validates each one and drops anything malformed. They are labels for analysis, never used for access.

| Header | Value |
| --- | --- |
| `X-Kip-Installation-Id` | Random UUID per install, the same one interaction events use. |
| `X-Kip-App-Version` | Package version, plus `+<versionCode>` on Android, for example `0.1.0+42`. |
| `X-Kip-Bundle-Id` | The web bundle's source revision. An over-the-air updater can report its own bundle through `setRequestBundleId`. |

The account comes from the verified session, not a header. The app config check-in sends the labels only to its own host, because native builds check in cross-origin with production.

## Columns for server events

| Column | Meaning |
| --- | --- |
| `event_type` | `db_read`, `db_write` or a game event. |
| `occurred_at` | When the query started or the event happened (server time). `received_at` is when the batch was written. |
| `request_id` | Groups the events of one API request. |
| `route` | Method and path with IDs replaced, for example `PUT /api/claims/:id/photo`. |
| `account_id`, `installation_id` | Who caused it, when known. |
| `app_version`, `bundle_id`, `environment` | The app build and the server environment (`main`, `staging` or `preview`). |
| `operation`, `tables`, `duration_ms`, `result` | Database events only. `result` is `ok`, a SQLSTATE code such as `23505`, `error` or `aborted`. |
| `park_id`, `properties` | Game events only. |

Rows follow the existing 90-day retention purge (`/api/retention/interactions/purge`).

## Example queries

```sql
-- Slowest routes this week.
SELECT route, count(*) AS queries, percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms) AS p95_ms
FROM kip_analytics.events
WHERE event_type IN ('db_read', 'db_write') AND received_at > now() - interval '7 days'
GROUP BY route ORDER BY p95_ms DESC LIMIT 20;

-- Share of visits that are takeovers.
SELECT count(*) FILTER (WHERE event_type = 'flag_taken')::float
     / NULLIF(count(*) FILTER (WHERE event_type IN ('flag_planted', 'flag_taken', 'flag_held', 'visit_already_today')), 0) AS takeover_share
FROM kip_analytics.events WHERE received_at > now() - interval '14 days';

-- Failed queries by table.
SELECT unnest(tables) AS table_name, result, count(*)
FROM kip_analytics.events WHERE event_type IN ('db_read', 'db_write') AND result <> 'ok'
GROUP BY 1, 2 ORDER BY 3 DESC;
```

## PostHog

- Server: with `POSTHOG_PROJECT_KEY` (and optional `POSTHOG_HOST`, default `https://us.i.posthog.com`), each request's `db_write` and game events go to `POST <host>/batch/`. Reads stay in our table only, to keep under the free plan's 1M events a month. `distinct_id` is the account ID, else the installation ID; anonymous events set `$process_person_profile: false`. Every event carries `environment` (`production`, `staging` or `preview`), `app_version` and `bundle_id`.
- App: the server returns `analytics: { posthogKey, posthogHost }` in `/api/app-config` when a key is set, so analytics can be switched on without a new build. A build can also bake `VITE_POSTHOG_PROJECT_KEY` and `VITE_POSTHOG_HOST` as a fallback. With a key, `posthog-js` loads on demand with autocapture and `person_profiles: 'identified_only'`, uses the installation ID as its anonymous ID, and identifies by account ID after sign-in. Without a key the SDK is never downloaded.

## Schema

`database/migrations/interactions_002_db_events.sql` widens the table additively. Interaction events keep their original required fields and checks. Constraints have versioned names (`events_shape_v2_check`) and `interactions_002` adds them only when missing. Because it replays on every deploy, a new name would be added back next to a wider one, so new event types widen the v2 constraints under the same names instead: `founders_001_init.sql` replaces both, once, when their definition lacks `park_founded`, as `NOT VALID` so no rows are rescanned. A later migration that adds event types must do the same and keep every type in its lists.
