"""Plan or publish the reviewed Victoria 100 rarity downshift in one content revision.

The active Neon catalogue is authoritative. This command never edits the rollout
seed, claims, badge scenes, or immutable assets. Apply requires a reviewed plan
hash and the exact content revision observed during planning.
"""
from __future__ import annotations

import argparse
from collections import Counter
import hashlib
import json
import os
from pathlib import Path
import re
from urllib.parse import unquote, urlsplit


ROOT = Path(__file__).resolve().parents[1]
ASSIGNMENT = ROOT / "database/catalogue/victoria-rarities-20260928.json"
TRANSITION = ROOT / "database/catalogue/victoria-rarity-downshift-20260928.json"
SEED = ROOT / "database/seeds/victoria-100-20260927/victoria-100-seed-v1.json"
SHIFT = {"common": "common", "uncommon": "common", "rare": "uncommon", "legendary": "rare"}
SOURCE_COUNTS = {"common": 59, "uncommon": 30, "rare": 10, "legendary": 1}
TARGET_COUNTS = {"common": 89, "uncommon": 10, "rare": 1, "legendary": 0}


class DownshiftError(RuntimeError):
    pass


def load_plan() -> tuple[dict[str, str], dict[str, str], list[dict[str, str]]]:
    assignment = json.loads(ASSIGNMENT.read_text(encoding="utf-8"))
    transition = json.loads(TRANSITION.read_text(encoding="utf-8"))
    seed = json.loads(SEED.read_text(encoding="utf-8"))
    if assignment.get("schema") != "parkdex.rarity-assignment/v1" or assignment.get("environment") != "staging":
        raise DownshiftError("unexpected rarity assignment schema or environment")
    if transition.get("schema") != "parkdex.rarity-downshift/v1" or transition.get("environment") != "staging":
        raise DownshiftError("unexpected downshift schema or environment")
    if transition.get("source_counts") != SOURCE_COUNTS or transition.get("target_counts") != TARGET_COUNTS:
        raise DownshiftError("downshift counts changed")
    if assignment.get("counts") != TARGET_COUNTS:
        raise DownshiftError("target assignment counts changed")
    parks = assignment.get("parks")
    changes = transition.get("changes")
    if not isinstance(parks, list) or not isinstance(changes, list) or len(parks) != 100 or len(changes) != 41:
        raise DownshiftError("assignment must have 100 parks and 41 changes")
    seed_ids = [park["id"] for park in seed["parks"]]
    target = {park["id"]: park["rarity"] for park in parks}
    if len(target) != 100 or list(target) != seed_ids:
        raise DownshiftError("assignment does not match the immutable ranked seed")
    expected = dict(target)
    seen: set[str] = set()
    for change in changes:
        if set(change) != {"id", "from", "to"} or change["id"] in seen:
            raise DownshiftError("downshift has duplicate or malformed changes")
        park_id, before, after = change["id"], change["from"], change["to"]
        if park_id not in target or before not in SHIFT or SHIFT[before] != after or before == after or target[park_id] != after:
            raise DownshiftError(f"invalid rarity transition for {park_id}")
        expected[park_id] = before
        seen.add(park_id)
    if dict(Counter(expected.values())) != {key: value for key, value in SOURCE_COUNTS.items() if value}:
        raise DownshiftError("source rarity counts do not match the reviewed assignment")
    if dict(Counter(target.values())) != {key: value for key, value in TARGET_COUNTS.items() if value}:
        raise DownshiftError("target rarity counts do not match the reviewed assignment")
    if {park_id for park_id in expected if expected[park_id] != target[park_id]} != seen:
        raise DownshiftError("transition omits a changed park")
    return expected, target, changes


def database_identity(database_url: str, expected_host: str, target: str, pull_request: int | None) -> None:
    uri = urlsplit(database_url)
    if uri.scheme not in {"postgres", "postgresql"} or not uri.hostname or not uri.username or uri.password is None:
        raise DownshiftError("DATABASE_URL must be a complete PostgreSQL URI")
    if uri.hostname.lower().rstrip(".") != expected_host.lower().rstrip("."):
        raise DownshiftError("database host differs from --expected-database-host")
    database, role = unquote(uri.path.lstrip("/")), unquote(uri.username)
    if target == "staging":
        if pull_request is not None or database != "parkdex_kip" or role != "parkdex_kip_owner":
            raise DownshiftError("staging requires the configured database and owner role")
    elif target == "owned-preview":
        if pull_request is None or pull_request < 1:
            raise DownshiftError("owned-preview requires --pull-request")
        match = re.fullmatch(rf"kip_preview_{pull_request}_([a-f0-9]{{10}})", database)
        if not match or role != f"kip_pr_{pull_request}_{match.group(1)}":
            raise DownshiftError("database and owner role do not match the owned PR preview")
    else:
        raise DownshiftError("target must be staging or owned-preview")


