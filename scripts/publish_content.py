"""Publish an exact content snapshot to R2 and verify its public delivery.

Uses the Cloudflare REST API (also used by Wrangler) so no S3 key is needed.
Credentials come from CLOUDFLARE_API_TOKEN or an explicitly supplied Wrangler
config file. Existing objects must already match; this tool never overwrites them.
"""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import hashlib
import json
import os
from pathlib import Path
import sys
import tomllib
from urllib.parse import quote

import requests

CACHE_CONTROL = "public, max-age=31536000, immutable"


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def snapshot_objects(directory):
    directory = Path(directory).resolve()
    manifest_bytes = (directory / "manifest.json").read_bytes()
    manifest = json.loads(manifest_bytes)
    inventory = [{k: item[k] for k in ("path", "byte_size", "sha256")} for item in manifest["files"]]
    if len({x["path"] for x in inventory}) != len(inventory):
        raise ValueError("Duplicate paths in snapshot")
    prefix = "releases/" + manifest["version"] + "/"
    origin = manifest["cdnOrigin"].rstrip("/")
    objects = []
    for item in manifest["files"]:
        path = (directory / "content" / item["path"]).resolve()
        if not path.is_relative_to(directory / "content"):
            raise ValueError("Snapshot path escapes content directory")
        if item["key"] != prefix + item["path"] or item["url"] != origin + "/" + quote(item["key"], safe="/"):
            raise ValueError("Snapshot reference mismatch: " + item["path"])
        data = path.read_bytes()
        if len(data) != item["byte_size"] or sha256(data) != item["sha256"]:
            raise ValueError("Snapshot bytes changed: " + item["path"])
        objects.append((item, path))
    objects.append(({
        "path": "manifest.json", "key": prefix + "manifest.json",
        "url": origin + "/" + prefix + "manifest.json",
        "sha256": sha256(manifest_bytes), "byte_size": len(manifest_bytes),
        "content_type": "application/json",
    }, directory / "manifest.json"))
    return manifest, objects


def token_from(args):
    token = os.environ.get("CLOUDFLARE_API_TOKEN")
    if not token and args.wrangler_config:
        token = tomllib.loads(Path(args.wrangler_config).read_text(encoding="utf-8"))["oauth_token"]
    if not token:
        raise ValueError("Set CLOUDFLARE_API_TOKEN or supply --wrangler-config")
    return token


def upload_one(item, path, base, token):
    url = base + "/" + quote(item["key"], safe="/")
    headers = {"Authorization": "Bearer " + token}
    with requests.Session() as session:
        existing = session.get(url, headers=headers, timeout=60)
        if existing.status_code == 200:
            if len(existing.content) != item["byte_size"] or sha256(existing.content) != item["sha256"]:
                raise ValueError("Refusing to overwrite different existing object: " + item["path"])
            return {"path": item["path"], "status": "already-matches", "sha256": item["sha256"]}
        if existing.status_code != 404:
            raise RuntimeError(f"R2 read failed ({existing.status_code}): {item['path']}")
        headers.update({"Content-Type": item["content_type"], "Cache-Control": CACHE_CONTROL})
        with path.open("rb") as stream:
            response = session.put(url, headers=headers, data=stream, timeout=120)
        if not response.ok:
            raise RuntimeError(f"R2 upload failed ({response.status_code}): {item['path']}")
        check = session.get(url, headers={"Authorization": "Bearer " + token}, timeout=60)
        if check.status_code != 200 or len(check.content) != item["byte_size"] or sha256(check.content) != item["sha256"]:
            raise RuntimeError("R2 byte verification failed: " + item["path"])
    return {"path": item["path"], "status": "uploaded-and-verified", "sha256": item["sha256"]}


def verify_one(item, path):
    response = requests.get(item["url"], timeout=90)
    if response.status_code != 200 or len(response.content) != item["byte_size"] or sha256(response.content) != item["sha256"]:
        raise RuntimeError(f"CDN byte verification failed ({response.status_code}): {item['path']}")
    if response.headers.get("content-type", "").split(";")[0] != item["content_type"].split(";")[0]:
        raise RuntimeError("CDN content type mismatch: " + item["path"])
    if response.headers.get("access-control-allow-origin") != "*":
        raise RuntimeError("CDN CORS missing: " + item["path"])
    if "immutable" not in response.headers.get("cache-control", ""):
        raise RuntimeError("CDN immutable cache header missing: " + item["path"])
    return {"path": item["path"], "status": response.status_code, "sha256": item["sha256"], "byte_size": len(response.content)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["upload", "verify-cdn"])
    parser.add_argument("--snapshot", type=Path, required=True)
    parser.add_argument("--account-id")
    parser.add_argument("--bucket")
    parser.add_argument("--wrangler-config", type=Path)
    parser.add_argument("--report", type=Path, required=True)
    parser.add_argument("--concurrency", type=int, default=4, choices=range(1, 9))
    args = parser.parse_args()
    manifest, objects = snapshot_objects(args.snapshot)
    token = token_from(args) if args.command == "upload" else None
    if args.command == "upload" and (not args.account_id or not args.bucket):
        parser.error("upload requires --account-id and --bucket")
    base = f"https://api.cloudflare.com/client/v4/accounts/{args.account_id}/r2/buckets/{args.bucket}/objects"
    results = []
    # Publish the manifest only after every content object is verified.
    with ThreadPoolExecutor(max_workers=args.concurrency) as pool:
        fn = (lambda pair: upload_one(*pair, base, token)) if args.command == "upload" else (lambda pair: verify_one(*pair))
        futures = [pool.submit(fn, pair) for pair in objects[:-1]]
        for future in as_completed(futures):
            results.append(future.result())
            if len(results) % 20 == 0:
                print(json.dumps({"verified_objects": len(results), "total": len(objects)}), flush=True)
    results.append(fn(objects[-1]))
    report = {"command": args.command, "version": manifest["version"], "object_count": len(objects),
              "total_bytes": sum(item["byte_size"] for item, _ in objects),
              "objects": sorted(results, key=lambda x: x["path"])}
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({key: value for key, value in report.items() if key != "objects"}))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, RuntimeError, requests.RequestException) as exc:
        # Request exceptions are reduced to their type to keep credentials out of logs.
        print(str(exc) if not isinstance(exc, requests.RequestException) else type(exc).__name__, file=sys.stderr)
        sys.exit(1)
