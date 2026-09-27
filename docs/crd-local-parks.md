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
