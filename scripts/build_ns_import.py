#!/usr/bin/env python3
"""Fetch, pin and build the Nova Scotia provincial and national park import bundle.

`fetch` downloads every official source into a raw folder outside the
repository and pins URL, retrieval time, size and SHA-256 in the bundle's
`sources/fetch-record.json`. `build` re-reads those raw files, refuses any
whose hash changed, and writes the same importer inputs as the legacy BC
bundle (docs/import-legacy-bc-parks.md). Neither step writes to a database,
R2 or any provider. Every new park gets content reader floor 3.
"""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import gzip
import hashlib
import json
import math
from pathlib import Path
import re
import sys
import time
from typing import Any
from urllib.parse import quote, urlencode
import urllib.request

import build_bc_import as bc
import content_catalogue
import import_legacy_parks as importer

SCHEMA = "parkdex.ns-import-bundle.v1"
FETCH_SCHEMA = "parkdex.ns-source-fetch.v1"
DEFAULT_BUNDLE = Path(__file__).resolve().parents[1] / "database" / "imports" / "ns-20261013"
USER_AGENT = "parkdex-ns-import/1.0 (+https://github.com/NathanPannell/parkdex-kip/issues/178)"
MINIMUM_READER = 3
BOUNDARIES_FILE = "boundaries.geojson.gz"
COORDINATE_DECIMALS = 7

NSECC_LAYER = "https://services1.arcgis.com/qpxtVXh93G601MmT/arcgis/rest/services/Nova_Scotia_Parks_and_Protected_Areas_System_V1/FeatureServer/1"
NSECC_PAGE = "https://nse.maps.arcgis.com/home/item.html?id=c4561687c5f845f5a425d9426f7bc8ab"
NSECC_NAME = "Nova Scotia Environment and Climate Change - Parks and Protected Areas System"
CLSS_LAYER = "https://proxyinternet.nrcan-rncan.gc.ca/arcgis/rest/services/CLSS-SATC/CLSS_Administrative_Boundaries/MapServer/1"
CLSS_PAGE = "https://open.canada.ca/data/en/dataset/9e1507cd-f25c-4c64-995b-6563bf9d65bd"
# The same source name the legacy BC national boundaries carry.
CLSS_NAME = "Natural Resources Canada — Canada Lands Survey System"
FINDER_URL = "https://parks.canada.ca/pn-np/recherche-parcs-parks-search"
ENTRANCES_PAGE = "https://data.novascotia.ca/Nature-and-Environment/Provincial-Day-use-and-Camping-Park-Entrances/c6mf-qy4u"
MUNICIPALITIES_PAGE = "https://data.novascotia.ca/Municipalities/Municipality-Boundaries/7bqh-hssn"
NSTDB_PAGE = "https://data.novascotia.ca/Lands-Forests-and-Wildlife/Nova-Scotia-Topographic-Database-Delimiters-Poly-L/k3u4-5mnw"
CDN_ORIGIN = "https://kip-assets.parkdex.app"
CATALOGUE_HOSTS = {"staging": "staging.web.parkdex.app", "production": "web.parkdex.app"}


def arcgis(layer: str, **params: str) -> str:
    return f"{layer}/query?{urlencode(params, quote_via=quote)}"


# Every official source, fetched exactly as listed. Query parameters are part of the pin.
SOURCES: dict[str, dict[str, str]] = {
    "nsecc-parks.geojson": {
        "url": arcgis(NSECC_LAYER, where="PROT_TYPE LIKE '%Park%'", outFields="*", returnGeometry="true", outSR="4326", orderByFields="OBJECTID", f="geojson"),
        "page": NSECC_PAGE,
        "role": "Provincial park outlines (PROT_TYPE 'Provincial Park', designated under the Provincial Parks Act and managed by Natural Resources and Renewables) and the Sable Island National Park Reserve outline, from the province's Parks and Protected Areas System layer.",
    },
    "nsecc-attributes.json": {
        "url": arcgis(
            NSECC_LAYER,
            where="1=1",
            outFields="OBJECTID,PROT_NAME,PROT_TYPE,PROT_STATUS,LEGISLATION,MGMT_AUTHORITY",
            returnGeometry="false",
            orderByFields="OBJECTID",
            f="json",
        ),
        "page": NSECC_PAGE,
        "role": "Every feature of the same layer without geometry, to count what the provincial park filter leaves out.",
    },
    "clss-national-parks-ns.geojson": {
        "url": arcgis(CLSS_LAYER, where="jurisdiction='NS'", outFields="*", returnGeometry="true", outSR="4326", orderByFields="OBJECTID", f="geojson"),
        "page": CLSS_PAGE,
        "role": "Legislative national park boundaries in Nova Scotia (Cape Breton Highlands, Kejimkujik inland and Seaside).",
    },
    "parks-canada-finder.html": {
        "url": FINDER_URL,
        "page": FINDER_URL,
        "role": "Parks Canada park finder; each park row carries its map point as WKT.",
    },
    "ns-park-entrances.geojson": {
        "url": "https://data.novascotia.ca/api/geospatial/c6mf-qy4u?method=export&format=GeoJSON",
        "page": ENTRANCES_PAGE,
        "role": "Official provincial day-use and camping park entrance points (Natural Resources), used as pins when one lies inside the park outline.",
    },
    "ns-municipalities.geojson": {
        "url": "https://data.novascotia.ca/api/geospatial/7bqh-hssn?method=export&format=GeoJSON",
        "page": MUNICIPALITIES_PAGE,
        "role": "Municipality boundaries with their county, used to place each pin in a county.",
    },
    "nstdb-park-delimiters.json": {
        "url": "https://data.novascotia.ca/resource/k3u4-5mnw.json?"
        + urlencode(
            {"$select": "feat_code,feat_desc,name", "$where": "feat_code in ('DLPKPR50','DLPKNA50')", "$order": "name,feat_code", "$limit": "1000"},
            quote_via=quote,
        ),
        "page": NSTDB_PAGE,
        "role": "Names of provincial and national park delimiters in the Nova Scotia Topographic Database, as an independent completeness check.",
    },
}


