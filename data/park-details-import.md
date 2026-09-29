# Reviewed visitor details import

`park-details.reviewed.json` is the accepted-only public projection of the
2026-09-24 park details snapshot. The source artifact is
`artifacts/park-details-ingestion-20260924/park-details.json`; its SHA-256 is
`6a317999acf3e3d084bbff70546074d5fa45d19f0564068184514448d4c5b09b`. The
reviewed import contains 1,030 records whose IDs exactly match `places.json`.
The source snapshot incorporates 1,519 full approvals and 905 partial
approvals. Omitted candidate material and unapproved portions are not in the
import and must not be recovered from candidate queues.

The public object keeps `schemaVersion`, `scope`, source authority and retrieval
facts, and the visitor information fields. The place ID is the row key and
canonical identity remains in `places`; the duplicate `identity` object is
therefore omitted. `source.archiveIds`, `source.extractionMethod`, and
`reviewFlagIds` are private ingestion metadata and are stripped. Null remains
unknown. Source-only records are retained with their visitor facts null. No
missing visitor facts, coordinates, or access details are inferred.

`source.retrievedAt` is also stored as `source_checked_at`. Each imported row
records the snapshot date, schema version, and SHA-256 of the exact checked-in
reviewed JSON. `0026_create_place_visitor_details.sql` creates the additive
one-to-one table. `0027_import_place_visitor_details.sql` is generated from
the reviewed file so Railway's SQL migrator can populate it without a runtime
Python import.

From the repository root, `python scripts/build_park_details_migration.py --check`
validates the strict public schema, canonical IDs, and generated SQL.
The current `--refresh` command rebuilds the original `0027` baseline from the
accepted source artifact (or an explicit `--source` path). Use it only before
that migration has been applied. After release, never rewrite `0027`; a future
snapshot needs its own accepted-only JSON and a new numbered additive SQL
migration. The current generator is for this baseline snapshot and does not
create future numbered migrations. It reads only `park-details.json` and the
canonical `places.json`; it does not read review candidates, raw archives, or
candidate decision files. The checked-in public JSON is the input used by CI
to verify migration reproducibility.

Sparse future imports use a recursive JSONB merge: non-null scalar leaves
replace old values, null leaves preserve old values, and an explicitly
supplied reviewed array replaces the old array. This allows an unknown null in
a newer snapshot to keep previously known information.
