#!/usr/bin/env python3
"""Destructive-safe, private R2 round-trip contract using one random temporary key."""

from __future__ import annotations

import argparse
import json
import os
import secrets
import sys
import time
import uuid
from collections.abc import Callable
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from backend.app.object_storage import ObjectStorageNotFound, R2ObjectStorage


def _milliseconds(started: float) -> float:
    return round((time.perf_counter() - started) * 1000, 2)


def run_contract(
    storage,
    *,
    byte_count: int,
    random_bytes: Callable[[int], bytes] = secrets.token_bytes,
) -> dict:
    key = f"parkdex-contract/{uuid.uuid4().hex}.bin"
    payload = random_bytes(byte_count)
    timings: dict[str, float] = {}
    total_started = time.perf_counter()
    deletion_verified = False
    try:
        started = time.perf_counter()
        storage.put(key, payload, "application/octet-stream")
        timings["put"] = _milliseconds(started)

        started = time.perf_counter()
        received = storage.get(key)
        timings["get"] = _milliseconds(started)
        if received != payload:
            raise RuntimeError("R2 contract read did not match the uploaded bytes")

        started = time.perf_counter()
        storage.delete(key)
        timings["delete"] = _milliseconds(started)

        started = time.perf_counter()
        try:
            storage.get(key)
        except ObjectStorageNotFound:
            timings["missingRead"] = _milliseconds(started)
            deletion_verified = True
        else:
            raise RuntimeError("R2 contract object remained readable after delete")
    finally:
        # A successful delete response is not proof that the object is absent.
        # Retry cleanup after every failed or inconclusive missing-read check.
        if not deletion_verified:
            cleanup_started = time.perf_counter()
            storage.delete(key)
            timings["cleanup"] = _milliseconds(cleanup_started)
    timings["total"] = _milliseconds(total_started)
    return {"status": "success", "byteCount": byte_count, "timingsMs": timings}


def storage_from_environment() -> R2ObjectStorage:
    return R2ObjectStorage(
        endpoint=os.environ.get("R2_ENDPOINT", ""),
        bucket=os.environ.get("R2_BUCKET", ""),
        access_key_id=os.environ.get("R2_ACCESS_KEY_ID", ""),
        secret_access_key=os.environ.get("R2_SECRET_ACCESS_KEY", ""),
        region=os.environ.get("R2_REGION", "auto"),
    )


def main() -> int:
    parser = argparse.ArgumentParser(description="Verify private R2 put/get/delete behavior")
    parser.add_argument("--bytes", type=int, default=4096, dest="byte_count")
    args = parser.parse_args()
    if args.byte_count < 1 or args.byte_count > 8 * 1024 * 1024:
        parser.error("--bytes must be between 1 and 8388608")
    started = time.perf_counter()
    try:
        result = run_contract(storage_from_environment(), byte_count=args.byte_count)
    except Exception as exc:
        # Provider identifiers, endpoints, object keys, and credentials are intentionally omitted.
        print(json.dumps({
            "status": "failure",
            "byteCount": args.byte_count,
            "timingsMs": {"total": _milliseconds(started)},
            "errorType": type(exc).__name__,
        }, separators=(",", ":")))
        return 1
    print(json.dumps(result, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
