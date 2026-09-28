#!/usr/bin/env python3
"""Operate the durable, single-flight Parkdex park enrichment queue."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
from io import BytesIO
from urllib.parse import unquote, urlsplit
from uuid import uuid4
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
PUBLISHER = ROOT / "scripts" / "publish_park_update.py"
def _find_workspace_root(root: Path) -> Path:
    required = ("parkdex", "parkdex-landing", "parkdex-badge-mockup")
    for candidate in (root, *root.parents):
        if all((candidate / item).is_dir() for item in required):
            return candidate
    return root


WORKSPACE_ROOT = _find_workspace_root(ROOT)
WORK_ROOT = WORKSPACE_ROOT / ".codex" / "park-enrichment"
CDN_ORIGIN = "https://kip-assets.parkdex.app"
LEASE_SECONDS = 3 * 60 * 60
MAX_BADGE_BYTES = 4 * 1024 * 1024
RARITIES = {"common", "uncommon", "rare", "epic", "legendary"}
SLUG_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
SHA_RE = re.compile(r"^[a-f0-9]{64}$")
JOB_COLUMNS = (
    "rank", "park_id", "state", "lease_token", "lease_expires_at", "attempt_count",
    "frozen_research", "render_calls_started", "run_manifest_path", "run_manifest_sha256",
    "render_call_log", "selected_art", "publication_result", "published_at", "last_error",
)


class QueueError(ValueError):
    """A safe operator error that does not expose connection credentials."""


def _json_value(value: Any) -> Any:
    if isinstance(value, str):
        try:
            return json.loads(value)
        except json.JSONDecodeError:
            return value
    return value


def _json_text(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _file_digest(path_value: Any, digest_value: Any, label: str) -> tuple[Path, int]:
    if not isinstance(path_value, str) or not path_value.strip():
        raise QueueError(f"{label}.local_path must be a non-empty path")
    if not isinstance(digest_value, str) or not SHA_RE.fullmatch(digest_value):
        raise QueueError(f"{label}.sha256 must be a lowercase SHA-256 digest")
    try:
        path = Path(path_value).expanduser().resolve(strict=True)
        if not path.is_file():
            raise QueueError(f"{label}.local_path must name a file")
        hasher = hashlib.sha256()
        size = 0
        with path.open("rb") as stream:
            while True:
                chunk = stream.read(1024 * 1024)
                if not chunk:
                    break
                size += len(chunk)
                hasher.update(chunk)
    except QueueError:
        raise
    except OSError as exc:
        raise QueueError(f"Could not read {label}.local_path ({type(exc).__name__})") from None
    if hasher.hexdigest() != digest_value:
        raise QueueError(f"{label}.sha256 does not match the local file")
    return path, size


def _https_url(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise QueueError(f"{label} must be an HTTPS URL")
    parsed = urlsplit(value)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
        raise QueueError(f"{label} must be an HTTPS URL without embedded credentials")
    return value


def _is_google_host(host: str) -> bool:
    host = host.lower().rstrip(".")
    return host == "google.com" or host.endswith(".google.com")


def validate_research(value: Any) -> dict[str, Any]:
    """Validate and normalize frozen evidence before it is stored."""
    if not isinstance(value, dict):
        raise QueueError("research JSON must be an object")
    refs = value.get("google_image_refs")
    if not isinstance(refs, list) or len(refs) < 5:
        raise QueueError("research.google_image_refs must contain at least five local Google image references")
    normalized_refs: list[dict[str, Any]] = []
    seen_image_urls: set[str] = set()
    seen_image_hashes: set[str] = set()
    for index, item in enumerate(refs, start=1):
        if not isinstance(item, dict):
            raise QueueError(f"research.google_image_refs[{index}] must be an object")
        google_url = _https_url(item.get("google_search_url"), f"research.google_image_refs[{index}].google_search_url")
        if not _is_google_host(urlsplit(google_url).hostname or ""):
            raise QueueError(f"research.google_image_refs[{index}].google_search_url must use a Google host")
        image_url = _https_url(item.get("image_url"), f"research.google_image_refs[{index}].image_url")
        source_url = _https_url(item.get("source_url"), f"research.google_image_refs[{index}].source_url")
        path, size = _file_digest(item.get("local_path"), item.get("sha256"), f"research.google_image_refs[{index}]")
        normalized_url = image_url.strip().rstrip("/")
        if normalized_url in seen_image_urls or item["sha256"] in seen_image_hashes:
            raise QueueError("research.google_image_refs must contain five distinct image files")
        seen_image_urls.add(normalized_url)
        seen_image_hashes.add(item["sha256"])
        normalized = dict(item)
        normalized.update({"google_search_url": google_url, "image_url": image_url,
                           "source_url": source_url, "local_path": str(path), "sha256": item["sha256"]})
        normalized_refs.append(normalized)
    fact_urls = value.get("fact_urls")
    if not isinstance(fact_urls, list) or not fact_urls:
        raise QueueError("research.fact_urls must contain at least one source URL")
    normalized_facts = [_https_url(item, f"research.fact_urls[{index}]") for index, item in enumerate(fact_urls, 1)]
    dossier_path, dossier_size = _file_digest(
        value.get("dossier_path"), value.get("dossier_sha256"), "research dossier"
    )
    prompts = value.get("prompts")
    if not isinstance(prompts, dict):
        raise QueueError("research.prompts must be an object")
    if not any(isinstance(prompts.get(key), str) and prompts[key].strip() for key in ("image_generation", "prompt")):
        raise QueueError("research.prompts must include a non-empty image_generation prompt")
    normalized_prompts = dict(prompts)
    image_inputs = prompts.get("image_inputs")
    if image_inputs is not None:
        if not isinstance(image_inputs, list):
            raise QueueError("research.prompts.image_inputs must be an ordered list when supplied")
        normalized_inputs: list[dict[str, Any]] = []
        for index, item in enumerate(image_inputs, start=1):
            if not isinstance(item, dict) or item.get("order") != index:
                raise QueueError("research.prompts.image_inputs must be ordered from 1 without gaps")
            role = item.get("role")
            path_text = item.get("local_path")
            if not isinstance(role, str) or not role.strip() or not isinstance(path_text, str) or not path_text.strip():
                raise QueueError(f"research.prompts.image_inputs[{index}] requires role and local_path")
            normalized_inputs.append({**item, "local_path": str(Path(path_text).expanduser().resolve(strict=True))})
        normalized_prompts["image_inputs"] = normalized_inputs
    normalized = dict(value)
    normalized.update({
        "google_image_refs": normalized_refs,
        "fact_urls": normalized_facts,
        "dossier_path": str(dossier_path),
        "dossier_sha256": value["dossier_sha256"],
        "prompts": normalized_prompts,
    })
    return normalized


def _editable_fields(value: Any, label: str, *, desired: bool) -> dict[str, Any]:
    required = {"blurb", "rarity", "scene"}
    if not isinstance(value, dict) or set(value) != required:
        raise QueueError(f"selected_art.{label} must contain exactly blurb, rarity, and scene")
    blurb = value["blurb"]
    if not isinstance(blurb, str) or (desired and not blurb.strip()):
        qualifier = "non-empty " if desired else ""
        raise QueueError(f"selected_art.{label}.blurb must be a {qualifier}string")
    rarity = value["rarity"]
    if not isinstance(rarity, str) or rarity not in RARITIES:
        raise QueueError(f"selected_art.{label}.rarity must be one of {', '.join(sorted(RARITIES))}")
    scene = value["scene"]
    if scene is not None and (not isinstance(scene, str) or not SLUG_RE.fullmatch(scene)):
        raise QueueError(f"selected_art.{label}.scene must be null or a lowercase hyphenated slug")
    return {"blurb": blurb, "rarity": rarity, "scene": scene}


def validate_selected_art(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise QueueError("selected-art JSON must be an object")
    path, size = _file_digest(value.get("local_path"), value.get("sha256"), "selected_art")
    if path.suffix.lower() != ".webp":
        raise QueueError("selected_art.local_path must name a .webp file")
    if size <= 0 or size > MAX_BADGE_BYTES:
        raise QueueError("selected_art WebP must be between 1 byte and 4 MiB")
    slug = value.get("scene_slug")
    if not isinstance(slug, str) or not SLUG_RE.fullmatch(slug):
        raise QueueError("selected_art.scene_slug must be a lowercase hyphenated slug")
    expected = _editable_fields(value.get("expected"), "expected", desired=False)
    desired = _editable_fields(value.get("desired"), "desired", desired=True)
    if desired["scene"] != slug:
        raise QueueError("selected_art.desired.scene must match selected_art.scene_slug")
    try:
        from PIL import Image
        with path.open("rb") as stream:
            with Image.open(stream) as image:
                if image.format != "WEBP":
                    raise QueueError("selected_art file is not encoded as WebP")
                image.load()
    except ImportError:
        raise QueueError("Pillow is required to validate selected WebP art") from None
    except QueueError:
        raise
    except Exception as exc:
        raise QueueError(f"selected_art is not a decodable WebP image ({type(exc).__name__})") from None
    return {
        **value,
        "local_path": str(path),
        "sha256": value["sha256"],
        "byte_size": size,
        "scene_slug": slug,
        "expected": expected,
        "desired": desired,
    }


def _prepared_generation_records(path_value: Path, rank: int, park_id: str) -> tuple[dict[str, Any], str, list[dict[str, Any]], dict[str, Any]]:
    try:
        record_path = path_value.expanduser().resolve(strict=True)
        raw = record_path.read_bytes()
        record = json.loads(raw)
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise QueueError(f"Could not read prepared generation record ({type(exc).__name__})") from None
    if not isinstance(record, dict) or record.get("origin") != "prequeue-prepared":
        raise QueueError("prepared generation record must declare origin prequeue-prepared")
    if rank != 1 or park_id != "municipal-city-of-victoria-1442" or record.get("park_id") != park_id:
        raise QueueError("prepared adoption is restricted to rank 1 Beacon Hill")
    if record.get("render_calls_started") != 5 or record.get("correction_calls_started") != 2:
        raise QueueError("prepared generation record must contain exactly three initial and two correction calls")
    final_review = record.get("final_review")
    if not isinstance(final_review, dict) or final_review.get("render_calls") != 5 \
            or final_review.get("correction_count") != 2 or final_review.get("further_generation_allowed") is not False:
        raise QueueError("prepared generation final_review does not confirm the fixed five-call budget")
    compositions = record.get("compositions")
    corrections = record.get("corrections")
    if not isinstance(compositions, list) or len(compositions) != 3 \
            or not isinstance(corrections, list) or len(corrections) != 2:
        raise QueueError("prepared generation record must contain three initial and two correction entries")
    expected_initial = {"A", "B", "C"}
    if {item.get("composition_id") for item in compositions if isinstance(item, dict)} != expected_initial:
        raise QueueError("prepared initial composition ids must be A, B, and C")
    if any(not isinstance(item, dict) or item.get("revision") != 0 or item.get("status") != "generated" for item in compositions):
        raise QueueError("each initial prepared composition must have a generated output")
    if any(not isinstance(item, dict) or item.get("composition_id") != "B"
           or item.get("revision") != index or item.get("status") != "generated"
           for index, item in enumerate(corrections, start=1)):
        raise QueueError("prepared correction entries must be generated Beacon Hill B revisions 1 and 2")
    selected = record.get("selected")
    if not isinstance(selected, dict) or selected.get("composition_id") != "B" or selected.get("revision") != 2:
        raise QueueError("prepared final selection must be composition B revision 2")
    selected_webp_path, selected_size = _file_digest(selected.get("webp_path"), selected.get("webp_sha256"), "prepared selected WebP")
    if selected_size != selected.get("webp_bytes"):
        raise QueueError("prepared selected WebP byte size does not match the generation record")
    selected_png = selected.get("png_path")
    final_correction = corrections[-1]
    final_png_path, final_png_size = _file_digest(
        final_correction.get("output_path"), final_correction.get("output_sha256"), "prepared final PNG"
    )
    try:
        selected_png_path = Path(selected_png).expanduser().resolve(strict=True)
        selected_png_bytes = selected_png_path.read_bytes()
    except (OSError, TypeError) as exc:
        raise QueueError(f"Could not read prepared selected PNG ({type(exc).__name__})") from None
    selected_png_sha = hashlib.sha256(selected_png_bytes).hexdigest()
    if selected_png_path.suffix.lower() != ".png" or selected_png_sha != final_correction.get("output_sha256") \
            or len(selected_png_bytes) != final_png_size:
        raise QueueError("prepared selected PNG must be a byte-identical copy of the final correction output")
    try:
        from PIL import Image
        with Image.open(BytesIO(selected_png_bytes)) as image:
            if image.format != "PNG":
                raise QueueError("prepared selected output is not a PNG")
            image.load()
    except ImportError:
        raise QueueError("Pillow is required to validate the prepared selected PNG") from None
    except QueueError:
        raise
    except Exception as exc:
        raise QueueError(f"prepared selected PNG is not decodable ({type(exc).__name__})") from None

    calls: list[dict[str, Any]] = []
    source_record_sha = hashlib.sha256(raw).hexdigest()
    source_record_path = str(record_path)
    for call_index, entry in enumerate([*compositions, *corrections], start=1):
        if not isinstance(entry.get("prompt"), str) or not entry["prompt"].strip():
            raise QueueError(f"prepared render call {call_index} requires its exact prompt")
        inputs = entry.get("inputs")
        if not isinstance(inputs, list) or not inputs:
            raise QueueError(f"prepared render call {call_index} requires ordered input photos")
        image_inputs = []
        for order, item in enumerate(inputs, start=1):
            if not isinstance(item, dict) or not isinstance(item.get("role"), str) or not item["role"].strip():
                raise QueueError(f"prepared render call {call_index} input {order} is missing its role")
            input_path, _ = _file_digest(item.get("path"), item.get("sha256"), f"prepared render call {call_index} input {order}")
            image_inputs.append({"order": order, "role": item["role"], "local_path": str(input_path), "sha256": item["sha256"]})
        output_path, _ = _file_digest(entry.get("output_path"), entry.get("output_sha256"), f"prepared render call {call_index} output")
        phase = "initial" if call_index <= 3 else "correction"
        call = {
            "rank": rank,
            "park_id": park_id,
            "call_index": call_index,
            "phase": phase,
            "prompt": entry["prompt"],
            "image_inputs": image_inputs,
            "composition_id": entry.get("composition_id"),
            "revision": entry.get("revision"),
            "origin": "prequeue-prepared",
            "source_record_path": source_record_path,
            "source_record_sha256": source_record_sha,
            "output_path": str(output_path),
            "output_sha256": entry["output_sha256"],
        }
        calls.append(call)
    if selected_webp_path != Path(selected.get("webp_path")).expanduser().resolve(strict=True):
        raise QueueError("prepared selected WebP path changed during validation")
    return record, source_record_sha, calls, {
        "local_path": str(selected_webp_path), "sha256": selected["webp_sha256"],
        "byte_size": selected_size, "png_path": str(selected_png_path),
        "png_sha256": selected_png_sha, "final_correction_png_path": str(final_png_path),
    }


def _prepare_prepared_manifests(rank: int, park_id: str, calls: list[dict[str, Any]], source_path: str,
                                source_sha: str) -> tuple[list[dict[str, Any]], str, str]:
    workdir = workdir_for(rank)
    try:
        workdir.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        raise QueueError(f"Could not prepare the deterministic rank workdir ({type(exc).__name__})") from None
    history = []
    for call in calls:
        call_index = call["call_index"]
        manifest_path = render_manifest_for(rank, call_index).resolve()
        data = _json_text(call).encode("utf-8") + b"\n"
        if manifest_path.exists():
            try:
                existing = manifest_path.read_bytes()
            except OSError as exc:
                raise QueueError(f"Could not read prepared render manifest ({type(exc).__name__})") from None
            if existing != data:
                raise QueueError(f"rank {rank} render manifest {call_index} already contains different progress")
        else:
            try:
                manifest_path.write_bytes(data)
            except OSError as exc:
                raise QueueError(f"Could not persist prepared render manifest ({type(exc).__name__})") from None
        digest = hashlib.sha256(data).hexdigest()
        history.append({
            "origin": "prequeue-prepared", "call_index": call_index, "call": call,
            "manifest_path": str(manifest_path), "manifest_sha256": digest,
            "source_record_path": source_path, "source_record_sha256": source_sha,
            "output_path": call["output_path"], "output_sha256": call["output_sha256"],
        })
    last = history[-1]
    return history, last["manifest_path"], last["manifest_sha256"]


def _read_validated_research(path: Path) -> dict[str, Any]:
    try:
        resolved = path.expanduser().resolve(strict=True)
        raw = resolved.read_bytes()
        value = json.loads(raw)
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise QueueError(f"Could not read research JSON ({type(exc).__name__})") from None
    research = validate_research(value)
    research["research_json_path"] = str(resolved)
    research["research_json_sha256"] = hashlib.sha256(raw).hexdigest()
    return research


def _read_validated_selected_art(path: Path) -> dict[str, Any]:
    try:
        resolved = path.expanduser().resolve(strict=True)
        raw = resolved.read_bytes()
        value = json.loads(raw)
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise QueueError(f"Could not read selected-art JSON ({type(exc).__name__})") from None
    art = validate_selected_art(value)
    art["selection_json_path"] = str(resolved)
    art["selection_json_sha256"] = hashlib.sha256(raw).hexdigest()
    return art


def parse_database_identity(database_url: str, target: str, target_id: str | None, expected_host: str) -> dict[str, str]:
    parsed = urlsplit(database_url)
    if parsed.scheme not in {"postgres", "postgresql"} or not parsed.hostname:
        raise QueueError("DATABASE_URL must be a PostgreSQL URL")
    host = parsed.hostname.lower().rstrip(".")
    requested_host = expected_host.lower().rstrip(".")
    if not requested_host or host != requested_host:
        raise QueueError("DATABASE_URL host does not match --expected-database-host")
    database = unquote(parsed.path.lstrip("/"))
    username = unquote(parsed.username or "")
    if target == "staging":
        if target_id is not None:
            raise QueueError("--target-id is only valid for --target owned-preview")
        if database != "parkdex_kip" or username != "parkdex_kip_owner":
            raise QueueError("staging target must use the parkdex_kip database and parkdex_kip_owner role")
    elif target == "owned-preview":
        if target_id is None or not re.fullmatch(r"[0-9]+", target_id):
            raise QueueError("owned-preview target requires a numeric --target-id")
        db_match = re.fullmatch(r"kip_preview_([0-9]+)_([a-z0-9]+)", database)
        user_match = re.fullmatch(r"kip_pr_([0-9]+)_([a-z0-9]+)", username)
        if not db_match or not user_match or db_match.groups() != user_match.groups() or db_match.group(1) != target_id:
            raise QueueError("owned-preview DATABASE_URL must use its matching preview database and role")
    else:
        raise QueueError("target must be staging or owned-preview")
    return {"host": host, "database": database, "username": username}


def verify_target(conn: Any, target: str, target_id: str | None, expected_host: str, database_url: str) -> None:
    identity = parse_database_identity(database_url, target, target_id, expected_host)
    with conn.cursor() as cursor:
        cursor.execute(
            "SELECT target_environment, target_id, database_host FROM public.park_enrichment_rollout WHERE singleton = true"
        )
        row = cursor.fetchone()
    if row is None:
        raise QueueError("park enrichment rollout receipt is missing; apply the owned staging or preview reset first")
    actual_target, actual_target_id, marker_host = row
    if actual_target != target or actual_target_id != target_id:
        raise QueueError("requested target does not match the immutable rollout receipt")
    if str(marker_host).lower().rstrip(".") != identity["host"]:
        raise QueueError("DATABASE_URL host does not match the immutable rollout receipt")


def _connect(database_url: str) -> Any:
    try:
        import psycopg
    except ImportError:
        raise QueueError("psycopg is required; install database/requirements.txt") from None
    try:
        return psycopg.connect(database_url)
    except Exception as exc:
        raise QueueError(f"Database connection failed ({type(exc).__name__})") from None


def _job(row: Any) -> dict[str, Any] | None:
    if row is None:
        return None
    result = dict(zip(JOB_COLUMNS, row, strict=True))
    for key in ("frozen_research", "render_call_log", "selected_art", "publication_result"):
        result[key] = _json_value(result[key])
    result["lease_token"] = str(result["lease_token"]) if result["lease_token"] is not None else None
    for key in ("lease_expires_at", "published_at"):
        if result[key] is not None and hasattr(result[key], "isoformat"):
            result[key] = result[key].isoformat()
    result["workdir"] = str(workdir_for(result["rank"]))
    return result


def workdir_for(rank: int) -> Path:
    return WORK_ROOT / f"rank-{rank:03d}"


def render_manifest_for(rank: int, call_index: int) -> Path:
    return workdir_for(rank) / f"render-call-{call_index:02d}.json"


def _select_job(cursor: Any, rank: int, *, lock: bool = False) -> dict[str, Any] | None:
    suffix = " FOR UPDATE" if lock else ""
    cursor.execute(
        "SELECT " + ", ".join(JOB_COLUMNS) + " FROM public.park_enrichment_jobs WHERE rank = %s" + suffix,
        (rank,),
    )
    return _job(cursor.fetchone())


def _lock_rollout(cursor: Any) -> None:
    # Global claim/lease lock. Acquire it before any job-row lock so an expired
    # renewal or publication cannot be skipped while claim_one leases another rank.
    cursor.execute("SELECT singleton FROM public.park_enrichment_rollout WHERE singleton = true FOR UPDATE")
    if cursor.fetchone() is None:
        raise QueueError("park enrichment rollout receipt is missing")


def _job_progress(job: dict[str, Any], *, include_token: bool = False) -> dict[str, Any]:
    result = {
        "rank": job["rank"],
        "park_id": job["park_id"],
        "state": job["state"],
        "attempt_count": job["attempt_count"],
        "lease_expires_at": job["lease_expires_at"],
        "research_frozen": job["frozen_research"] is not None,
        "render_calls_started": job["render_calls_started"],
        "render_call_log": job["render_call_log"],
        "run_manifest_path": job["run_manifest_path"],
        "run_manifest_sha256": job["run_manifest_sha256"],
        "selected_art": job["selected_art"],
        "workdir": job["workdir"],
    }
    if include_token:
        result["lease_token"] = job["lease_token"]
    return result


def _job_summary(job: dict[str, Any]) -> dict[str, Any]:
    art = job["selected_art"]
    return {
        "rank": job["rank"],
        "park_id": job["park_id"],
        "state": job["state"],
        "attempt_count": job["attempt_count"],
        "lease_expires_at": job["lease_expires_at"],
        "research_frozen": job["frozen_research"] is not None,
        "render_calls_started": job["render_calls_started"],
        "selected_art": None if art is None else {
            "scene_slug": art.get("scene_slug"), "sha256": art.get("sha256")
        },
        "published_at": job["published_at"],
        "last_error": job["last_error"],
        "workdir": job["workdir"],
    }


def _completion_summary(cursor: Any) -> dict[str, Any]:
    cursor.execute(
        """
        SELECT expected_count,
               (SELECT count(*) FROM public.park_enrichment_jobs),
               (SELECT count(*) FROM public.park_enrichment_jobs WHERE state = 'published'),
               (SELECT count(*) FROM public.park_enrichment_jobs WHERE state = 'needs_attention')
          FROM public.park_enrichment_rollout
         WHERE singleton = true
        """
    )
    row = cursor.fetchone()
    if row is None:
        raise QueueError("park enrichment rollout receipt is missing")
    expected, total, published, needs_attention = row
    return {
        "expected_count": expected,
        "total": total,
        "published": published,
        "needs_attention": needs_attention,
        "remaining": max(0, expected - published),
        "complete": total == expected and published == expected,
    }


def inspect_queue(conn: Any, rank: int | None = None) -> dict[str, Any]:
    with conn.cursor() as cursor:
        cursor.execute("SELECT state, count(*) FROM public.park_enrichment_jobs GROUP BY state ORDER BY state")
        counts = {state: count for state, count in cursor.fetchall()}
        if rank is not None:
            job = _select_job(cursor, rank)
            jobs = [] if job is None else [job]
            detailed = True
        else:
            cursor.execute(
                """
                SELECT "rank", park_id, state, attempt_count, lease_expires_at,
                       frozen_research IS NOT NULL, render_calls_started,
                       selected_art->>'scene_slug', selected_art->>'sha256',
                       published_at, last_error
                  FROM public.park_enrichment_jobs ORDER BY "rank"
                """
            )
            jobs = cursor.fetchall()
            detailed = False
        cursor.execute("SELECT expected_count FROM public.park_enrichment_rollout WHERE singleton = true")
        marker = cursor.fetchone()
    expected = int(marker[0]) if marker else 100
    total = sum(counts.values())
    published = counts.get("published", 0)
    remaining = max(0, expected - published)
    job_items = []
    if detailed:
        for item in jobs:
            job_items.append({
                **_job_progress(item),
                "published_at": item["published_at"],
                "last_error": item["last_error"],
            })
    else:
        for row in jobs:
            job_items.append({
                "rank": row[0], "park_id": row[1], "state": row[2], "attempt_count": row[3],
                "lease_expires_at": row[4].isoformat() if hasattr(row[4], "isoformat") else row[4],
                "research_frozen": row[5], "render_calls_started": row[6],
                "selected_art": None if row[7] is None else {"scene_slug": row[7], "sha256": row[8]},
                "published_at": row[9].isoformat() if hasattr(row[9], "isoformat") else row[9],
                "last_error": row[10], "workdir": str(workdir_for(row[0])),
            })
    return {
        "command": "status",
        "expected_count": expected,
        "total": total,
        "counts": counts,
        "published": published,
        "remaining": remaining,
        "complete": total == expected and published == expected,
        "jobs": job_items,
    }


def _fetch_public_values(cursor: Any, park_id: str) -> dict[str, Any] | None:
    cursor.execute("SELECT blurb, rarity, scene FROM public.parks WHERE id = %s", (park_id,))
    row = cursor.fetchone()
    if row is None:
        return None
    return dict(zip(("blurb", "rarity", "scene"), row, strict=True))


def _expected_asset(art: dict[str, Any]) -> dict[str, Any]:
    slug = art["scene_slug"]
    sha = art["sha256"]
    logical_path = f"art/badges/scenes/{slug}.webp"
    object_key = f"releases/{sha}/{logical_path}"
    return {
        "logical_path": logical_path,
        "object_key": object_key,
        "url": f"{CDN_ORIGIN}/{object_key}",
        "sha256": sha,
        "byte_size": art["byte_size"],
        "content_type": "image/webp",
    }


def _asset_matches(cursor: Any, art: dict[str, Any]) -> bool:
    expected = _expected_asset(art)
    cursor.execute(
        "SELECT logical_path, object_key, url, sha256, byte_size, content_type FROM public.r2_objects WHERE logical_path = %s",
        (expected["logical_path"],),
    )
    row = cursor.fetchone()
    return row is not None and dict(zip(expected.keys(), row, strict=True)) == expected


def _public_matches(cursor: Any, job: dict[str, Any], *, desired: bool) -> bool:
    art = job["selected_art"]
    if art is None:
        return False
    actual = _fetch_public_values(cursor, job["park_id"])
    expected_values = art["desired"] if desired else art["expected"]
    return actual == expected_values and (not desired or _asset_matches(cursor, art))


def _mark_published(cursor: Any, job: dict[str, Any], token: str, result: dict[str, Any], *, require_live: bool) -> bool:
    live_sql = "AND lease_expires_at > clock_timestamp()" if require_live else ""
    cursor.execute(
        f"""
        UPDATE public.park_enrichment_jobs
           SET state = 'published', publication_result = %s::jsonb, published_at = clock_timestamp(),
               lease_token = NULL, lease_expires_at = NULL, last_error = NULL
         WHERE rank = %s AND state = 'publishing' AND lease_token = %s {live_sql}
        RETURNING rank
        """,
        (_json_text(result), job["rank"], token),
    )
    return cursor.fetchone() is not None


def _asset_is_absent_or_matches(cursor: Any, art: dict[str, Any]) -> bool:
    expected = _expected_asset(art)
    cursor.execute(
        "SELECT logical_path, object_key, url, sha256, byte_size, content_type FROM public.r2_objects WHERE logical_path = %s",
        (expected["logical_path"],),
    )
    row = cursor.fetchone()
    return row is None or dict(zip(expected.keys(), row, strict=True)) == expected


def _set_expired_state(cursor: Any, job: dict[str, Any], next_state: str, reason: str, *, resume: bool) -> dict[str, Any]:
    rank = job["rank"]
    old_token = job["lease_token"]
    if resume and next_state in {"leased", "ready"} and job["attempt_count"] < 3:
        new_token = uuid4()
        cursor.execute(
            """
            UPDATE public.park_enrichment_jobs
               SET state = %s, lease_token = %s,
                   lease_expires_at = clock_timestamp() + make_interval(secs => %s),
                   attempt_count = attempt_count + 1, last_error = NULL
             WHERE rank = %s AND lease_token = %s AND lease_expires_at <= clock_timestamp()
            RETURNING "rank", park_id, state, lease_token, lease_expires_at, attempt_count,
                      frozen_research, render_calls_started, run_manifest_path, run_manifest_sha256,
                      render_call_log, selected_art, publication_result, published_at, last_error
            """,
            (next_state, new_token, LEASE_SECONDS, rank, old_token),
        )
        resumed = _job(cursor.fetchone())
        return {"outcome": "reclaimed", "job": _job_progress(resumed, include_token=True)} if resumed else {
            "outcome": "superseded", "job": None
        }
    if job["attempt_count"] >= 3 and next_state in {"queued", "leased", "ready"}:
        next_state = "needs_attention"
        reason = "lease expired after the third attempt"
    elif not resume and next_state == "leased":
        next_state = "queued"
    cursor.execute(
        """
        UPDATE public.park_enrichment_jobs
           SET state = %s, lease_token = NULL, lease_expires_at = NULL, last_error = %s
         WHERE rank = %s AND lease_token = %s AND lease_expires_at <= clock_timestamp()
        RETURNING "rank", park_id, state, lease_token, lease_expires_at, attempt_count,
                  frozen_research, render_calls_started, run_manifest_path, run_manifest_sha256,
                  render_call_log, selected_art, publication_result, published_at, last_error
        """,
        (next_state, reason[:500], rank, old_token),
    )
    recovered = _job(cursor.fetchone())
    return {"outcome": next_state, "job": _job_progress(recovered) if recovered else None}


def _recover_expired_locked(conn: Any, *, rank: int | None, resume: bool) -> dict[str, Any] | None:
    with conn.cursor() as cursor:
        if rank is None:
            cursor.execute(
                """
                SELECT "rank" FROM public.park_enrichment_jobs
                 WHERE state IN ('leased', 'ready', 'publishing')
                   AND lease_token IS NOT NULL AND lease_expires_at <= clock_timestamp()
                 ORDER BY "rank" LIMIT 1 FOR UPDATE SKIP LOCKED
                """
            )
            found = cursor.fetchone()
            if found is None:
                return None
            rank = found[0]
        job = _select_job(cursor, rank, lock=True)
        if job is None:
            raise QueueError(f"rank {rank} was not found")
        cursor.execute(
            "SELECT lease_expires_at <= clock_timestamp() FROM public.park_enrichment_jobs WHERE rank = %s",
            (rank,),
        )
        expired_row = cursor.fetchone()
        if not expired_row or not expired_row[0] or job["lease_token"] is None:
            raise QueueError("job does not have an expired lease")
        token = job["lease_token"]
        state = job["state"]
        if state == "publishing":
            if _public_matches(cursor, job, desired=True):
                result = {"status": "reconciled_after_expired_lease", "verified": "park-and-asset"}
                cursor.execute(
                    """
                    UPDATE public.park_enrichment_jobs
                       SET state = 'published', publication_result = %s::jsonb,
                           published_at = clock_timestamp(), lease_token = NULL,
                           lease_expires_at = NULL, last_error = NULL
                     WHERE rank = %s AND state = 'publishing' AND lease_token = %s
                    RETURNING "rank", park_id, state, lease_token, lease_expires_at, attempt_count,
                              frozen_research, render_calls_started, run_manifest_path, run_manifest_sha256,
                              render_call_log, selected_art, publication_result, published_at, last_error
                    """,
                    (_json_text(result), rank, token),
                )
                reconciled = _job(cursor.fetchone())
                return {"outcome": "recovered_published", "job": _job_progress(reconciled) if reconciled else None}
            if _public_matches(cursor, job, desired=False) and _asset_is_absent_or_matches(cursor, job["selected_art"]):
                return _set_expired_state(
                    cursor, job, "ready", "publication lease expired before the park update was visible", resume=resume
                )
            return _set_expired_state(
                cursor, job, "needs_attention",
                "publication lease expired and database state diverged from expected and desired values", resume=False,
            )
        if state == "leased":
            return _set_expired_state(
                cursor, job, "leased", "lease expired before the job was checkpointed", resume=resume
            )
        if state == "ready":
            return _set_expired_state(
                cursor, job, "ready", "ready lease expired before publication", resume=resume
            )
        raise QueueError("job does not have a recoverable lease")


def claim_one(conn: Any) -> dict[str, Any]:
    with conn.transaction():
        with conn.cursor() as cursor:
            _lock_rollout(cursor)
            cursor.execute(
                """
                SELECT "rank", park_id, state, lease_token, lease_expires_at, attempt_count,
                       frozen_research, render_calls_started, run_manifest_path, run_manifest_sha256,
                       render_call_log, selected_art, publication_result, published_at, last_error
                  FROM public.park_enrichment_jobs
                 WHERE state IN ('leased', 'ready', 'publishing')
                   AND lease_token IS NOT NULL AND lease_expires_at > clock_timestamp()
                 ORDER BY "rank" LIMIT 1
                """
            )
            active = _job(cursor.fetchone())
            if active is not None:
                return {"command": "claim", "outcome": "busy", "job": _job_progress(active),
                        **_completion_summary(cursor)}

            recovered = _recover_expired_locked(conn, rank=None, resume=True)
            if recovered is not None:
                return {"command": "claim", **recovered, **_completion_summary(cursor)}

            new_token = uuid4()
            cursor.execute(
                """
                WITH candidate AS (
                    SELECT "rank"
                      FROM public.park_enrichment_jobs
                     WHERE state IN ('queued', 'ready') AND lease_token IS NULL AND attempt_count < 3
                     ORDER BY "rank"
                     FOR UPDATE SKIP LOCKED
                     LIMIT 1
                )
                UPDATE public.park_enrichment_jobs AS job
                   SET state = CASE WHEN job.state = 'queued' THEN 'leased' ELSE 'ready' END,
                       lease_token = %s,
                       lease_expires_at = clock_timestamp() + make_interval(secs => %s),
                       attempt_count = job.attempt_count + 1,
                       last_error = NULL
                  FROM candidate
                 WHERE job."rank" = candidate."rank"
                RETURNING job."rank", job.park_id, job.state, job.lease_token, job.lease_expires_at,
                          job.attempt_count, job.frozen_research, job.render_calls_started,
                          job.run_manifest_path, job.run_manifest_sha256, job.render_call_log,
                          job.selected_art, job.publication_result, job.published_at, job.last_error
                """,
                (new_token, LEASE_SECONDS),
            )
            selected = _job(cursor.fetchone())
            summary = _completion_summary(cursor)
            if selected is None:
                if summary["complete"]:
                    outcome = "complete"
                elif summary["needs_attention"]:
                    outcome = "needs_attention"
                else:
                    outcome = "empty"
            else:
                outcome = "claimed"
            return {
                "command": "claim",
                "outcome": outcome,
                "job": _job_progress(selected, include_token=True) if selected else None,
                **summary,
            }


def freeze_research(conn: Any, rank: int, token: str, research: dict[str, Any]) -> dict[str, Any]:
    serialized = _json_text(research)
    with conn.transaction():
        with conn.cursor() as cursor:
            _lock_rollout(cursor)
            job = _select_job(cursor, rank, lock=True)
            if job is None:
                raise QueueError(f"rank {rank} was not found")
            if job["lease_token"] != token:
                raise QueueError("lease token is stale or does not own this job")
            if job["state"] != "leased":
                raise QueueError("research can only be frozen while the job is leased")
            if job["frozen_research"] is not None:
                if job["frozen_research"] == research:
                    return {"command": "freeze", "outcome": "already_frozen", "job": _job_progress(job)}
                raise QueueError("frozen research cannot be replaced")
            cursor.execute("SELECT lease_expires_at > clock_timestamp() FROM public.park_enrichment_jobs WHERE rank = %s", (rank,))
            live = cursor.fetchone()
            if not live or not live[0]:
                raise QueueError("lease has expired")
            cursor.execute(
                """
                UPDATE public.park_enrichment_jobs
                   SET frozen_research = %s::jsonb,
                       lease_expires_at = clock_timestamp() + make_interval(secs => %s)
                 WHERE rank = %s AND state = 'leased' AND lease_token = %s
                   AND lease_expires_at > clock_timestamp() AND frozen_research IS NULL
                RETURNING "rank", park_id, state, lease_token, lease_expires_at, attempt_count,
                          frozen_research, render_calls_started, run_manifest_path, run_manifest_sha256,
                          render_call_log, selected_art, publication_result, published_at, last_error
                """,
                (serialized, LEASE_SECONDS, rank, token),
            )
            updated = _job(cursor.fetchone())
            if updated is None:
                raise QueueError("job changed while freezing research")
            return {"command": "freeze", "outcome": "frozen", "job": _job_progress(updated)}


def _render_call(value: Any, index: int) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise QueueError(f"render call {index} must be an object")
    phase = value.get("phase")
    expected_phase = "initial" if index <= 3 else "correction"
    if phase != expected_phase:
        raise QueueError(f"render call {index} phase must be {expected_phase}")
    prompt = value.get("prompt")
    if not isinstance(prompt, str) or not prompt.strip():
        raise QueueError(f"render call {index} prompt must be a non-empty string")
    inputs = value.get("image_inputs")
    if not isinstance(inputs, list) or not inputs:
        raise QueueError(f"render call {index} image_inputs must be a non-empty ordered list")
    normalized_inputs = []
    for order, item in enumerate(inputs, start=1):
        if not isinstance(item, dict) or item.get("order") != order:
            raise QueueError(f"render call {index} image_inputs must be ordered from 1 without gaps")
        role = item.get("role")
        path = item.get("local_path")
        if not isinstance(role, str) or not role.strip() or not isinstance(path, str) or not path.strip():
            raise QueueError(f"render call {index} inputs require role and local_path")
        try:
            normalized_path = Path(path).expanduser().resolve(strict=True)
        except OSError as exc:
            raise QueueError(f"render call {index} input path could not be read ({type(exc).__name__})") from None
        if not normalized_path.is_file():
            raise QueueError(f"render call {index} input path must name a file")
        normalized = {**item, "order": order, "role": role, "local_path": str(normalized_path)}
        if "sha256" in item:
            resolved, _ = _file_digest(path, item["sha256"], f"render call {index} input {order}")
            normalized["local_path"] = str(resolved)
        normalized_inputs.append(normalized)
    return {**value, "phase": phase, "prompt": prompt, "image_inputs": normalized_inputs}


def _read_render_call(path_value: Path, rank: int, park_id: str, call_index: int) -> tuple[dict[str, Any], Path, str]:
    expected_path = render_manifest_for(rank, call_index).resolve()
    try:
        actual_path = path_value.expanduser().resolve(strict=True)
    except OSError as exc:
        raise QueueError(f"Could not read render manifest ({type(exc).__name__})") from None
    if actual_path != expected_path:
        raise QueueError("render manifest must use this rank's deterministic workdir path")
    try:
        raw = actual_path.read_bytes()
        value = json.loads(raw)
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise QueueError(f"Could not read render manifest ({type(exc).__name__})") from None
    if not isinstance(value, dict) or value.get("rank") != rank or value.get("park_id") != park_id:
        raise QueueError("render manifest rank and park_id must match the leased job")
    if value.get("call_index") != call_index:
        raise QueueError("render manifest call_index does not match its deterministic filename")
    normalized = _render_call(value, call_index)
    return normalized, actual_path, hashlib.sha256(raw).hexdigest()


def _verify_render_history(job: dict[str, Any]) -> list[dict[str, Any]]:
    log = _json_value(job["render_call_log"]) or []
    if not isinstance(log, list) or len(log) != job["render_calls_started"]:
        raise QueueError("stored render call log is inconsistent with its spent count")
    for index, record in enumerate(log, start=1):
        if not isinstance(record, dict):
            raise QueueError("stored render call log is invalid")
        path = render_manifest_for(job["rank"], index).resolve()
        if record.get("manifest_path") != str(path):
            raise QueueError("stored render call path differs from its deterministic workdir")
        try:
            raw = path.read_bytes()
        except OSError as exc:
            raise QueueError(f"Recorded render manifest {index} is missing ({type(exc).__name__})") from None
        if hashlib.sha256(raw).hexdigest() != record.get("manifest_sha256"):
            raise QueueError(f"Recorded render manifest {index} changed after checkpoint")
        try:
            manifest = json.loads(raw)
        except (UnicodeError, json.JSONDecodeError):
            raise QueueError(f"Recorded render manifest {index} is invalid") from None
        call, _, digest = _read_render_call(path, job["rank"], job["park_id"], index)
        if manifest.get("rank") != job["rank"] or manifest.get("park_id") != job["park_id"]:
            raise QueueError(f"Recorded render manifest {index} belongs to another job")
        if record.get("manifest_sha256") != digest or record.get("call") != call:
            raise QueueError(f"Recorded render manifest {index} differs from its durable call log")
    if log:
        last = log[-1]
        if job["run_manifest_path"] != last["manifest_path"] or job["run_manifest_sha256"] != last["manifest_sha256"]:
            raise QueueError("last render manifest fields differ from the durable call log")
    return log


def checkpoint_render(conn: Any, rank: int, token: str, manifest_path: Path) -> dict[str, Any]:
    with conn.transaction():
        with conn.cursor() as cursor:
            _lock_rollout(cursor)
            job = _select_job(cursor, rank, lock=True)
            if job is None:
                raise QueueError(f"rank {rank} was not found")
            if job["lease_token"] != token:
                raise QueueError("lease token is stale or does not own this job")
            if job["state"] != "leased" or job["frozen_research"] is None:
                raise QueueError("start-render requires a leased job with frozen research")
            live_row = None
            cursor.execute("SELECT lease_expires_at > clock_timestamp() FROM public.park_enrichment_jobs WHERE rank = %s", (rank,))
            live_row = cursor.fetchone()
            if not live_row or not live_row[0]:
                raise QueueError("lease has expired")
            count = int(job["render_calls_started"])
            history = _verify_render_history(job)
            try:
                path_guess = manifest_path.expanduser().resolve(strict=True)
                manifest_value = json.loads(path_guess.read_text(encoding="utf-8"))
            except (OSError, UnicodeError, json.JSONDecodeError) as exc:
                raise QueueError(f"Could not read render manifest ({type(exc).__name__})") from None
            if not isinstance(manifest_value, dict) or not isinstance(manifest_value.get("call_index"), int):
                raise QueueError("render manifest must include an integer call_index")
            call_index = manifest_value["call_index"]
            if call_index == count and count > 0:
                call, path, digest = _read_render_call(manifest_path, rank, job["park_id"], call_index)
                last = history[-1]
                if last.get("manifest_path") != str(path) or last.get("manifest_sha256") != digest or last.get("call") != call:
                    raise QueueError("render manifest does not match the last recorded checkpoint")
                return {
                    "command": "start-render", "outcome": "already_checkpointed",
                    "render_calls_started": count, "call_index": count,
                    "run_manifest_sha256": digest, "workdir": str(workdir_for(rank)),
                }
            if call_index != count + 1:
                raise QueueError("render manifest must describe the next uncheckpointed call")
            if count >= 5:
                raise QueueError("the three initial and two correction render slots are exhausted")
            call, manifest_path_resolved, digest = _read_render_call(manifest_path, rank, job["park_id"], call_index)
            next_count = call_index
            manifest_abs = str(manifest_path_resolved)
            record = {"call_index": call_index, "call": call, "manifest_path": manifest_abs, "manifest_sha256": digest}
            next_log = history + [record]
            cursor.execute(
                """
                UPDATE public.park_enrichment_jobs
                   SET render_calls_started = %s, run_manifest_path = %s,
                       run_manifest_sha256 = %s, render_call_log = %s::jsonb,
                       lease_expires_at = clock_timestamp() + make_interval(secs => %s)
                 WHERE rank = %s AND state = 'leased' AND lease_token = %s
                   AND lease_expires_at > clock_timestamp() AND render_calls_started = %s
                RETURNING render_calls_started, run_manifest_sha256, lease_expires_at
                """,
                (next_count, manifest_abs, digest, _json_text(next_log), LEASE_SECONDS, rank, token, count),
            )
            updated = cursor.fetchone()
            if updated is None:
                raise QueueError("job changed while recording the render checkpoint")
            return {
                "command": "start-render", "outcome": "checkpointed",
                "render_calls_started": updated[0], "call_index": updated[0],
                "run_manifest_sha256": updated[1], "lease_expires_at": updated[2].isoformat(),
                "workdir": str(workdir_for(rank)),
            }


def _preflight_selected_art(cursor: Any, rank: int, art: dict[str, Any]) -> None:
    cursor.execute(
        "SELECT \"rank\" FROM public.park_enrichment_jobs WHERE selected_art->>'scene_slug' = %s AND \"rank\" <> %s",
        (art["scene_slug"], rank),
    )
    if cursor.fetchone() is not None:
        raise QueueError("selected scene slug is already assigned to another enrichment job")
    expected_asset = _expected_asset(art)
    cursor.execute(
        "SELECT logical_path, object_key, url, sha256, byte_size, content_type FROM public.r2_objects WHERE logical_path = %s",
        (expected_asset["logical_path"],),
    )
    existing_asset = cursor.fetchone()
    if existing_asset is not None and dict(zip(expected_asset.keys(), existing_asset, strict=True)) != expected_asset:
        raise QueueError("selected scene slug already names a different immutable R2 asset")


def _require_initial_compositions(render_calls_started: int) -> None:
    if render_calls_started < 3:
        raise QueueError("art selection requires all three initial render calls before review")


def adopt_prepared(conn: Any, rank: int, token: str, generation_record_path: Path,
                   research: dict[str, Any], art: dict[str, Any]) -> dict[str, Any]:
    if rank != 1:
        raise QueueError("adopt-prepared is restricted to rank 1 Beacon Hill")
    park_id = "municipal-city-of-victoria-1442"
    record, source_sha, calls, record_art = _prepared_generation_records(generation_record_path, rank, park_id)
    if art["local_path"] != record_art["local_path"] or art["sha256"] != record_art["sha256"] \
            or art["byte_size"] != record_art["byte_size"]:
        raise QueueError("selected-art JSON does not match the prepared generation record WebP")
    art = dict(art)
    art["prepared_png_path"] = record_art["png_path"]
    art["prepared_png_sha256"] = record_art["png_sha256"]
    if research.get("park_id", park_id) != park_id:
        raise QueueError("prepared research belongs to another park")
    research = dict(research)
    research["park_id"] = park_id
    history, last_manifest_path, last_manifest_sha = _prepare_prepared_manifests(
        rank, park_id, calls, str(Path(generation_record_path).expanduser().resolve(strict=True)), source_sha
    )
    with conn.transaction():
        with conn.cursor() as cursor:
            _lock_rollout(cursor)
            job = _select_job(cursor, rank, lock=True)
            if job is None or job["park_id"] != park_id:
                raise QueueError("rank 1 is not seeded for Beacon Hill")
            if job["lease_token"] != token:
                raise QueueError("lease token is stale or does not own this job")
            if job["state"] != "leased" or job["attempt_count"] != 1:
                raise QueueError("prepared adoption requires the first live Beacon Hill lease")
            if job["frozen_research"] is not None or job["selected_art"] is not None \
                    or job["render_calls_started"] != 0 or job["render_call_log"]:
                raise QueueError("prepared adoption is allowed only before any queue research or render progress")
            cursor.execute(
                "SELECT lease_expires_at > clock_timestamp() FROM public.park_enrichment_jobs WHERE rank = %s",
                (rank,),
            )
            live = cursor.fetchone()
            if not live or not live[0]:
                raise QueueError("lease has expired")
            if _fetch_public_values(cursor, park_id) != art["expected"]:
                raise QueueError("Beacon Hill park values no longer match selected_art.expected")
            _preflight_selected_art(cursor, rank, art)
            cursor.execute(
                """
                UPDATE public.park_enrichment_jobs
                   SET state = 'ready', frozen_research = %s::jsonb,
                       render_calls_started = 5, run_manifest_path = %s,
                       run_manifest_sha256 = %s, render_call_log = %s::jsonb,
                       selected_art = %s::jsonb,
                       lease_expires_at = clock_timestamp() + make_interval(secs => %s)
                 WHERE rank = 1 AND park_id = %s AND state = 'leased'
                   AND lease_token = %s AND lease_expires_at > clock_timestamp()
                   AND attempt_count = 1 AND frozen_research IS NULL
                   AND selected_art IS NULL AND render_calls_started = 0
                RETURNING "rank", park_id, state, lease_token, lease_expires_at, attempt_count,
                          frozen_research, render_calls_started, run_manifest_path, run_manifest_sha256,
                          render_call_log, selected_art, publication_result, published_at, last_error
                """,
                (_json_text(research), last_manifest_path, last_manifest_sha,
                 _json_text(history), _json_text(art), LEASE_SECONDS, park_id, token),
            )
            updated = _job(cursor.fetchone())
            if updated is None:
                raise QueueError("job changed while adopting prepared Beacon Hill work")
            return {"command": "adopt-prepared", "outcome": "adopted", "source_record_sha256": source_sha,
                    "selected_art": art, "job": _job_progress(updated)}


def select_art(conn: Any, rank: int, token: str, art: dict[str, Any]) -> dict[str, Any]:
    with conn.transaction():
        with conn.cursor() as cursor:
            _lock_rollout(cursor)
            job = _select_job(cursor, rank, lock=True)
            if job is None:
                raise QueueError(f"rank {rank} was not found")
            if job["lease_token"] != token:
                raise QueueError("lease token is stale or does not own this job")
            if job["state"] not in {"leased", "ready"}:
                raise QueueError("art can only be selected while the job is leased")
            cursor.execute("SELECT lease_expires_at > clock_timestamp() FROM public.park_enrichment_jobs WHERE rank = %s", (rank,))
            live = cursor.fetchone()
            if not live or not live[0]:
                raise QueueError("lease has expired")
            if job["selected_art"] is not None:
                if job["selected_art"] == art:
                    return {"command": "select-art", "outcome": "already_selected", "job": _job_progress(job)}
                raise QueueError("selected art cannot be replaced")
            if job["frozen_research"] is None:
                raise QueueError("art selection requires frozen research")
            _require_initial_compositions(job["render_calls_started"])
            if job["state"] != "leased":
                raise QueueError("job must be leased before selecting art")
            current = _fetch_public_values(cursor, job["park_id"])
            if current != art["expected"]:
                raise QueueError("park values no longer match selected_art.expected; mark the job for attention")
            _preflight_selected_art(cursor, rank, art)
            cursor.execute(
                """
                UPDATE public.park_enrichment_jobs
                   SET state = 'ready', selected_art = %s::jsonb,
                       lease_expires_at = clock_timestamp() + make_interval(secs => %s)
                 WHERE rank = %s AND state = 'leased' AND lease_token = %s
                   AND lease_expires_at > clock_timestamp() AND selected_art IS NULL
                RETURNING "rank", park_id, state, lease_token, lease_expires_at, attempt_count,
                          frozen_research, render_calls_started, run_manifest_path, run_manifest_sha256,
                          render_call_log, selected_art, publication_result, published_at, last_error
                """,
                (_json_text(art), LEASE_SECONDS, rank, token),
            )
            updated = _job(cursor.fetchone())
            if updated is None:
                raise QueueError("job changed while selecting art")
            return {"command": "select-art", "outcome": "selected", "job": _job_progress(updated)}


def renew_lease(conn: Any, rank: int, token: str) -> dict[str, Any]:
    with conn.transaction():
        with conn.cursor() as cursor:
            _lock_rollout(cursor)
            cursor.execute(
                """
                UPDATE public.park_enrichment_jobs
                   SET lease_expires_at = clock_timestamp() + make_interval(secs => %s)
                 WHERE rank = %s AND state IN ('leased', 'ready', 'publishing')
                   AND lease_token = %s AND lease_expires_at > clock_timestamp()
                RETURNING state, lease_expires_at, render_calls_started, run_manifest_path, run_manifest_sha256
                """,
                (LEASE_SECONDS, rank, token),
            )
            row = cursor.fetchone()
    if row is None:
        raise QueueError("lease token is stale or the lease has expired")
    return {
        "command": "renew", "outcome": "renewed", "rank": rank,
        "state": row[0], "lease_expires_at": row[1].isoformat(),
        "render_calls_started": row[2], "run_manifest_path": row[3],
        "run_manifest_sha256": row[4], "workdir": str(workdir_for(rank)),
    }


def fail_job(conn: Any, rank: int, token: str, reason: str, *, permanent: bool) -> dict[str, Any]:
    reason = reason.strip()
    if not reason:
        raise QueueError("--reason must be non-empty")
    if len(reason) > 500:
        raise QueueError("--reason must be at most 500 characters")
    with conn.transaction():
        with conn.cursor() as cursor:
            _lock_rollout(cursor)
            cursor.execute(
                """
                UPDATE public.park_enrichment_jobs
                   SET state = CASE
                         WHEN %s OR attempt_count >= 3 THEN 'needs_attention'
                         WHEN selected_art IS NULL THEN 'queued'
                         ELSE 'ready'
                       END,
                       lease_token = NULL, lease_expires_at = NULL,
                       last_error = %s
                 WHERE rank = %s AND state IN ('leased', 'ready')
                   AND lease_token = %s AND lease_expires_at > clock_timestamp()
                RETURNING "rank", park_id, state, attempt_count, render_calls_started,
                          run_manifest_path, run_manifest_sha256, selected_art
                """,
                (permanent, reason, rank, token),
            )
            row = cursor.fetchone()
    if row is None:
        raise QueueError("lease token is stale, expired, or publishing has already started")
    return {"command": "fail", "outcome": row[2], "rank": row[0], "park_id": row[1],
            "state": row[2], "attempt_count": row[3], "render_calls_started": row[4],
            "run_manifest_path": row[5], "run_manifest_sha256": row[6], "selected_art": _json_value(row[7]),
            "workdir": str(workdir_for(row[0]))}


def recover_one(conn: Any, rank: int | None, retry_attention: bool) -> dict[str, Any]:
    with conn.transaction():
        with conn.cursor() as cursor:
            _lock_rollout(cursor)
            if retry_attention:
                if rank is None:
                    raise QueueError("--retry-needs-attention requires --rank")
                job = _select_job(cursor, rank, lock=True)
                if job is None:
                    raise QueueError(f"rank {rank} was not found")
                if job["state"] != "needs_attention" or job["lease_token"] is not None:
                    raise QueueError("rank must be an unleased needs_attention job")
                if job["attempt_count"] >= 3:
                    raise QueueError("attempt limit reached; this job cannot be retried")
                next_state = "ready" if job["selected_art"] is not None else "queued"
                cursor.execute(
                    """
                    UPDATE public.park_enrichment_jobs
                       SET state = %s, last_error = NULL
                     WHERE rank = %s AND state = 'needs_attention' AND lease_token IS NULL
                    RETURNING "rank", park_id, state, attempt_count, render_calls_started,
                              run_manifest_path, run_manifest_sha256, selected_art
                    """,
                    (next_state, rank),
                )
                row = cursor.fetchone()
                return {"command": "recover", "outcome": "retry_queued" if row else "superseded",
                        "job": None if row is None else {
                            "rank": row[0], "park_id": row[1], "state": row[2], "attempt_count": row[3],
                            "render_calls_started": row[4], "run_manifest_path": row[5],
                            "run_manifest_sha256": row[6], "selected_art": _json_value(row[7]),
                            "workdir": str(workdir_for(row[0]))}}
            if rank is not None:
                job = _select_job(cursor, rank, lock=True)
                if job is None:
                    raise QueueError(f"rank {rank} was not found")
                cursor.execute("SELECT lease_expires_at <= clock_timestamp() FROM public.park_enrichment_jobs WHERE rank = %s", (rank,))
                expired = cursor.fetchone()
                if job["lease_token"] is None or not expired or not expired[0]:
                    raise QueueError("rank does not have an expired lease")
            result = _recover_expired_locked(conn, rank=rank, resume=False)
            return {"command": "recover", **(result or {"outcome": "no_expired_lease", "job": None})}


def _publisher_command(job: dict[str, Any], args: argparse.Namespace) -> dict[str, Any]:
    art = job["selected_art"]
    update = {
        "park": {"id": job["park_id"], **art["desired"]},
        "expected": art["expected"],
    }
    with tempfile.TemporaryDirectory(prefix="parkdex-authoring-") as directory:
        input_path = Path(directory) / "park-update.json"
        input_path.write_text(_json_text(update) + "\n", encoding="utf-8")
        command = [
            sys.executable, str(PUBLISHER), "--park-json", str(input_path),
            "--badge-webp", art["local_path"], "--account-id", args.account_id,
            "--bucket", args.bucket, "--apply",
        ]
        if args.wrangler_config:
            command.extend(["--wrangler-config", str(args.wrangler_config.resolve())])
        try:
            completed = subprocess.run(command, cwd=ROOT, capture_output=True, text=True, timeout=2 * 60 * 60, check=False)
        except subprocess.TimeoutExpired:
            return {"status": "publisher_timeout", "returncode": None}
        except OSError as exc:
            return {"status": "publisher_start_failed", "error_type": type(exc).__name__}
        if completed.returncode != 0:
            return {"status": "publisher_failed", "returncode": completed.returncode}
        try:
            parsed = json.loads(completed.stdout)
        except json.JSONDecodeError:
            parsed = {"status": "publisher_succeeded", "output_parse": "unavailable"}
        return {"status": "publisher_succeeded", "result": parsed}


def publish_job(conn: Any, rank: int, token: str, args: argparse.Namespace, database_url: str,
                target: str, target_id: str | None, expected_host: str) -> dict[str, Any]:
    with conn.transaction():
        with conn.cursor() as cursor:
            _lock_rollout(cursor)
            job = _select_job(cursor, rank, lock=True)
            if job is None:
                raise QueueError(f"rank {rank} was not found")
            if job["lease_token"] != token:
                raise QueueError("lease token is stale or does not own this job")
            if job["state"] != "ready" or job["selected_art"] is None:
                raise QueueError("publish requires a ready job with selected art")
            cursor.execute("SELECT lease_expires_at > clock_timestamp() FROM public.park_enrichment_jobs WHERE rank = %s", (rank,))
            live = cursor.fetchone()
            if not live or not live[0]:
                raise QueueError("lease has expired")
            art = job["selected_art"]
            _file_digest(art["local_path"], art["sha256"], "selected_art")
            cursor.execute(
                """
                UPDATE public.park_enrichment_jobs
                   SET state = 'publishing', lease_expires_at = clock_timestamp() + make_interval(secs => %s)
                 WHERE rank = %s AND state = 'ready' AND lease_token = %s
                   AND lease_expires_at > clock_timestamp()
                RETURNING "rank", park_id, state, lease_token, lease_expires_at, attempt_count,
                          frozen_research, render_calls_started, run_manifest_path, run_manifest_sha256,
                          render_call_log, selected_art, publication_result, published_at, last_error
                """,
                (LEASE_SECONDS, rank, token),
            )
            publishing_job = _job(cursor.fetchone())
            if publishing_job is None:
                raise QueueError("job changed while starting publication")

    # The R2 upload, CDN verification, and park transaction run outside the queue transaction.
    publisher_result = _publisher_command(publishing_job, args)
    with _connect(database_url) as reconcile_conn:
        verify_target(reconcile_conn, target, target_id, expected_host, database_url)
        with reconcile_conn.transaction():
            with reconcile_conn.cursor() as cursor:
                _lock_rollout(cursor)
                current = _select_job(cursor, rank, lock=True)
                if current is None:
                    raise QueueError("job disappeared during publication")
                if current["lease_token"] != token or current["state"] != "publishing":
                    return {"command": "publish", "outcome": "superseded", "rank": rank,
                            "publisher": publisher_result}
                if _public_matches(cursor, current, desired=True):
                    reconciled = _mark_published(cursor, current, token, publisher_result, require_live=True)
                    return {"command": "publish", "outcome": "published" if reconciled else "lease_expired",
                            "rank": rank, "publisher": publisher_result,
                            "verified": "park-and-asset" if reconciled else None}
                reason = "publisher did not produce the exact desired park values and selected asset"
                if publisher_result["status"] != "publisher_succeeded":
                    reason = f"publisher did not complete ({publisher_result['status']})"
                expected_state = _public_matches(cursor, current, desired=False)
                safe_asset = _asset_is_absent_or_matches(cursor, current["selected_art"])
                retryable = expected_state and safe_asset and current["attempt_count"] < 3
                next_state = "ready" if retryable else "needs_attention"
                if current["attempt_count"] >= 3 and expected_state and safe_asset:
                    reason = "publication failed on the third attempt"
                cursor.execute(
                    """
                    UPDATE public.park_enrichment_jobs
                       SET state = %s, lease_token = NULL, lease_expires_at = NULL,
                           last_error = %s
                     WHERE rank = %s AND state = 'publishing' AND lease_token = %s
                       AND lease_expires_at > clock_timestamp()
                    RETURNING rank
                    """,
                    (next_state, reason, rank, token),
                )
                failed = cursor.fetchone() is not None
                return {"command": "publish", "outcome": next_state if failed else "lease_expired",
                        "rank": rank, "publisher": publisher_result}


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--target", required=True, choices=("staging", "owned-preview"))
    parser.add_argument("--target-id", help="numeric PR id, required for owned-preview")
    parser.add_argument("--expected-database-host", required=True, help="must exactly match DATABASE_URL and the rollout receipt")
    subparsers = parser.add_subparsers(dest="command", required=True)

    status = subparsers.add_parser("status", aliases=("inspect",), help="inspect queue state and durable progress")
    status.add_argument("--rank", type=int)

    subparsers.add_parser("claim", help="claim at most one job, respecting the global active lease")

    freeze = subparsers.add_parser("freeze", help="freeze research evidence before image generation")
    freeze.add_argument("--rank", type=int, required=True)
    freeze.add_argument("--lease-token", required=True)
    freeze.add_argument("--research-json", type=Path, required=True)

    adopt = subparsers.add_parser("adopt-prepared", help="adopt the already-generated, fully audited rank 1 Beacon Hill badge")
    adopt.add_argument("--rank", type=int, choices=(1,), required=True)
    adopt.add_argument("--lease-token", required=True)
    adopt.add_argument("--generation-record", type=Path, required=True)
    adopt.add_argument("--research-json", type=Path, required=True)
    adopt.add_argument("--selected-art-json", type=Path, required=True)

    render = subparsers.add_parser("start-render", help="record the next render call before invoking image generation")
    render.add_argument("--rank", type=int, required=True)
    render.add_argument("--lease-token", required=True)
    render.add_argument("--run-manifest", type=Path, required=True)

    selected = subparsers.add_parser("select-art", help="freeze a selected WebP and park values after render review")
    selected.add_argument("--rank", type=int, required=True)
    selected.add_argument("--lease-token", required=True)
    selected.add_argument("--selected-art-json", type=Path, required=True)

    renew = subparsers.add_parser("renew", help="extend one active lease while work continues")
    renew.add_argument("--rank", type=int, required=True)
    renew.add_argument("--lease-token", required=True)

    publish = subparsers.add_parser("publish", help="publish one ready park through the existing publisher")
    publish.add_argument("--rank", type=int, required=True)
    publish.add_argument("--lease-token", required=True)
    publish.add_argument("--account-id", required=True)
    publish.add_argument("--bucket", required=True)
    publish.add_argument("--wrangler-config", type=Path)

    fail = subparsers.add_parser("fail", help="retry the current rank, or send a permanent failure to needs_attention")
    fail.add_argument("--rank", type=int, required=True)
    fail.add_argument("--lease-token", required=True)
    fail.add_argument("--reason", required=True)
    fail.add_argument("--permanent", action="store_true", help="send this job to needs_attention immediately")

    recover = subparsers.add_parser("recover", help="recover at most one expired lease or explicitly retry one job")
    recover.add_argument("--rank", type=int)
    recover.add_argument("--retry-needs-attention", action="store_true")
    return parser


def _read_json_file(path: Path, label: str) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise QueueError(f"Could not read {label} JSON ({type(exc).__name__})") from None


def run(args: argparse.Namespace) -> dict[str, Any]:
    database_url = os.environ.get("DATABASE_URL")
    if not database_url:
        raise QueueError("set DATABASE_URL in the process environment")
    if args.target == "staging" and args.target_id is not None:
        raise QueueError("--target-id is only valid for --target owned-preview")
    if args.target == "owned-preview" and (args.target_id is None or not re.fullmatch(r"[0-9]+", args.target_id)):
        raise QueueError("owned-preview target requires numeric --target-id")

    research = _read_validated_research(args.research_json) if args.command in {"freeze", "adopt-prepared"} else None
    art = _read_validated_selected_art(args.selected_art_json) if args.command in {"select-art", "adopt-prepared"} else None

    if args.command == "claim":
        with _connect(database_url) as conn:
            verify_target(conn, args.target, args.target_id, args.expected_database_host, database_url)
            return claim_one(conn)
    if args.command in {"status", "inspect"}:
        with _connect(database_url) as conn:
            verify_target(conn, args.target, args.target_id, args.expected_database_host, database_url)
            return inspect_queue(conn, args.rank)
    if args.command == "start-render":
        with _connect(database_url) as conn:
            verify_target(conn, args.target, args.target_id, args.expected_database_host, database_url)
            return checkpoint_render(conn, args.rank, args.lease_token, args.run_manifest)
    if args.command == "recover":
        with _connect(database_url) as conn:
            verify_target(conn, args.target, args.target_id, args.expected_database_host, database_url)
            return recover_one(conn, args.rank, args.retry_needs_attention)
    if args.command == "renew":
        with _connect(database_url) as conn:
            verify_target(conn, args.target, args.target_id, args.expected_database_host, database_url)
            return renew_lease(conn, args.rank, args.lease_token)
    if args.command == "fail":
        with _connect(database_url) as conn:
            verify_target(conn, args.target, args.target_id, args.expected_database_host, database_url)
            return fail_job(conn, args.rank, args.lease_token, args.reason, permanent=args.permanent)
    if args.command == "freeze":
        with _connect(database_url) as conn:
            verify_target(conn, args.target, args.target_id, args.expected_database_host, database_url)
            return freeze_research(conn, args.rank, args.lease_token, research)
    if args.command == "adopt-prepared":
        with _connect(database_url) as conn:
            verify_target(conn, args.target, args.target_id, args.expected_database_host, database_url)
            return adopt_prepared(conn, args.rank, args.lease_token, args.generation_record, research, art)
    if args.command == "select-art":
        with _connect(database_url) as conn:
            verify_target(conn, args.target, args.target_id, args.expected_database_host, database_url)
            return select_art(conn, args.rank, args.lease_token, art)
    if args.command == "publish":
        with _connect(database_url) as conn:
            verify_target(conn, args.target, args.target_id, args.expected_database_host, database_url)
            conn.commit()
            return publish_job(conn, args.rank, args.lease_token, args, database_url,
                               args.target, args.target_id, args.expected_database_host)
    raise QueueError("unsupported command")


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        result = run(args)
    except QueueError as exc:
        print(json.dumps({"error": str(exc)}, sort_keys=True), file=sys.stderr)
        return 2
    except Exception as exc:
        print(json.dumps({"error": f"authoring queue failed ({type(exc).__name__})"}, sort_keys=True), file=sys.stderr)
        return 2
    print(json.dumps(result, indent=2, sort_keys=True, default=str))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
