# CRD municipal and community parks

Parkdex supports the `municipal` and `community` place categories alongside its existing national, provincial, regional, and island categories. Municipal and community parks use the same visit and collection rules as other parks, including containment in the canonical park boundary.

## Rollout

Category support must reach the API and frontend before an import migration exposes active rows with either new category. The previous API validates place response categories, so inserting new categories during that first deployment would make the old API reject some responses while providers converge.

1. Deploy the category types, labels, caches, map presentation, claim-boundary validation, and additive database constraint expansion with the existing catalogue unchanged.
2. Verify the exact staging revision in the API and frontend.
3. Deploy the reviewed CRD import and its additive seed migration as a separate release.

Existing place IDs and visit records remain intact. New municipal and community categories start empty during the compatibility release.

## Import scope

The first import is limited to records classified as Municipal Park or Community Park in the Capital Regional District Park GIS layer. It uses park names, jurisdictions, source identifiers, real Polygon or MultiPolygon boundaries, and representative interior map pins. Those pins are not entrances or routing destinations. The source does not provide visitor overviews, so a factual description derived from category and jurisdiction is sufficient.

One confirmed park is one catalogue entry and one collection credit even if it has multiple boundary pieces. Grouping requires more than a matching name. Source identities, municipality, geography, and any needed official boundary evidence establish identity. Actual boundary gaps and holes are retained. Generic or unresolved records stay outside the initial catalogue with an exclusion reason in the import audit.

## September 2026 import

The frozen CRD snapshot contains 1,273 source features. The reviewed manifest includes 626 park destinations from 699 features: 548 municipal parks and 78 community parks. It holds 258 features across 144 unresolved entries and excludes 316 features across 102 entries. Every source OBJECTID has exactly one disposition. The complete catalogue contains 1,656 places, with all 1,030 previous records and boundaries preserved.

Beacon Hill Park, PKOLS (Mount Douglas Park), Mount Tolmie Park, and Cadboro Gyro Park are included. Existing Sooke River Regional Park retains its existing regional ID and boundary. Multi-parcel parks use the exact union of confirmed source parcels, with an interior representative pin. Shared names alone do not establish a shared destination.

The source snapshot, manifest, cross-check evidence, generated records, and audit are in `data/source-imports/crd-local-parks/`. Names and category/jurisdiction descriptions come from the official source. The descriptions are marked `source-derived`; no visitor facilities, accessibility claims, or page narratives are inferred. The existing reviewed visitor-details dataset remains at 1,030 records. Only municipal and community parks may omit those richer details.

## Reproduce and validate

```powershell
node data/source-imports/crd-local-parks/prepare-import.mjs --check
npm run data:apply-crd-local-parks
node scripts/data-validate.mjs
npm run boundaries:test
npm run boundaries:validate
```

The apply command appends the reviewed bundle and refuses changed existing records or mismatched partial imports. Running it again verifies the existing result without creating duplicates. Refreshing upstream data requires a new reviewed snapshot and manifest; apply does not fetch changing remote data. Migration `0029_import_crd_local_parks.sql` activates the imported catalogue after the category compatibility migration.

## Installed clients

Previously installed Android builds bundle a four-category parser and need an updated app bundle before this data is activated in their environment. The web client updates with the category compatibility release. This staging import does not publish an Android build or promote data to production.