def sha256(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def json_bytes(value: Any) -> bytes:
    return bc.json_bytes(value)


def now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def download(url: str) -> bytes:
    # workers.dev and some government hosts refuse requests without a User-Agent.
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept-Encoding": "identity"})
    last: Exception | None = None
    for attempt in range(3):
        try:
            with urllib.request.urlopen(request, timeout=180) as response:
                if response.status != 200:
                    raise importer.ParkImportError(f"{url} answered {response.status}")
                return response.read()
        except Exception as exc:  # noqa: BLE001 - retried, then reported without the body
            last = exc
            time.sleep(2 * (attempt + 1))
    raise importer.ParkImportError(f"Could not fetch {url} ({type(last).__name__}: {last})")


# Fetch: download every source into the raw folder and pin it.


def fetch(raw_dir: Path, bundle_dir: Path) -> dict[str, Any]:
    raw_dir.mkdir(parents=True, exist_ok=True)
    record: dict[str, Any] = {
        "schema": FETCH_SCHEMA,
        "fetchedAt": now(),
        "rawFiles": "Kept outside the repository; `python scripts/build_ns_import.py fetch --raw <folder>` downloads them again.",
        "sources": {},
    }
    for name, spec in SOURCES.items():
        data = download(spec["url"])
        (raw_dir / name).write_bytes(data)
        record["sources"][name] = {**spec, "retrievedAt": now(), "bytes": len(data), "sha256": sha256(data)}
    for environment, host in CATALOGUE_HOSTS.items():
        for reader in (1, 2, 3):
            name = f"{environment}-snapshot-reader{reader}.json"
            url = f"https://{host}/api/content/snapshot?reader={reader}"
            data = download(url)
            (raw_dir / name).write_bytes(data)
            record["sources"][name] = {
                "url": url,
                "role": f"Parkdex {environment} content snapshot as reader {reader} receives it",
                "retrievedAt": now(),
                "bytes": len(data),
                "sha256": sha256(data),
            }
        pointer = json.loads((raw_dir / f"{environment}-snapshot-reader3.json").read_bytes())["catalogue"]
        index_raw = download(pointer["indexUrl"])
        if sha256(index_raw) != pointer["indexSha256"]:
            raise importer.ParkImportError(f"The {environment} catalogue index does not match its pointer")
        folder = raw_dir / f"{environment}-catalogue"
        (folder / "catalogue" / "boundaries").mkdir(parents=True, exist_ok=True)
        (folder / content_catalogue.INDEX_PATH).write_bytes(index_raw)
        index = json.loads(index_raw)
        for chunk in index["boundaryChunks"]:
            data = download(f"{CDN_ORIGIN}/releases/{pointer['version']}/{chunk['path']}")
            if sha256(data) != chunk["sha256"]:
                raise importer.ParkImportError(f"The {environment} chunk {chunk['path']} does not match its index")
            (folder / chunk["path"]).write_bytes(data)
        record["sources"][f"{environment}-catalogue/{content_catalogue.INDEX_PATH}"] = {
            "url": pointer["indexUrl"],
            "role": f"Parkdex {environment} CDN catalogue release (revision {index['revision']}, {len(index['parks'])} parks); its boundary chunks are pinned by the hashes inside the index",
            "retrievedAt": now(),
            "bytes": len(index_raw),
            "sha256": sha256(index_raw),
            "chunks": len(index["boundaryChunks"]),
        }
    (bundle_dir / "sources").mkdir(parents=True, exist_ok=True)
    raw = json_bytes(record)
    (bundle_dir / "sources" / "fetch-record.json").write_bytes(raw)
    return {"rawDir": str(raw_dir), "fetchRecordSha256": sha256(raw), "sources": {k: v["sha256"] for k, v in record["sources"].items()}}


# Regions. Counties map to the seven Nova Scotia regions below (the province's
# tourism regions; My Dex groups them under "Nova Scotia"). Three counties face
# two coasts, so one region each would misplace parks: they split along a pinned
# line. Three municipalities belong to the Acadian Shores rather than to their
# county's region.
REGIONS = (
    "Halifax Metro",
    "South Shore",
    "Yarmouth and Acadian Shores",
    "Bay of Fundy and Annapolis Valley",
    "Northumberland Shore",
    "Eastern Shore",
    "Cape Breton Island",
)
SPLIT = "split"
COUNTY_REGIONS = {
    "Annapolis": "Bay of Fundy and Annapolis Valley",
    "Antigonish": "Northumberland Shore",
    "Cape Breton": "Cape Breton Island",
    "Colchester": SPLIT,
    "Cumberland": SPLIT,
    "Digby": "Bay of Fundy and Annapolis Valley",
    "Guysborough": "Eastern Shore",
    "Halifax": SPLIT,
    "Hants": "Bay of Fundy and Annapolis Valley",
    "Inverness": "Cape Breton Island",
    "Kings": "Bay of Fundy and Annapolis Valley",
    "Lunenburg": "South Shore",
    "Pictou": "Northumberland Shore",
    "Queens": "South Shore",
    "Richmond": "Cape Breton Island",
    "Shelburne": "South Shore",
    "Victoria": "Cape Breton Island",
    "Yarmouth": "Yarmouth and Acadian Shores",
}
SPLIT_RULES = {
    "Halifax": "Eastern Shore when the pin is east of 63.45° W (from Lawrencetown on), otherwise Halifax Metro.",
    "Colchester": "Northumberland Shore when the pin is north of 45.55° N (the Northumberland Strait side of the Cobequid Hills), otherwise Bay of Fundy and Annapolis Valley.",
    "Cumberland": "Northumberland Shore when the pin is north of 45.55° N (the Northumberland Strait side of the Cobequid Hills), otherwise Bay of Fundy and Annapolis Valley.",
}
MUNICIPALITY_REGIONS = {
    ("Digby", "Clare"): "Yarmouth and Acadian Shores",
    ("Shelburne", "Barrington"): "Yarmouth and Acadian Shores",
    ("Shelburne", "Clark's Harbour"): "Yarmouth and Acadian Shores",
}
NORTHUMBERLAND_LATITUDE = 45.55
EASTERN_SHORE_LONGITUDE = -63.45
# Sable Island lies 160 km offshore, in no municipality polygon. It is part of
# the Halifax Regional Municipality and reached only from Halifax.
PARK_REGION_OVERRIDES = {
    "national-sable-island-national-park-reserve": {
        "county": "Halifax",
        "municipality": "Halifax",
        "region": "Halifax Metro",
        "reason": "Offshore and in no municipality polygon; part of the Halifax Regional Municipality and reached only from Halifax.",
    },
}
NEAREST_MUNICIPALITY_DEGREES = 0.05
REGION_PHRASES = {
    "Halifax Metro": "in the Halifax Metro region of Nova Scotia",
    "South Shore": "on Nova Scotia's South Shore",
    "Yarmouth and Acadian Shores": "in Nova Scotia's Yarmouth and Acadian Shores region",
    "Bay of Fundy and Annapolis Valley": "in Nova Scotia's Bay of Fundy and Annapolis Valley region",
    "Northumberland Shore": "on Nova Scotia's Northumberland Shore",
    "Eastern Shore": "on Nova Scotia's Eastern Shore",
    "Cape Breton Island": "on Cape Breton Island, Nova Scotia",
}

# National parks in scope, by Parks Canada finder name. Kejimkujik is one park:
# its CLSS boundary holds the inland part and the Seaside part. Sable Island
# National Park Reserve has no CLSS legislative boundary, so its outline comes
# from the province's Parks and Protected Areas System layer.
NATIONAL_PARKS = {
    "Cape Breton Highlands National Park": {"source": "clss", "adminAreaId": "CBHI"},
    "Kejimkujik National Park and National Historic Site": {"source": "clss", "adminAreaId": "KEJI"},
    "Sable Island National Park Reserve": {
        "source": "nsecc",
        "names": (
            "Sable Island National Park Reserve Of Canada",
            "Sable Island National Park Reserve Of Canada/Sable Island Bird Sanctuary",
        ),
    },
}
NSECC_NATIONAL_NAMES = {
    "CBHI": "Cape Breton Highlands National Park Of Canada",
    "KEJI": "Kejimkujik National Park And National Historic Site Of Canada",
}
PROVINCIAL_TYPE = "Provincial Park"
PROVINCIAL_LEGISLATION = "Provincial Parks Act (1989)"
EXPECTED_PROVINCIAL = 109
EXPECTED_NATIONAL = 3
# The entrance list names one park differently from the outline layer.
ENTRANCE_NAME_ALIASES = {"Cole Harbour-Lawrencetown Coastal Heritage": "Cole Harbour - Lawrencetown Provincial Park"}
# Spellings in the Nova Scotia Topographic Database that differ from the outline layer
# (cross-check only; catalogue names follow the outline layer and the entrance list).
TOPOGRAPHIC_NAME_VARIANTS = {
    "Bayfield Beach Provincial Park": "Bayfield Provincial Park",
    "Caribou-Munroe Island Provincial Park": "Caribou-Munroes Island Provincial Park",
    "Clam Harbour Beach Provincial Park": "Clam Harbour Provincial Park",
    "Cole Harbour - Lawrencetown Provincial Park": "Cole Harbour-Lawrencetown Coastal Heritage Park System",
    "Ellenwood Provincial Park": "Ellenwood Lake Provincial Park",
    "Mavilette Beach Provincial Park": "Mavillette Beach Provincial Park",
    "Rushtons Beach Provincial Park": "Rushton Beach Provincial Park",
    "William E. deGarthe Provincial Park": "William E. deGarthe Memorial Provincial Park",
}
NS_SHORT_NAME = re.compile(r"\s+national park and national historic site$", re.IGNORECASE)
CATEGORY_KIND = {"provincial": "provincial park", "national": "national park"}
DUPLICATE_OVERLAP = bc.DUPLICATE_OVERLAP
OVERLAP_REPORT_FLOOR = bc.OVERLAP_REPORT_FLOOR
# Local equirectangular hectares run about 0.6% under the layer's official figures.
OFFICIAL_AREA_TOLERANCE = 0.02
# Rounding to 7 decimal places moves a vertex by under 1 cm. On the smallest
# parks (585 m² and 1,100 m²) that changes about 0.02% of the area, so any park
# keeping less than 99.9% of its source area has lost something real.
MIN_AREA_KEPT = 0.999
MAX_SYNC_RESPONSE_BYTES = bc.MAX_SYNC_RESPONSE_BYTES
MIN_SNAPSHOT_HEADROOM_BYTES = bc.MIN_SNAPSHOT_HEADROOM_BYTES
MAX_CHUNK_BYTES = bc.MAX_CHUNK_BYTES
REPO = Path(__file__).resolve().parents[1]
# Stable IDs that are or were in a Parkdex catalogue, besides the live releases.
KNOWN_ID_SOURCES = (
    "database/imports/legacy-bc-20261007/park-ids.txt",
    "database/imports/legacy-bc-20261007/sources/staging-rev158-snapshot.json.gz",
    "database/imports/provincial-regional-20260929/sources/baseline-snapshot.json",
    "database/imports/provincial-regional-20260929/selection.json",
    "database/imports/legacy-boundaries-20260928/boundaries.geojson",
)


def slugify(value: str) -> str:
    import unicodedata

    text = unicodedata.normalize("NFKD", value)
    text = "".join(character for character in text if not unicodedata.combining(character)).lower()
    return re.sub(r"[^a-z0-9]+", "-", text.replace("&", " and ")).strip("-")


def name_key(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", value.lower().replace("&", "and"))


def read_raw(raw_dir: Path, bundle_dir: Path) -> tuple[dict[str, Any], dict[str, bytes]]:
    try:
        record = json.loads((bundle_dir / "sources" / "fetch-record.json").read_bytes())
    except OSError as exc:
        raise importer.ParkImportError(f"Missing sources/fetch-record.json ({type(exc).__name__})") from None
    raw: dict[str, bytes] = {}
    for name, entry in record["sources"].items():
        try:
            data = (raw_dir / name).read_bytes()
        except OSError as exc:
            raise importer.ParkImportError(f"Missing raw source {name} ({type(exc).__name__}); run fetch first") from None
        if sha256(data) != entry["sha256"]:
            raise importer.ParkImportError(f"Pinned source {name} changed: expected {entry['sha256']}, got {sha256(data)}")
        raw[name] = data
    for environment in CATALOGUE_HOSTS:
        index = json.loads(raw[f"{environment}-catalogue/{content_catalogue.INDEX_PATH}"])
        for chunk in index["boundaryChunks"]:
            data = (raw_dir / f"{environment}-catalogue" / chunk["path"]).read_bytes()
            if sha256(data) != chunk["sha256"]:
                raise importer.ParkImportError(f"Pinned {environment} chunk {chunk['path']} changed")
            raw[f"{environment}-catalogue/{chunk['path']}"] = data
    return record, raw


# Geometry. The province's layer stores some inner rings as separate shells
# ("nested shells"); its official hectares show those rings are holes. So an
# invalid feature is rebuilt with the planar-face even-odd rule over all of its
# rings: a face is inside when an odd number of rings contain it. The features
# of one park stay separate parts, or are unioned when they touch or overlap.


def rings_of(geometry: dict[str, Any]) -> list[list[list[float]]]:
    return [ring for polygon in bc.polygons_of(geometry) for ring in polygon]


def even_odd_inside(point: tuple[float, float], rings: list[list[list[float]]]) -> bool:
    return sum(1 for ring in rings if bc.in_ring(point, ring)) % 2 == 1


def multipolygon(polygons: list[Any]) -> dict[str, Any]:
    return {"type": "MultiPolygon", "coordinates": polygons}


def shapely_parts(value: Any) -> list[Any]:
    from shapely.geometry import mapping

    value = bc._polygonal(value)
    parts = list(value.geoms) if value.geom_type == "MultiPolygon" else [value]
    return [json.loads(json.dumps(mapping(part)))["coordinates"] for part in parts if not part.is_empty]


def normalize_feature(geometry: dict[str, Any], label: str) -> tuple[list[Any], dict[str, Any] | None]:
    from shapely.geometry import LineString, shape
    from shapely.ops import polygonize, unary_union
    from shapely.validation import explain_validity

    original = shape(geometry)
    if original.is_valid:
        return [list(polygon) for polygon in bc.polygons_of(geometry)], None
    rings = rings_of(geometry)
    faces = list(polygonize(unary_union([LineString(ring) for ring in rings])))
    included = [face for face in faces if even_odd_inside(bc._probe(face), rings)]
    if not included:
        raise importer.ParkImportError(f"{label}: normalization found no interior faces")
    rebuilt = unary_union(included)
    if rebuilt.is_empty or not rebuilt.is_valid:
        raise importer.ParkImportError(f"{label}: normalized geometry is invalid")
    return shapely_parts(rebuilt), {
        "method": "planar-face-even-odd-all-rings",
        "sourceProblem": re.sub(r"\[.*\]$", "", explain_validity(original)),
        "sourceCounts": bc.counts(geometry),
        "planarFaces": len(faces),
        "includedFaces": len(included),
    }


def rounded(polygons: list[Any], decimals: int) -> list[Any]:
    result = []
    for polygon in polygons:
        rings = []
        for ring in polygon:
            points: list[list[float]] = []
            for x, y in ring:
                point = [round(x, decimals), round(y, decimals)]
                if not points or point != points[-1]:
                    points.append(point)
            if points[0] != points[-1]:
                points.append(points[0])
            rings.append(points)
        result.append(rings)
    return result


def local_hectares(value: Any) -> float:
    """Area in a local equirectangular projection, accurate to about 1% at Nova Scotia's size."""
    from shapely.ops import transform

    if value.is_empty:
        return 0.0
    scale = math.cos(math.radians(value.centroid.y))
    return transform(lambda x, y: (x * scale * 111_320.0, y * 110_574.0), value).area / 10_000


def even_odd_agreement(rings: list[list[list[float]]], output: dict[str, Any], grid: int = 24) -> dict[str, int]:
    """Grid samples where the source even-odd ring rule and the output disagree."""
    from shapely.geometry import Point, shape

    output_shape = shape(output)
    west, south, east, north = output_shape.bounds
    disagreements = 0
    for row in range(grid):
        for column in range(grid):
            point = (west + (column + 0.5) * (east - west) / grid, south + (row + 0.5) * (north - south) / grid)
            if even_odd_inside(point, rings) != output_shape.contains(Point(point)):
                disagreements += 1
    return {"samples": grid * grid, "disagreements": disagreements}


def assemble(park_id: str, features: list[dict[str, Any]]) -> tuple[dict[str, Any], dict[str, Any]]:
    """One park's output geometry from its source features, with the evidence for review."""
    from shapely.geometry import shape
    from shapely.ops import unary_union

    polygons: list[Any] = []
    normalizations: list[dict[str, Any]] = []
    rows: list[dict[str, Any]] = []
    shapes = []
    agreements = []
    for feature in features:
        source_id = feature["sourceFeatureId"]
        parts, report = normalize_feature(feature["geometry"], f"{park_id} source {source_id}")
        part_shape = shape(multipolygon(parts))
        shapes.append(part_shape)
        if report:
            normalizations.append({"parkId": park_id, "sourceFeatureId": source_id, **report, "normalizedCounts": bc.counts(multipolygon(parts))})
            agreements.append({"sourceFeatureId": source_id, **even_odd_agreement(rings_of(feature["geometry"]), multipolygon(parts))})
        rows.append(
            {
                "sourceFeatureId": source_id,
                "objectId": feature["objectId"],
                "sourceValid": report is None,
                "sourceCounts": bc.counts(feature["geometry"]),
                "officialHectares": feature["officialHectares"],
                "hectares": round(local_hectares(part_shape), 3),
            }
        )
        polygons.extend(parts)
    combined = multipolygon(polygons)
    assembly = "parts"
    if not shape(combined).is_valid:
        combined = multipolygon(shapely_parts(unary_union(shapes)))
        assembly = "source-feature-union"
        normalizations.append(
            {
                "parkId": park_id,
                "method": assembly,
                "sourceFeatureIds": [f["sourceFeatureId"] for f in features],
                "reason": "Source features of one park touch or overlap, so the park is their union.",
                "partsBefore": len(polygons),
                "normalizedCounts": bc.counts(combined),
            }
        )
    output = multipolygon(rounded(combined["coordinates"], COORDINATE_DECIMALS))
    if not shape(output).is_valid:
        output = combined
        assembly += "-full-precision"
    source_union = unary_union(shapes)
    output_shape = shape(output)
    evidence = {
        "sourceFeatures": rows,
        "sourceCounts": {key: sum(row["sourceCounts"][key] for row in rows) for key in ("polygons", "holes", "rings", "positions")},
        # After the even-odd repair of each feature, before features are joined.
        "normalizedSourceCounts": bc.counts(multipolygon(polygons)),
        "outputCounts": bc.counts(output),
        "assembly": assembly,
        "coverage": {
            "sourceAreaKept": round(source_union.intersection(output_shape).area / source_union.area, 9),
            "areaAdded": round(output_shape.difference(source_union).area / source_union.area, 9),
        },
        "hectares": round(local_hectares(output_shape), 3),
    }
    if agreements:
        evidence["evenOddAgreement"] = agreements
    return output, {"evidence": evidence, "normalizations": normalizations}


def interior_point(geometry: dict[str, Any]) -> list[float]:
    """A point inside the largest part (not the centroid, which can fall outside)."""
    from shapely.geometry import Polygon

    polygons = sorted(bc.polygons_of(geometry), key=lambda polygon: -Polygon(polygon[0], polygon[1:]).area)
    point = Polygon(polygons[0][0], polygons[0][1:]).representative_point()
    for decimals in (6, 7, 8):
        candidate = [round(point.x, decimals), round(point.y, decimals)]
        if bc.legacy_inside(tuple(candidate), geometry):
            return candidate
    raise importer.ParkImportError("Interior point does not survive rounding")


# Sources to park records.


def parse_finder(html: str) -> dict[str, list[float]]:
    pattern = re.compile(r'<tr locationTarget="[^"]+" data-geometry="POINT \(([-0-9.]+) ([-0-9.]+)\)" data-type="wkt">\s*<td>[^<]*</td>\s*<td>([^<]+)</td>')
    return {name.strip(): [float(lng), float(lat)] for lng, lat, name in pattern.findall(html)}


def feature_record(feature: dict[str, Any], source: str) -> dict[str, Any]:
    properties = feature["properties"]
    if source == "clss":
        return {
            "sourceFeatureId": properties["NID"],
            "objectId": properties["OBJECTID"],
            "geometry": feature["geometry"],
            "officialHectares": None,
            "name": properties["adminAreaNameEng"],
        }
    return {
        "sourceFeatureId": properties["GlobalID"],
        "objectId": properties["OBJECTID"],
        "geometry": feature["geometry"],
        "officialHectares": properties.get("HA_OFFICIAL"),
        "name": properties["PROT_NAME"],
    }


def collect_parks(raw: dict[str, bytes]) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    nsecc = json.loads(raw["nsecc-parks.geojson"])
    clss = json.loads(raw["clss-national-parks-ns.geojson"])
    finder = parse_finder(raw["parks-canada-finder.html"].decode("utf-8"))
    parks: list[dict[str, Any]] = []
    skipped: list[dict[str, Any]] = []
    groups: dict[str, list[dict[str, Any]]] = {}
    for feature in nsecc["features"]:
        properties = feature["properties"]
        if properties["PROT_TYPE"] != PROVINCIAL_TYPE:
            continue
        if properties["LEGISLATION"] != PROVINCIAL_LEGISLATION or properties["PROT_STATUS"] != "Designated":
            raise importer.ParkImportError(f"Provincial park feature {properties['OBJECTID']} is not designated under the Provincial Parks Act")
        if feature.get("geometry") is None:
            skipped.append(
                {
                    "objectId": properties["OBJECTID"],
                    "sourceFeatureId": properties["GlobalID"],
                    "name": properties["PROT_NAME"],
                    "officialHectares": properties["HA_OFFICIAL"],
                    "reason": "The source feature has no geometry.",
                }
            )
            continue
        groups.setdefault(" ".join(properties["PROT_NAME"].split()), []).append(feature_record(feature, "nsecc"))
    for name in sorted(groups):
        parks.append(
            {
                "id": f"provincial-{slugify(name)}",
                "name": name,
                "category": "provincial",
                "sourceName": NSECC_NAME,
                "sourceUrl": NSECC_PAGE,
                "features": groups[name],
            }
        )
    by_admin = {feature["properties"]["adminAreaId"]: feature for feature in clss["features"]}
    nsecc_national: dict[str, list[dict[str, Any]]] = {}
    for feature in nsecc["features"]:
        if feature["properties"]["PROT_TYPE"].startswith("National Park") and feature.get("geometry"):
            nsecc_national.setdefault(feature["properties"]["PROT_NAME"], []).append(feature)
    cross_checks: dict[str, list[dict[str, Any]]] = {}
    for name, spec in NATIONAL_PARKS.items():
        if name not in finder:
            raise importer.ParkImportError(f"The Parks Canada finder has no row for {name}")
        park_id = f"national-{slugify(name)}"
        if spec["source"] == "clss":
            feature = by_admin.get(spec["adminAreaId"])
            if feature is None:
                raise importer.ParkImportError(f"CLSS has no {spec['adminAreaId']} boundary")
            features = [feature_record(feature, "clss")]
            source_name, source_url = CLSS_NAME, CLSS_PAGE
            cross_checks[park_id] = nsecc_national.get(NSECC_NATIONAL_NAMES[spec["adminAreaId"]], [])
        else:
            features = [feature_record(item, "nsecc") for wanted in spec["names"] for item in nsecc_national.get(wanted, [])]
            if not features:
                raise importer.ParkImportError(f"The provincial layer has no outline for {name}")
            source_name, source_url = NSECC_NAME, NSECC_PAGE
        parks.append(
            {
                "id": park_id,
                "name": name,
                "category": "national",
                "sourceName": source_name,
                "sourceUrl": source_url,
                "features": features,
                "finderPoint": finder[name],
            }
        )
    unused = sorted(set(by_admin) - {spec.get("adminAreaId") for spec in NATIONAL_PARKS.values()})
    if unused:
        raise importer.ParkImportError(f"CLSS has Nova Scotia national parks this bundle does not handle: {unused}")
    return parks, {"skippedFeatures": skipped, "nationalCrossChecks": cross_checks}


def municipality_index(collection: dict[str, Any]) -> tuple[list[tuple[dict[str, Any], Any]], Any]:
    from shapely.geometry import shape
    from shapely.strtree import STRtree
    from shapely.validation import make_valid

    rows = []
    for feature in collection["features"]:
        if feature.get("geometry"):
            value = shape(feature["geometry"])
            rows.append((feature["properties"], value if value.is_valid else make_valid(value)))
    return rows, STRtree([row[1] for row in rows])


def county_of(point: list[float], municipalities) -> dict[str, Any]:
    from shapely.geometry import Point

    rows, tree = municipalities
    location = Point(point)
    hits = [rows[int(i)][0] for i in tree.query(location) if rows[int(i)][1].covers(location)]
    if hits:
        # Towns sit inside no county unit, so a pin is in exactly one; sort for determinism anyway.
        properties = sorted(hits, key=lambda item: item["name"])[0]
        return {"county": properties["county"], "municipality": properties["name"], "countyMethod": "pin-in-municipality"}
    nearest = min(rows, key=lambda row: row[1].distance(location))
    distance = nearest[1].distance(location)
    if distance > NEAREST_MUNICIPALITY_DEGREES:
        raise importer.ParkImportError(f"Pin {point} is {distance:.3f} degrees from any municipality")
    return {"county": nearest[0]["county"], "municipality": nearest[0]["name"], "countyMethod": "nearest-municipality", "distanceDegrees": round(distance, 6)}


def region_of(county: str, municipality: str, point: list[float]) -> tuple[str, str]:
    if (county, municipality) in MUNICIPALITY_REGIONS:
        return MUNICIPALITY_REGIONS[(county, municipality)], f"municipality {municipality}, {county} County"
    if county not in COUNTY_REGIONS:
        raise importer.ParkImportError(f"County {county} has no region")
    if COUNTY_REGIONS[county] != SPLIT:
        return COUNTY_REGIONS[county], f"{county} County"
    if county == "Halifax":
        return ("Eastern Shore" if point[0] > EASTERN_SHORE_LONGITUDE else "Halifax Metro"), "Halifax County split at 63.45° W"
    return ("Northumberland Shore" if point[1] > NORTHUMBERLAND_LATITUDE else "Bay of Fundy and Annapolis Valley"), f"{county} County split at 45.55° N"


def short_for(name: str) -> str:
    return bc.short_name(NS_SHORT_NAME.sub("", name.strip()).strip())


def blurb_for(category: str, name: str, region: str) -> str:
    kind = CATEGORY_KIND[category]
    if category == "national" and name.lower().endswith("reserve"):
        kind = "national park reserve"
    article = "An" if kind[0] in "aeiou" else "A"
    return f"{article} {kind} {REGION_PHRASES[region]}."


def review_for(place: dict[str, Any], hub_count: int) -> dict[str, Any]:
    # "National Historic Site" would make Kejimkujik a heritage tile; the park part of the name decides.
    biome, _ = bc.biome_for(NS_SHORT_NAME.sub("", place["name"]))
    return {
        "presentation": {
            "short": short_for(place["name"]),
            "biome": biome,
            "shape": "circle",
            # Common is open from the first visit in every installed build.
            "rarity": "common",
            "seed": bc.seed_for(place["id"]),
            "blurb": blurb_for(place["category"], place["name"], place["region"]),
            "scene": None,
        },
        # No reviewed routes exist; the app sends visitors to Google Maps for unknown access.
        "accessUnknown": True,
        "walkM": 0,
        "drive": [None] * hub_count,
    }


def choose_pin(park: dict[str, Any], geometry: dict[str, Any], entrances: dict[str, list[dict[str, Any]]]) -> dict[str, Any]:
    if park["category"] == "national":
        point = park["finderPoint"]
        return {"point": point, "method": "parks-canada-finder", "insideOutline": bc.legacy_inside(tuple(point), geometry)}
    candidates = []
    for entrance in sorted(entrances.get(name_key(park["name"]), []), key=lambda item: (item["parkType"], item["point"])):
        point = [round(entrance["point"][0], COORDINATE_DECIMALS), round(entrance["point"][1], COORDINATE_DECIMALS)]
        candidates.append({**entrance, "point": point, "insideOutline": bc.legacy_inside(tuple(point), geometry)})
    for candidate in candidates:
        if candidate["insideOutline"]:
            return {
                "point": candidate["point"],
                "method": "official-entrance-point",
                "parkType": candidate["parkType"],
                "insideOutline": True,
                "entrancePoints": candidates,
            }
    return {"point": interior_point(geometry), "method": "interior-point-largest-part", "insideOutline": True, "entrancePoints": candidates}


def known_ids(raw: dict[str, bytes]) -> dict[str, set[str]]:
    ids: dict[str, set[str]] = {}
    for environment in CATALOGUE_HOSTS:
        index = json.loads(raw[f"{environment}-catalogue/{content_catalogue.INDEX_PATH}"])
        ids[f"live {environment} catalogue"] = {park["id"] for park in index["parks"]}
    for name in KNOWN_ID_SOURCES:
        data = (REPO / name).read_bytes()
        if name.endswith(".gz"):
            data = gzip.decompress(data)
        if name.endswith(".txt"):
            ids[name] = set(data.decode("utf-8").split())
            continue
        value = json.loads(data)
        if "selectedIds" in value:
            ids[name] = set(value["selectedIds"])
        elif "parks" in value:
            ids[name] = {park["id"] for park in value["parks"]}
        else:
            ids[name] = {feature["properties"]["id"] for feature in value["features"]}
    return ids


# Content size: readers 1 and 2 never receive these parks (reader floor 3), so
# their snapshots stay as measured. Reader 3 gets a CDN catalogue release,
# rebuilt here from the live release plus the new parks.


def live_snapshot(raw: dict[str, bytes], environment: str) -> dict[str, Any]:
    index = json.loads(raw[f"{environment}-catalogue/{content_catalogue.INDEX_PATH}"])
    features = []
    for chunk in index["boundaryChunks"]:
        features.extend(json.loads(raw[f"{environment}-catalogue/{chunk['path']}"])["features"])
    return {
        "schema": content_catalogue.CONTENT_SYNC_SCHEMA,
        "revision": index["revision"],
        "parks": index["parks"],
        "boundaries": {"type": "FeatureCollection", "features": features},
        "drive": index["drive"],
        "assets": index["assets"],
        "map": index["map"],
    }


def release_size(snapshot: dict[str, Any], parks: list[dict[str, Any]], features: list[dict[str, Any]], drive: dict[str, Any]) -> dict[str, Any]:
    full = {
        **snapshot,
        "revision": snapshot["revision"] + (1 if parks else 0),
        "parks": sorted([*snapshot["parks"], *(bc.access_fields(park) for park in parks)], key=lambda park: park["id"]),
        "boundaries": {
            "type": "FeatureCollection",
            "features": sorted([*snapshot["boundaries"]["features"], *features], key=lambda feature: feature["properties"]["id"]),
        },
        "drive": {"hubs": snapshot["drive"]["hubs"], "parks": dict(sorted({**snapshot["drive"]["parks"], **drive}.items()))},
    }
    release = content_catalogue.build_release(full)
    sizes = [item["byte_size"] for item in release["manifest"]["files"][1:]]
    return {
        "parks": len(full["parks"]),
        "indexBytes": release["pointer"]["indexBytes"],
        "chunkCount": len(sizes),
        "chunkBytesTotal": sum(sizes),
        "largestChunkBytes": max(sizes),
        "smallestChunkBytes": min(sizes),
        "version": release["pointer"]["version"],
    }


def size_projections(raw: dict[str, bytes], parks: list[dict[str, Any]], features: list[dict[str, Any]], hub_count: int) -> dict[str, Any]:
    drive = {park["id"]: {"drive": [None] * hub_count, "walkM": 0} for park in parks}
    projections: dict[str, Any] = {
        "limitBytes": MAX_SYNC_RESPONSE_BYTES,
        "minimumHeadroomBytes": MIN_SNAPSHOT_HEADROOM_BYTES,
        "minimumReader": MINIMUM_READER,
        "environments": {},
    }
    for environment in CATALOGUE_HOSTS:
        snapshot = live_snapshot(raw, environment)
        pointer = json.loads(raw[f"{environment}-snapshot-reader3.json"])["catalogue"]
        readers = {}
        for reader in (1, 2):
            body = raw[f"{environment}-snapshot-reader{reader}.json"]
            served = json.loads(body)
            readers[f"reader{reader}"] = {
                "parks": len(served["parks"]),
                "measuredBytes": len(body),
                "projectedBytes": len(body),
                "headroomBytes": MAX_SYNC_RESPONSE_BYTES - len(body),
                # What the same reader would get if these parks had no reader floor.
                "bytesWithoutReaderFloor": bc.projected_snapshot_bytes(served, parks, features, drive),
            }
        current = release_size(snapshot, [], [], {})
        projected = release_size(snapshot, parks, features, drive)
        projections["environments"][environment] = {
            "revision": snapshot["revision"],
            **readers,
            "reader3Pointer": {"measuredBytes": len(raw[f"{environment}-snapshot-reader3.json"]), "parkCount": pointer["parkCount"]},
            "reader3CatalogueNow": {**current, "liveVersion": pointer["version"], "rebuildMatchesLive": current["version"] == pointer["version"]},
            "reader3CatalogueWithNovaScotia": projected,
        }
    projections["importChangeBatchBytes"] = bc.compact_size(
        [
            {"entity": kind, "op": "upsert", "id": park["id"], "value": value}
            for park, feature in zip(parks, features)
            for kind, value in (("park", park), ("boundary", feature), ("drive", drive[park["id"]]))
        ]
    )
    return projections


def check_projections(projections: dict[str, Any]) -> None:
    for environment, entry in projections["environments"].items():
        for reader in ("reader1", "reader2"):
            if entry[reader]["headroomBytes"] < MIN_SNAPSHOT_HEADROOM_BYTES:
                raise importer.ParkImportError(f"The {environment} {reader} snapshot leaves too little content sync headroom")
        release = entry["reader3CatalogueWithNovaScotia"]
        if release["indexBytes"] > MAX_SYNC_RESPONSE_BYTES - MIN_SNAPSHOT_HEADROOM_BYTES or release["largestChunkBytes"] > MAX_CHUNK_BYTES:
            raise importer.ParkImportError(f"The {environment} catalogue release has a file that is too large")


def overlap_rows(ns_features: dict[str, dict[str, Any]], existing: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
    """Overlaps among the new parks and against every live catalogue park, both directions."""
    from shapely.geometry import shape
    from shapely.strtree import STRtree

    found = [{**row, "against": "live catalogue"} for row in bc.overlaps(ns_features, existing)]
    ids = sorted(ns_features)
    shapes = [shape(ns_features[park_id]["geometry"]) for park_id in ids]
    tree = STRtree(shapes)
    for i, park_id in enumerate(ids):
        for j in tree.query(shapes[i]):
            j = int(j)
            if j <= i:
                continue
            shared = shapes[i].intersection(shapes[j]).area
            if shared <= 0:
                continue
            first, second = shared / shapes[i].area, shared / shapes[j].area
            if max(first, second) >= OVERLAP_REPORT_FLOOR:
                found.append(
                    {
                        "newId": park_id,
                        "existingId": ids[j],
                        "shareOfNewPark": round(first, 6),
                        "shareOfExistingPark": round(second, 6),
                        "duplicate": min(first, second) >= DUPLICATE_OVERLAP,
                        "against": "Nova Scotia bundle",
                    }
                )
    return found


def build_bundle(bundle_dir: Path, raw_dir: Path) -> dict[str, Any]:
    from shapely.geometry import shape

    record, raw = read_raw(raw_dir, bundle_dir)
    parks, notes = collect_parks(raw)
    entrances: dict[str, list[dict[str, Any]]] = {}
    for feature in json.loads(raw["ns-park-entrances.geojson"])["features"]:
        name = feature["properties"]["name_full"]
        entrances.setdefault(name_key(ENTRANCE_NAME_ALIASES.get(name, name)), []).append(
            {"name": feature["properties"]["name_full"], "parkType": feature["properties"]["park_type"], "point": feature["geometry"]["coordinates"]}
        )
    municipalities = municipality_index(json.loads(raw["ns-municipalities.geojson"]))
    nstdb = json.loads(raw["nstdb-park-delimiters.json"])
    nstdb_keys = {name_key(item["name"]): item["name"] for item in nstdb}
    staging_index = json.loads(raw[f"staging-catalogue/{content_catalogue.INDEX_PATH}"])
    production_index = json.loads(raw[f"production-catalogue/{content_catalogue.INDEX_PATH}"])
    if staging_index["drive"]["hubs"] != production_index["drive"]["hubs"]:
        raise importer.ParkImportError("Staging and production drive hubs differ; new-park reviews need one hub list")
    hub_count = len(staging_index["drive"]["hubs"])

    places: dict[str, dict[str, Any]] = {}
    geometries: dict[str, dict[str, Any]] = {}
    rows: dict[str, dict[str, Any]] = {}
    normalization_reports: list[dict[str, Any]] = []
    for park in parks:
        park_id = park["id"]
        if park_id in places:
            raise importer.ParkImportError(f"Two Nova Scotia parks share the ID {park_id}")
        geometry, assembled = assemble(park_id, park["features"])
        normalization_reports.extend(assembled["normalizations"])
        pin = choose_pin(park, geometry, entrances)
        placement = PARK_REGION_OVERRIDES.get(park_id)
        if placement:
            region, rule = placement["region"], f"override: {placement['reason']}"
            where = {"county": placement["county"], "municipality": placement["municipality"], "countyMethod": "override"}
        else:
            where = county_of(pin["point"], municipalities)
            region, rule = region_of(where["county"], where["municipality"], pin["point"])
        places[park_id] = {
            "id": park_id,
            "name": park["name"],
            "category": park["category"],
            "latitude": pin["point"][1],
            "longitude": pin["point"][0],
            "region": region,
            "description": blurb_for(park["category"], park["name"], region),
            "sourceUrl": park["sourceUrl"],
            "sourceName": park["sourceName"],
            "sourceId": park["features"][0]["sourceFeatureId"],
            "county": where["county"],
            "pinSource": pin["method"],
        }
        geometries[park_id] = geometry
        official = [feature["officialHectares"] for feature in park["features"]]
        rows[park_id] = {
            "id": park_id,
            "name": park["name"],
            "category": park["category"],
            "sourceName": park["sourceName"],
            "sourceFeatureIds": [feature["sourceFeatureId"] for feature in park["features"]],
            **assembled["evidence"],
            "officialHectares": round(sum(official), 3) if all(value is not None for value in official) else None,
            "pin": pin,
            "placement": {**where, "region": region, "rule": rule},
            "probes": bc.containment_probes(geometry),
        }
        if park["category"] == "provincial":
            rows[park_id]["topographicDatabaseName"] = nstdb_keys.get(name_key(TOPOGRAPHIC_NAME_VARIANTS.get(park["name"], park["name"])))

    # National parks: compare the legislative outline with the provincial layer's copy.
    for park_id, features in notes["nationalCrossChecks"].items():
        from shapely.ops import unary_union

        if not features:
            continue
        other = unary_union([shape(multipolygon(normalize_feature(f["geometry"], park_id)[0])) for f in features])
        ours = shape(geometries[park_id])
        rows[park_id]["provincialLayerComparison"] = {
            "objectIds": [f["properties"]["OBJECTID"] for f in features],
            "provincialLayerHectares": round(local_hectares(other), 3),
            "clssHectares": round(local_hectares(ours), 3),
            "symmetricDifferenceRatio": round(ours.symmetric_difference(other).area / ours.area, 6),
            "provincialAreaOutsideClssHectares": round(local_hectares(other.difference(ours)), 3),
        }

    # Identity: no new ID may clash with any current or past catalogue ID.
    existing_ids = known_ids(raw)
    clashes = {label: sorted(ids & set(places)) for label, ids in existing_ids.items() if ids & set(places)}
    if clashes:
        raise importer.ParkImportError(f"Nova Scotia IDs clash with existing parks: {clashes}")

    existing_features: dict[str, dict[str, Any]] = {}
    for environment in ("production", "staging"):
        for feature in live_snapshot(raw, environment)["boundaries"]["features"]:
            existing_features[feature["properties"]["id"]] = feature
    ns_features = {park_id: {"geometry": geometry} for park_id, geometry in geometries.items()}
    overlap_report = overlap_rows(ns_features, existing_features)
    duplicates = sorted({row["newId"] for row in overlap_report if row["duplicate"] and row["against"] == "live catalogue"})
    internal = [row for row in overlap_report if row["duplicate"] and row["against"] == "Nova Scotia bundle"]
    if internal:
        raise importer.ParkImportError(f"Nova Scotia parks duplicate each other and need a pinned decision: {internal}")
    selected = sorted(park_id for park_id in places if park_id not in duplicates)

    counts_by_category = {category: sum(1 for i in selected if places[i]["category"] == category) for category in ("provincial", "national")}
    if counts_by_category != {"provincial": EXPECTED_PROVINCIAL, "national": EXPECTED_NATIONAL}:
        raise importer.ParkImportError(f"Unexpected park counts {counts_by_category}")

    boundary_features = []
    for park_id in selected:
        park = next(item for item in parks if item["id"] == park_id)
        boundary_features.append(
            {
                "type": "Feature",
                "properties": {
                    "id": park_id,
                    "name": park["name"],
                    "category": park["category"],
                    "sourceName": park["sourceName"],
                    "sourceUrl": park["sourceUrl"],
                    "sourceId": park["features"][0]["sourceFeatureId"],
                    "sourceObjectIds": [feature["sourceFeatureId"] for feature in park["features"]],
                    "sourceLayerObjectIds": [feature["objectId"] for feature in park["features"]],
                },
                "geometry": geometries[park_id],
            }
        )
    records = importer.parse_boundary_source({"type": "FeatureCollection", "features": boundary_features})

    hubs = [{"position": index} for index in range(hub_count)]
    reviews: dict[str, dict[str, Any]] = {}
    wire_parks, wire_features = [], []
    for park_id in selected:
        review = review_for(places[park_id], hub_count)
        park, _ = importer.validate_new_park(park_id, park_id, places[park_id], review, hubs)
        reviews[park_id] = review
        wire_parks.append(park)
        wire_features.append({"type": "Feature", "properties": {"id": park_id, "biome": park["biome"]}, "geometry": records[park_id]["geometry"]})
        rows[park_id]["status"] = "new"
        rows[park_id]["polygonsMatch"] = rows[park_id]["outputCounts"]["polygons"] == rows[park_id]["sourceCounts"]["polygons"]
        rows[park_id]["holesMatch"] = rows[park_id]["outputCounts"]["holes"] == rows[park_id]["sourceCounts"]["holes"]
    for park_id in duplicates:
        rows[park_id]["status"] = "excluded-duplicate"

    projections = size_projections(raw, wire_parks, wire_features, hub_count)
    check_projections(projections)

    attributes = json.loads(raw["nsecc-attributes.json"])["features"]
    left_out: dict[str, int] = {}
    for item in attributes:
        kind = item["attributes"]["PROT_TYPE"]
        if kind != PROVINCIAL_TYPE:
            left_out[kind] = left_out.get(kind, 0) + 1
    outline_keys = {name_key(park["name"]) for park in parks}
    entrance_only = sorted({entry["name"] for key, items in entrances.items() if key not in outline_keys for entry in items})
    selection = {
        "schema": "parkdex.ns-import-selection.v1",
        "selectedCount": len(selected),
        "categories": counts_by_category,
        "minimumReader": MINIMUM_READER,
        "delivery": "Every new park gets reader floor 3: readers 1 and 2 keep today's snapshot, and reader 3 loads the whole catalogue from a CDN release.",
        "scope": {
            "provincial": f"Features of the Parks and Protected Areas System layer with PROT_TYPE '{PROVINCIAL_TYPE}', designated under the {PROVINCIAL_LEGISLATION}, grouped by name.",
            "national": sorted(NATIONAL_PARKS),
        },
        "excluded": {
            "otherProtectedAreaTypes": {
                "reason": "Wilderness areas, nature reserves, land trust properties and national wildlife areas are out of scope for now.",
                "featureCounts": dict(sorted(left_out.items())),
            },
            "featuresWithoutGeometry": {
                "reason": "The source feature has no geometry; its park keeps its other features.",
                "features": notes["skippedFeatures"],
            },
            "entrancePointsWithoutOutline": {
                "reason": "The province lists a day-use or camping entrance but no Provincial Parks Act outline, so there is no boundary to check a visit against.",
                "names": entrance_only,
            },
            "nationalHistoricSites": {"reason": "National historic sites, such as Louisbourg, are out of scope."},
            "duplicates": {"reason": f"At least {DUPLICATE_OVERLAP:.0%} of both footprints overlap a live catalogue park.", "ids": duplicates},
        },
        "regions": {
            "names": list(REGIONS),
            "countyRegions": COUNTY_REGIONS,
            "splitRules": SPLIT_RULES,
            "municipalityRegions": {f"{municipality} ({county})": region for (county, municipality), region in MUNICIPALITY_REGIONS.items()},
            "parkOverrides": {park_id: item for park_id, item in PARK_REGION_OVERRIDES.items()},
        },
        "idClashCheck": {label: len(ids) for label, ids in existing_ids.items()},
    }
    outputs, boundaries_raw = write_outputs(
        bundle_dir, places, selected, reviews, records, boundary_features, selection, rows, normalization_reports, overlap_report
    )
    selected_rows = [rows[park_id] for park_id in selected]
    manifest = {
        "schema": SCHEMA,
        "fetchRecord": {
            "file": "sources/fetch-record.json",
            "fetchedAt": record["fetchedAt"],
            "sha256": sha256((bundle_dir / "sources" / "fetch-record.json").read_bytes()),
        },
        "sources": {name: {"sha256": entry["sha256"], "bytes": entry["bytes"]} for name, entry in record["sources"].items()},
        "outputs": {name: {"sha256": sha256(data), "bytes": len(data)} for name, data in outputs.items()},
        "boundaries": {"file": BOUNDARIES_FILE, "decompressedSha256": sha256(boundaries_raw), "decompressedBytes": len(boundaries_raw)},
        "counts": {
            "selected": len(selected),
            "categories": counts_by_category,
            "regions": dict(sorted(_tally(places[i]["region"] for i in selected).items())),
            "counties": dict(sorted(_tally(places[i]["county"] for i in selected).items())),
            "biomes": dict(sorted(_tally(reviews[i]["presentation"]["biome"] for i in selected).items())),
            "pins": dict(sorted(_tally(places[i]["pinSource"] for i in selected).items())),
            "sourceFeatures": sum(len(row["sourceFeatures"]) for row in selected_rows),
            "normalizedSourceFeatures": sum(1 for row in selected_rows for item in row["sourceFeatures"] if not item["sourceValid"]),
            "unionedParks": sum(1 for row in selected_rows if row["assembly"].startswith("source-feature-union")),
            "multiPartParks": sum(1 for row in selected_rows if row["outputCounts"]["polygons"] > 1),
            "parksWithHoles": sum(1 for row in selected_rows if row["outputCounts"]["holes"] > 0),
            "geometryTotals": {
                "parts": sum(row["outputCounts"]["polygons"] for row in selected_rows),
                "holes": sum(row["outputCounts"]["holes"] for row in selected_rows),
                "positions": sum(row["outputCounts"]["positions"] for row in selected_rows),
            },
            "byCategory": {
                category: {
                    "parks": counts_by_category[category],
                    "parts": sum(row["outputCounts"]["polygons"] for row in selected_rows if row["category"] == category),
                    "holes": sum(row["outputCounts"]["holes"] for row in selected_rows if row["category"] == category),
                }
                for category in ("provincial", "national")
            },
            "coverageAtLeast99_9Percent": sum(1 for row in selected_rows if row["coverage"]["sourceAreaKept"] >= MIN_AREA_KEPT),
            "officialAreaWithinTolerance": sum(
                1 for row in selected_rows if row["officialHectares"] is None or abs(row["hectares"] / row["officialHectares"] - 1) <= OFFICIAL_AREA_TOLERANCE
            ),
            "duplicatesExcluded": len(duplicates),
            "overlapsReported": len(overlap_report),
            "entrancePointsWithoutOutline": len(entrance_only),
        },
        "contentSyncProjection": projections,
        "presentationRules": {
            "short": "Name without a trailing park-type phrase such as Provincial Park, National Park Reserve or National Park and National Historic Site.",
            "biome": "First matching name keyword in BIOME_RULES of scripts/build_bc_import.py (ignoring 'and National Historic Site'), otherwise forest.",
            "shape": "circle",
            "rarity": "common",
            "seed": "First 8 bytes of SHA-256 of the park ID, modulo 1,000,001.",
            "blurb": "A factual line such as 'A provincial park on Nova Scotia's South Shore.'",
            "scene": None,
            "access": "accessUnknown true, walkM 0 and null for every drive hub.",
            "pin": "National: the Parks Canada finder point. Provincial: the official entrance point when one lies inside the outline, otherwise a point inside the largest part.",
            "coordinates": f"Rounded to {COORDINATE_DECIMALS} decimal places (under 1 cm); no simplification, every part and hole kept.",
        },
        "publication": {"providerActions": False, "databaseWrites": False, "badgeArtworkIncluded": False},
    }
    manifest_raw = json_bytes(manifest)
    (bundle_dir / "manifest.json").write_bytes(manifest_raw)
    return {
        "bundleDir": str(bundle_dir.resolve()),
        "selected": len(selected),
        "categories": counts_by_category,
        "geometryTotals": manifest["counts"]["geometryTotals"],
        "manifestSha256": sha256(manifest_raw),
        "contentSyncProjection": projections,
    }


def _tally(values) -> dict[str, int]:
    result: dict[str, int] = {}
    for value in values:
        result[value] = result.get(value, 0) + 1
    return result


def write_outputs(
    bundle_dir, places, selected, reviews, records, boundary_features, selection, rows, normalization_reports, overlap_report
) -> tuple[dict[str, bytes], bytes]:
    files: dict[str, bytes] = {
        "selection.json": json_bytes(selection),
        "catalogue.json": json_bytes([places[park_id] for park_id in selected]),
        "comparison-report.json": json_bytes({"schema": "parkdex.ns-boundary-comparison.v1", "parks": [rows[park_id] for park_id in sorted(rows)]}),
        "normalization.json": json_bytes(
            {
                "methods": {
                    "planar-face-even-odd-all-rings": "An invalid source feature is rebuilt from the planar faces of all its rings; a face is inside when an odd number of rings contain it.",
                    "source-feature-union": "The source features of one park touch or overlap, so the park is their union.",
                },
                "parks": normalization_reports,
            }
        ),
        "overlaps.json": json_bytes({"duplicateThreshold": DUPLICATE_OVERLAP, "reportFloor": OVERLAP_REPORT_FLOOR, "overlaps": overlap_report}),
        "park-ids.txt": ("\n".join(selected) + "\n").encode("utf-8"),
        "new-park-review.json": json_bytes({"parks": {park_id: reviews[park_id] for park_id in selected}}),
    }
    by_id = {feature["properties"]["id"]: feature for feature in boundary_features}
    # Importer input: one feature per park with its source provenance.
    boundaries_raw = bc.json_bytes({"type": "FeatureCollection", "features": [by_id[park_id] for park_id in selected]}, compact=True)
    for name, data in files.items():
        (bundle_dir / name).write_bytes(data)
    (bundle_dir / BOUNDARIES_FILE).write_bytes(gzip.compress(boundaries_raw, compresslevel=9, mtime=0))
    return files, boundaries_raw


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("fetch", "build"))
    parser.add_argument("--raw", type=Path, required=True, help="Folder for the raw downloads, outside the repository")
    parser.add_argument("--bundle-dir", type=Path, default=DEFAULT_BUNDLE)
    args = parser.parse_args(argv)
    try:
        if args.command == "fetch":
            result = fetch(args.raw.resolve(), args.bundle_dir.resolve())
        else:
            result = build_bundle(args.bundle_dir.resolve(), args.raw.resolve())
    except importer.ParkImportError as exc:
        print(f"Nova Scotia import bundle: {exc}", file=sys.stderr)
        return 2
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
