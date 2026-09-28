#!/usr/bin/env python3
"""Publish one immutable Parkdex badge and one park metadata update."""
from __future__ import annotations

import argparse
from dataclasses import dataclass
import hashlib
from io import BytesIO
import json
import math
import os
from pathlib import Path
import re
import sys
from urllib.parse import quote

import cloud_content
import publish_content
import requests

CDN_ORIGIN = "https://kip-assets.parkdex.app"
PARK_FIELDS = cloud_content.PARK_FIELDS
PARK_MUTABLE_FIELDS = ("blurb", "rarity", "scene")
PARK_RARITIES = {"common", "uncommon", "rare", "epic", "legendary"}
MAX_BADGE_BYTES = 4 * 1024 * 1024
SCENE_SLUG = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")


class PublishError(ValueError):
    """An operator input or publication failure with safe user-facing text."""


@dataclass(frozen=True)
class ParkUpdate:
    park_id: str
    fields: dict[str, object]
    expected: dict[str, object]
    full_record: dict[str, object] | None


def load_park_update(path: Path) -> ParkUpdate:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise PublishError(f"Could not read park update JSON ({type(exc).__name__})") from None

    if not isinstance(value, dict):
        raise PublishError("Park update JSON must be an object")

    if "park" in value:
        if set(value) - {"park", "expected"}:
            raise PublishError("Update envelope accepts only park and expected")
        park = value.get("park")
        expected = value.get("expected", {})
    else:
        park = value
        expected = {}

    if not isinstance(park, dict):
        raise PublishError("park must be an object")
    if not isinstance(expected, dict) or set(expected) - set(PARK_MUTABLE_FIELDS):
        raise PublishError("expected accepts only blurb, rarity, and scene")

    is_full = set(park) == set(PARK_FIELDS)
    allowed_partial = {"id", *PARK_MUTABLE_FIELDS}
    if not is_full and ("id" not in park or set(park) - allowed_partial):
        raise PublishError("Provide all 13 park fields or only id, blurb, rarity, and scene")

    park_id = park.get("id")
    if not isinstance(park_id, str) or not park_id.strip():
        raise PublishError("park.id must be a non-empty string")

    full_record: dict[str, object] | None = dict(park) if is_full else None
    if is_full:
        _validate_full_park(park)

    fields = {key: park[key] for key in PARK_MUTABLE_FIELDS if key in park}
    _validate_editable_fields(fields, label="park")
    _validate_editable_fields(expected, label="expected")

    if not fields:
        raise PublishError("Park update must include blurb, rarity, or scene")

    return ParkUpdate(park_id=park_id, fields=fields, expected=dict(expected), full_record=full_record)


def _validate_full_park(park: dict[str, object]) -> None:
    if set(park) != set(PARK_FIELDS):
        raise PublishError("Full park update must contain exactly the 13 current park fields")
    for key in ("name", "short", "category", "region", "biome", "shape", "rarity", "blurb"):
        if not isinstance(park[key], str):
            raise PublishError(f"park.{key} must be a string")
    for key, minimum, maximum in (("lat", -90, 90), ("lng", -180, 180)):
        item = park[key]
        if isinstance(item, bool) or not isinstance(item, (int, float)) or not math.isfinite(item) or not minimum <= item <= maximum:
            raise PublishError(f"park.{key} must be a finite coordinate in range")
    seed = park["seed"]
    if isinstance(seed, bool) or not isinstance(seed, int):
        raise PublishError("park.seed must be an integer")
    scene = park["scene"]
    if scene is not None and not isinstance(scene, str):
        raise PublishError("park.scene must be a string or null")


def _validate_editable_fields(fields: dict[str, object], label: str) -> None:
    if "blurb" in fields:
        if not isinstance(fields["blurb"], str) or (label != "expected" and not fields["blurb"].strip()):
            raise PublishError(f"{label}.blurb must be a non-empty string")
    if "rarity" in fields and (not isinstance(fields["rarity"], str) or fields["rarity"] not in PARK_RARITIES):
        raise PublishError(f"{label}.rarity must be one of {', '.join(sorted(PARK_RARITIES))}")
    if "scene" in fields and fields["scene"] is not None and not isinstance(fields["scene"], str):
        raise PublishError(f"{label}.scene must be a string or null")
    if "scene" in fields and isinstance(fields["scene"], str) and not SCENE_SLUG.fullmatch(fields["scene"]):
        raise PublishError(f"{label}.scene must be a lowercase hyphenated slug")