def plan_hash(revision: int, changes: list[dict[str, str]]) -> str:
    raw = json.dumps({"revision": revision, "changes": changes}, sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(raw).hexdigest()


def verify_rollout_receipt(receipt: tuple[str, str | None, str] | None, target: str,
                           pull_request: int | None, expected_host: str) -> None:
    if receipt is None:
        raise DownshiftError("the immutable Victoria 100 rollout receipt is missing")
    environment, target_id, host = receipt
    expected_id = str(pull_request) if target == "owned-preview" else None
    if environment != target or target_id != expected_id or host.lower().rstrip(".") != expected_host.lower().rstrip("."):
        raise DownshiftError("the immutable Victoria 100 rollout receipt does not identify this target")


def run(args: argparse.Namespace) -> dict[str, object]:
    expected, target, changes = load_plan()
    database_url = os.environ.get("DATABASE_URL")
    if not database_url:
        raise DownshiftError("set DATABASE_URL in the process environment")
    database_identity(database_url, args.expected_database_host, args.target, args.pull_request)
    import psycopg

    with psycopg.connect(database_url) as conn:
        with conn.cursor() as cursor:
            if args.apply:
                cursor.execute("SELECT pg_advisory_xact_lock(58297261004101)")
            # The authoring queue locks this singleton before freezing art.
            # Hold the same lock through the job check and park updates.
            cursor.execute("SELECT target_environment, target_id, database_host FROM public.park_enrichment_rollout WHERE singleton = true FOR UPDATE")
            verify_rollout_receipt(cursor.fetchone(), args.target, args.pull_request, args.expected_database_host)
            cursor.execute("SELECT id, rarity FROM public.parks ORDER BY id FOR UPDATE")
            actual = dict(cursor.fetchall())
            cursor.execute("SELECT revision FROM public.content_clock WHERE singleton = true FOR UPDATE")
            row = cursor.fetchone()
            if row is None:
                raise DownshiftError("content sync clock is missing")
            revision = row[0]
            cursor.execute("SELECT park_id FROM public.park_enrichment_jobs WHERE selected_art IS NOT NULL AND state <> 'published' ORDER BY park_id")
            selected = [row[0] for row in cursor.fetchall()]
            if selected:
                raise DownshiftError(f"unpublished frozen authoring art exists for {len(selected)} park(s); let it publish or reconcile it before changing rarities")
            if actual == target:
                return {"status": "already_applied", "revision": revision, "park_count": 100}
            if actual != expected:
                mismatched = sorted(park_id for park_id in set(actual) | set(expected) if actual.get(park_id) != expected.get(park_id))
                raise DownshiftError(f"live catalogue differs from reviewed source for {len(mismatched)} park(s): {mismatched[:5]}")
            digest = plan_hash(revision, changes)
            result: dict[str, object] = {
                "status": "planned", "revision": revision, "park_count": 100,
                "change_count": len(changes), "source_counts": SOURCE_COUNTS,
                "target_counts": TARGET_COUNTS, "plan_sha256": digest,
            }
            if not args.apply:
                return result
            if args.expected_revision != revision or args.plan_sha256 != digest:
                raise DownshiftError("content revision or reviewed plan hash changed")
            for change in changes:
                cursor.execute(
                    "UPDATE public.parks SET rarity = %s WHERE id = %s AND rarity = %s",
                    (change["to"], change["id"], change["from"]),
                )
                if cursor.rowcount != 1:
                    raise DownshiftError(f"park changed during update: {change['id']}")
            cursor.execute("SELECT revision FROM public.content_clock WHERE singleton = true")
            new_revision = cursor.fetchone()[0]
            if new_revision != revision + 1:
                raise DownshiftError("rarity updates did not create exactly one content revision")
            cursor.execute("SELECT entity_id FROM public.content_changes WHERE revision = %s AND entity = 'park' ORDER BY entity_id", (new_revision,))
            if [row[0] for row in cursor.fetchall()] != sorted(change["id"] for change in changes):
                raise DownshiftError("Changes batch does not contain exactly the changed parks")
            cursor.execute("SELECT id, rarity FROM public.parks ORDER BY id")
            if dict(cursor.fetchall()) != target:
                raise DownshiftError("database readback differs from the target assignment")
            result.update(status="applied", revision=new_revision)
            return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--target", choices=("staging", "owned-preview"), required=True)
    parser.add_argument("--pull-request", type=int)
    parser.add_argument("--expected-database-host", required=True)
    parser.add_argument("--expected-revision", type=int)
    parser.add_argument("--plan-sha256")
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    if args.apply and (args.expected_revision is None or not re.fullmatch(r"[a-f0-9]{64}", args.plan_sha256 or "")):
        parser.error("--apply requires --expected-revision and --plan-sha256")
    try:
        print(json.dumps(run(args), sort_keys=True))
    except DownshiftError as exc:
        parser.exit(1, f"downshift refused: {exc}\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
