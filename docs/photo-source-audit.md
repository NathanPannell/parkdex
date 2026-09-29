# Place photo source audit

`scripts/photo_source_audit.py` searches the public staging catalogue for image leads. It does not download, publish, or add photos to the app. A search result is never proof of location, authorship, or permission.

## Run

From the repository root, with Python and `requests` installed:

```powershell
python scripts/photo_source_audit.py
```

The default sources are Wikimedia Commons, Openverse, and iNaturalist. The script reads `https://api-staging-882c.up.railway.app/api/places`, checks its IDs against this checkout's boundaries and image manifest, skips places with existing photos, paces requests per host, and writes a resumable audit under `.codex/photo-source-audit/`. Re-run the same command to resume with the same search settings. If the staging catalogue, boundaries, or search policy changes, use a new output directory. To try a small sample:

```powershell
python scripts/photo_source_audit.py --place-id provincial-tuya-mountains-park --limit-per-source 5
```

To query optional sources, pass `--sources` and their credentials in the process environment. Flickr also requires `--flickr-commercial-api-approved`, because its API terms require prior approval for commercial use. The script never downloads Flickr images. Pexels and Unsplash results are platform-license leads, not Creative Commons assets. Pixabay is omitted because its API documentation discourages systematic bulk queries. BC government galleries are omitted because government hosting is not a blanket image license.

```powershell
$env:FLICKR_API_KEY = '<approved key>'
python scripts/photo_source_audit.py --sources commons,openverse,inaturalist,flickr --flickr-commercial-api-approved
```

## Outputs and review

- `run.json` and `catalogue.json` pin the queried catalogue, local boundary geometry, search policy, and result limit.
- `queries.jsonl` checkpoints each place/source query. Successful queries are skipped on resume; failed queries are retried.
- `candidates.csv` includes source pages, preview URLs, creator and license claims, queries, and two location signals: name in source metadata and coordinates inside the published Parkdex boundary.
- `summary.json` separates existing verified photos, unreviewed leads that name the place with BC or boundary evidence, weaker name-only leads, boundary-only leads, on-site iNaturalist biodiversity leads, errors, and the 70% target. Only the existing manifest is counted as verified coverage. Its potential-coverage figure assumes every stronger named-place lead passes human review and is an upper bound, not achieved coverage.

Before importing a candidate, open the original source page and verify the photo license, photographer, exact place or documented feature, image resolution, and required credit. For geotagged iNaturalist observations, also verify the image actually depicts the park rather than only a species photographed nearby. Keep source and location evidence in the place-image manifest. The accepted catalogue policy is in [`frontend/public/places/README.md`](../frontend/public/places/README.md).

The fixed 299-candidate shortlist from the September 2026 sweep can be reviewed with the [local photo review page](photo-review.md). Its approvals remain local and do not import or publish photos.

iNaturalist's observation response gives the license family but may omit its version. For BY and BY-SA candidates, `license_url` points to the photo page where the exact version must be checked. These biodiversity leads are excluded from projected park-photo coverage.

## Source terms

- [Wikimedia Commons reuse](https://commons.wikimedia.org/wiki/Commons:Reusing_content_outside_Wikimedia/en)
- [Openverse API](https://api.openverse.org/v1/)
- [iNaturalist photo reuse](https://help.inaturalist.org/en/support/solutions/articles/151000169918-can-i-use-the-photos-and-sounds-that-are-posted-on-inaturalist-)
- [Flickr API terms](https://www.flickr.com/help/terms/api)
- [Unsplash API terms](https://unsplash.com/api-terms)
- [Pexels license](https://www.pexels.com/license/)
- [Pixabay API](https://pixabay.com/api/docs/)
- [BC government copyright](https://www2.gov.bc.ca/gov/content/home/copyright)