def asset_descriptor(park_update: ParkUpdate, image_path: Path | None) -> dict[str, object] | None:
    if image_path is None:
        return None
    scene = park_update.fields.get("scene")
    if not isinstance(scene, str) or not SCENE_SLUG.fullmatch(scene):
        raise PublishError("A badge image requires park.scene to be a lowercase hyphenated slug")
    path = image_path.resolve()
    if not path.is_file() or path.suffix.lower() != ".webp":
        raise PublishError("Selected badge must be an existing .webp file")
    try:
        file_size = path.stat().st_size
    except OSError as exc:
        raise PublishError(f"Could not read selected badge ({type(exc).__name__})") from None
    if file_size > MAX_BADGE_BYTES:
        raise PublishError(f"Selected badge exceeds the {MAX_BADGE_BYTES // (1024 * 1024)} MiB delivery limit")
    try:
        data = path.read_bytes()
    except OSError as exc:
        raise PublishError(f"Could not read selected badge ({type(exc).__name__})") from None
    if len(data) != file_size:
        raise PublishError("Selected badge changed while it was being read")
    _validate_webp(data)

    digest = hashlib.sha256(data).hexdigest()
    logical_path = f"art/badges/scenes/{scene}.webp"
    object_key = f"releases/{digest}/art/badges/scenes/{scene}.webp"
    return {
        "path": logical_path,
        "logical_path": logical_path,
        "key": object_key,
        "object_key": object_key,
        "url": CDN_ORIGIN + "/" + quote(object_key, safe="/"),
        "sha256": digest,
        "byte_size": len(data),
        "content_type": "image/webp",
    }


def _validate_webp(data: bytes) -> None:
    """Require a complete image that the WebP decoder can read, not just a RIFF header."""
    try:
        from PIL import Image
    except ImportError:
        raise PublishError("Pillow is required to validate selected WebP badges") from None

    try:
        with Image.open(BytesIO(data)) as image:
            if image.format != "WEBP":
                raise PublishError("Selected badge is not encoded as WebP")
            image.load()
    except PublishError:
        raise
    except Exception as exc:
        raise PublishError(f"Selected badge is not a decodable WebP image ({type(exc).__name__})") from None


def update_in_transaction(conn, park_update: ParkUpdate, asset: dict[str, object] | None) -> str:
    """Register an immutable descriptor and edit one park in the same transaction."""
    with conn.transaction():
        with conn.cursor() as cursor:
            cursor.execute(
                """
                SELECT id, name, short, category, region, lat, lng, biome, shape, rarity, scene, seed, blurb
                  FROM public.parks
                 WHERE id = %s
                 FOR UPDATE
                """,
                (park_update.park_id,),
            )
            row = cursor.fetchone()
            if row is None:
                raise PublishError(f"Park not found: {park_update.park_id}")
            current = dict(zip(PARK_FIELDS, row, strict=True))
            desired = _desired_values(park_update, current, has_badge=asset is not None)

            existing_asset = None
            if asset is not None:
                cursor.execute(
                    """
                    SELECT logical_path, object_key, url, sha256, byte_size, content_type
                      FROM public.r2_objects
                     WHERE logical_path = %s
                    """,
                    (asset["logical_path"],),
                )
                existing_asset = cursor.fetchone()
                if existing_asset is not None and not _descriptor_matches(existing_asset, asset):
                    raise PublishError("That scene slug already names a different immutable badge; use a new slug")

            changed_fields = [
                field for field in PARK_MUTABLE_FIELDS
                if field in desired and current[field] != desired[field]
            ]
            if not changed_fields and (asset is None or existing_asset is not None):
                return "already-current"

            _check_expected(park_update.expected, current)

            asset_inserted = False
            if asset is not None and existing_asset is None:
                descriptor_row = {
                    key: asset[key]
                    for key in ("logical_path", "object_key", "url", "sha256", "byte_size", "content_type")
                }
                cursor.execute(
                    """
                    INSERT INTO public.r2_objects
                        (logical_path, object_key, url, sha256, byte_size, content_type)
                    VALUES (%(logical_path)s, %(object_key)s, %(url)s, %(sha256)s, %(byte_size)s, %(content_type)s)
                    ON CONFLICT (logical_path) DO NOTHING
                    """,
                    descriptor_row,
                )
                asset_inserted = True
                cursor.execute(
                    """
                    SELECT logical_path, object_key, url, sha256, byte_size, content_type
                      FROM public.r2_objects
                     WHERE logical_path = %s
                    """,
                    (asset["logical_path"],),
                )
                inserted_asset = cursor.fetchone()
                if inserted_asset is None or not _descriptor_matches(inserted_asset, asset):
                    raise PublishError("Database has a conflicting immutable badge descriptor")

            if changed_fields:
                assignments = ", ".join(f"{field} = %({field})s" for field in changed_fields)
                parameters = {field: desired[field] for field in changed_fields}
                parameters["id"] = park_update.park_id
                cursor.execute(f"UPDATE public.parks SET {assignments} WHERE id = %(id)s", parameters)
                if cursor.rowcount != 1:
                    raise PublishError("Park row changed during publication")
                return "updated"
            return "asset-registered" if asset_inserted else "already-current"


