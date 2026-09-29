# CRD municipal and community parks

This import uses the Capital Regional District Park layer's `Municipal Park` and `Community Park` records. It copies the source name, jurisdiction and geometry, creates an interior representative point, and assigns the matching Parkdex category. Descriptions state only the name and municipal or community classification. No amenity or access claims are inferred.

The accepted source snapshot contains 1,273 polygons, retrieved with `outSR=4326`: 1,074 municipal and 199 community records. The layer describes its contents as municipality supplied or verified, and warns that definitions and completeness vary. A source type alone does not prove that a record is a named park destination, so the reviewed manifest explicitly includes, holds or excludes every source `OBJECTID`.

## Files

- `crd-municipal-community-source.geojson` is the accepted frozen CRD snapshot.
- `source-retrieval.json` and `source-layer-metadata.json` record the query and service metadata.
- `source-feature-inventory.csv` and `source-identity-audit.json` record the source inventory and initial spatial review.
- `official-boundary-crosschecks.geojson` and `official-boundary-crosschecks.json` preserve the reviewed Saanich and Victoria boundary evidence.
- `import-manifest.json` fixes each include, hold and exclude decision, stable place ID, source OID list, and grouping evidence. Its SHA-256 prevents a later refresh from silently changing the reviewed input.
- `places.json`, `boundaries.geojson`, `descriptions.catalogue.json` and `import-audit.json` are deterministic CRD-only outputs for the repository data pipeline.
- `prepare-import.mjs` generates or checks those CRD-only outputs from the accepted snapshot and manifest.
- `refresh-source.mjs` retrieves a fresh source preview without changing the accepted snapshot or manifest.

## Review rules

The source identity key is `Type`, `Jurisdic` and a normalized `Name`. A repeated name is merged only when its source polygons form one exact-touching or overlapping connected group, or when a reviewed jurisdiction-maintained official park boundary has the same name and overlaps every CRD piece by at least 70 percent of that piece's area. Unresolved repeated names and variants stay on hold. No distance buffer is used to connect source pieces.

Approved grouped boundaries are the set union of their original source polygons. The preparer uses `polygon-clipping` on the source coordinates, without buffers, convex hulls, smoothing or synthetic land bridges. Disconnected source parts remain a `MultiPolygon`; polygon holes are retained. The import audit records each included group, source IDs and names, part and hole counts, area totals, and union recipe. Each pin is rounded to six decimals and checked inside the generated geometry.

Names without an explicit `Park` identity remain on hold unless the reviewed Saanich or Victoria parks layer directly confirms the named destination. The reviewed Victoria boundary confirms `Blackwood Green`; its official park class is preserved in the crosscheck snapshot. Named non-destination facilities, access corridors, park reserves, unconfirmed parcels and infrastructure are separately excluded by manifest reason. The Sooke River source polygon, OBJECTID 1958, is mapped to the existing `regional-sooke-river-regional-park` record and is not emitted as a new municipal place.

New local IDs are fixed in the manifest as `<category>-<jurisdiction-slug>-<lowest-included-OBJECTID>`. All member OIDs are stored beside the ID, so a future source name change does not create a replacement identity. Place and boundary source names use the trimmed jurisdiction followed by `(CRD Park GIS)`; raw source jurisdiction values remain in the manifest and boundary provenance. The CRD layer URL and original source IDs remain in provenance.

## Commands

From the repository root:

```powershell
node data/source-imports/crd-local-parks/prepare-import.mjs
node data/source-imports/crd-local-parks/prepare-import.mjs --check
node data/source-imports/crd-local-parks/refresh-source.mjs
```

The refresh command writes `source-refresh-preview.geojson` and `source-refresh-report.json`. Review every changed identity and geometry before adopting a new snapshot. It does not edit the accepted snapshot or manifest. A new source snapshot must be accompanied by reviewed manifest decisions and a new SHA-256 before preparation succeeds.