def _desired_values(park_update: ParkUpdate, current: dict[str, object], has_badge: bool) -> dict[str, object]:
    if park_update.full_record is not None:
        ignored_changes = [
            field for field in PARK_FIELDS
            if field not in {"id", *PARK_MUTABLE_FIELDS} and park_update.full_record[field] != current[field]
        ]
        if ignored_changes:
            fields = ", ".join(ignored_changes)
            raise PublishError(f"This publisher only changes blurb, rarity, and scene; these full-record fields differ from the database: {fields}")

    desired = dict(park_update.fields)
    if has_badge:
        scene = desired.get("scene")
        if not isinstance(scene, str) or not SCENE_SLUG.fullmatch(scene):
            raise PublishError("Badge updates require a new park.scene slug")
    elif "scene" in desired and desired["scene"] != current["scene"]:
        raise PublishError("Changing park.scene requires a selected WebP badge")
    return desired


def _check_expected(expected: dict[str, object], current: dict[str, object]) -> None:
    mismatches = [field for field, value in expected.items() if current[field] != value]
    if mismatches:
        raise PublishError("Park changed since this update was prepared; expected values do not match: " + ", ".join(mismatches))


def _descriptor_matches(row, asset: dict[str, object]) -> bool:
    actual = dict(zip(("logical_path", "object_key", "url", "sha256", "byte_size", "content_type"), row, strict=True))
    expected = {key: asset[key] for key in actual}
    return actual == expected


def apply_database_update(database_url: str, park_update: ParkUpdate, asset: dict[str, object] | None) -> str:
    try:
        import psycopg
    except ImportError:
        raise PublishError("psycopg is required; install database/requirements.txt") from None
    try:
        with psycopg.connect(database_url) as conn:
            return update_in_transaction(conn, park_update, asset)
    except PublishError:
        raise
    except psycopg.Error as exc:
        raise PublishError(f"Database operation failed ({type(exc).__name__})") from None


def run(args: argparse.Namespace) -> dict[str, object]:
    park_update = load_park_update(args.park_json)
    image_path = args.badge_webp
    asset = asset_descriptor(park_update, image_path)
    plan: dict[str, object] = {
        "mode": "apply" if args.apply else "dry-run",
        "park_id": park_update.park_id,
        "changes": dict(park_update.fields),
        "asset": None if asset is None else {
            "logical_path": asset["logical_path"],
            "object_key": asset["object_key"],
            "url": asset["url"],
            "sha256": asset["sha256"],
            "byte_size": asset["byte_size"],
            "content_type": asset["content_type"],
        },
        "asset_upload": "not-run" if asset is not None else "not-needed",
        "cdn_verification": "not-run" if asset is not None else "not-needed",
        "database_writes": False,
    }
    if not args.apply:
        plan["next_step"] = "Rerun with --apply to publish this update"
        return plan

    database_url = os.environ.get("DATABASE_URL")
    if not database_url:
        raise PublishError("Set DATABASE_URL in the environment before using --apply")

    upload_result = None
    if asset is not None:
        if not args.account_id or not args.bucket:
            raise PublishError("Badge uploads require --account-id and --bucket")
        token = publish_content.token_from(args)
        base = f"https://api.cloudflare.com/client/v4/accounts/{args.account_id}/r2/buckets/{args.bucket}/objects"
        try:
            upload_result = publish_content.upload_one(asset, image_path.resolve(), base, token)
            cdn_result = publish_content.verify_one(asset, image_path.resolve())
        except requests.RequestException as exc:
            raise PublishError(f"Upload or CDN verification failed ({type(exc).__name__})") from None
        except (RuntimeError, ValueError) as exc:
            raise PublishError(str(exc)) from None
        plan["asset_upload"] = upload_result["status"]
        plan["cdn_verification"] = {key: cdn_result[key] for key in ("status", "sha256", "byte_size")}

    result = apply_database_update(database_url, park_update, asset)
    plan["database_writes"] = result != "already-current"
    plan["database_result"] = result
    return plan


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--park-json", required=True, type=Path, help="one direct or wrapped park update JSON object")
    parser.add_argument("--badge-webp", type=Path, help="selected badge WebP; omit for blurb or rarity only")
    parser.add_argument("--account-id", help="Cloudflare account ID, required only for badge upload")
    parser.add_argument("--bucket", help="R2 bucket name, required only for badge upload")
    parser.add_argument("--wrangler-config", type=Path, help="optional Wrangler config containing oauth_token")
    parser.add_argument("--apply", action="store_true", help="upload and commit; default is a local-only dry run")
    return parser


def main() -> int:
    args = build_parser().parse_args()
    try:
        result = run(args)
    except (PublishError, RuntimeError) as exc:
        print(str(exc), file=sys.stderr)
        return 1
    except Exception as exc:
        # Do not print unexpected exception text because drivers can include connection details.
        print(f"Publication failed ({type(exc).__name__})", file=sys.stderr)
        return 1
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
