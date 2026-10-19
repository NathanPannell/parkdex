"""Upload a signed Android App Bundle to a Google Play testing track.

Dry run by default: checks the bundle and the release notes, signs in as the publishing
service account and prints what the track holds now. With --apply it opens an edit, uploads
the bundle, sets the track's release to it and commits the edit.

    python scripts/publish-play.py --aab .codex/releases/<folder>/Parkdex-<name>-vc<n>.aab \
        --notes .codex/releases/<folder>/release-notes.txt [--track internal] [--apply]

The service account key is read from PLAY_SERVICE_ACCOUNT_JSON, or from
~/.codex/private/parkdex-android/play-publisher/service-account.json. Its values are never
printed. The production track is refused unless --allow-production is passed.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import zipfile
from pathlib import Path

PACKAGE_NAME = "app.parkdex"
API = "https://androidpublisher.googleapis.com/androidpublisher/v3/applications"
UPLOAD_API = "https://androidpublisher.googleapis.com/upload/androidpublisher/v3/applications"
SCOPE = "https://www.googleapis.com/auth/androidpublisher"
DEFAULT_KEY = Path.home() / ".codex" / "private" / "parkdex-android" / "play-publisher" / "service-account.json"
TRACKS = ("internal", "alpha", "beta", "production")
NOTES_LIMIT = 500


class PublishError(Exception):
    pass


def parse_release_notes(text: str) -> list[dict[str, str]]:
    """Read Play's console format: one <lang>...</lang> block per language."""
    notes = []
    for language, body in re.findall(r"<([A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*)>\s*(.*?)\s*</\1>", text, re.S):
        body = body.strip()
        if not body:
            raise PublishError(f"Release notes for {language} are empty.")
        if len(body) > NOTES_LIMIT:
            raise PublishError(f"Release notes for {language} are {len(body)} characters; Play allows {NOTES_LIMIT}.")
        notes.append({"language": language, "text": body})
    if not notes:
        raise PublishError("Release notes need at least one <lang>...</lang> block, for example <en-GB>.")
    if len({note["language"] for note in notes}) != len(notes):
        raise PublishError("Release notes name a language twice.")
    return notes


def check_bundle(path: Path) -> None:
    if path.suffix != ".aab" or not path.is_file():
        raise PublishError(f"{path} is not an .aab file.")
    try:
        with zipfile.ZipFile(path) as bundle:
            names = set(bundle.namelist())
    except zipfile.BadZipFile as error:
        raise PublishError(f"{path} is not a valid bundle: {error}") from error
    if "base/manifest/AndroidManifest.xml" not in names or "BundleConfig.pb" not in names:
        raise PublishError(f"{path} has no base module manifest or bundle config.")
    if not any(name.startswith("META-INF/") and name.endswith((".RSA", ".EC", ".DSA")) for name in names):
        raise PublishError(f"{path} is not signed.")


def read_provenance(aab: Path) -> dict:
    """The release build writes build-provenance.json beside the bundle."""
    provenance = aab.with_name("build-provenance.json")
    if not provenance.is_file():
        return {}
    data = json.loads(provenance.read_text(encoding="utf-8-sig"))
    if data.get("applicationId") not in (None, PACKAGE_NAME):
        raise PublishError(f"The bundle was built for {data.get('applicationId')}, not {PACKAGE_NAME}.")
    return data


def release_body(version_code: int, notes: list[dict[str, str]], status: str, version_name: str | None) -> dict:
    name = f"{version_code} ({version_name})" if version_name else str(version_code)
    return {"name": name, "versionCodes": [str(version_code)], "status": status, "releaseNotes": notes}


def describe_track(track: dict) -> str:
    releases = track.get("releases") or []
    if not releases:
        return "no releases"
    return "; ".join(f"{release.get('name', '?')} [{release.get('status', '?')}] codes {','.join(release.get('versionCodes', []))}" for release in releases)


def session(key_path: Path):
    from google.auth.transport.requests import AuthorizedSession
    from google.oauth2 import service_account

    if not key_path.is_file():
        raise PublishError(f"No service account key at {key_path}. Set PLAY_SERVICE_ACCOUNT_JSON or add the key there.")
    credentials = service_account.Credentials.from_service_account_file(str(key_path), scopes=[SCOPE])
    return AuthorizedSession(credentials)


def call(http, method: str, url: str, **kwargs) -> dict:
    response = http.request(method, url, timeout=kwargs.pop("timeout", 120), **kwargs)
    if response.status_code >= 400:
        try:
            message = response.json().get("error", {}).get("message", "")
        except ValueError:
            message = response.text[:300]
        raise PublishError(f"{method} {url.split('/applications/')[-1]} failed with {response.status_code}: {message}")
    return response.json() if response.content else {}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--aab", required=True, type=Path)
    parser.add_argument("--notes", required=True, type=Path, help="release notes in Play's <lang>...</lang> format")
    parser.add_argument("--track", default="internal", choices=TRACKS)
    parser.add_argument("--status", default="completed", choices=("completed", "draft"))
    parser.add_argument("--apply", action="store_true", help="upload and commit; without it nothing changes")
    parser.add_argument("--allow-production", action="store_true")
    parser.add_argument("--changes-not-sent-for-review", action="store_true", help="commit without sending changes for review, when Play asks for it")
    args = parser.parse_args(argv)

    try:
        if args.track == "production" and not args.allow_production:
            raise PublishError("Refusing the production track without --allow-production.")
        check_bundle(args.aab)
        notes = parse_release_notes(args.notes.read_text(encoding="utf-8-sig"))
        provenance = read_provenance(args.aab)
        key_path = Path(os.environ.get("PLAY_SERVICE_ACCOUNT_JSON") or DEFAULT_KEY)
        http = session(key_path)

        base = f"{API}/{PACKAGE_NAME}"
        edit = call(http, "POST", f"{base}/edits", json={})
        edit_url = f"{base}/edits/{edit['id']}"
        committed = False
        try:
            current = call(http, "GET", f"{edit_url}/tracks/{args.track}")
            print(f"{args.track} now: {describe_track(current)}")
            bundles = call(http, "GET", f"{edit_url}/bundles").get("bundles", [])
            highest = max((int(bundle["versionCode"]) for bundle in bundles), default=0)
            expected = provenance.get("versionCode")
            if expected is not None and int(expected) <= highest:
                raise PublishError(f"Version code {expected} is not above the highest uploaded, {highest}.")
            print(
                f"bundle {args.aab.name}: version {expected or '?'} ({provenance.get('versionName') or '?'}), "
                f"source {str(provenance.get('sourceSha') or '?')[:12]}; highest uploaded {highest}"
            )
            if not args.apply:
                print("dry run: nothing uploaded. Pass --apply to upload and release.")
                return 0

            with args.aab.open("rb") as body:
                uploaded = call(
                    http,
                    "POST",
                    f"{UPLOAD_API}/{PACKAGE_NAME}/edits/{edit['id']}/bundles?uploadType=media",
                    data=body,
                    headers={"Content-Type": "application/octet-stream"},
                    timeout=900,
                )
            version_code = int(uploaded["versionCode"])
            if expected is not None and version_code != int(expected):
                raise PublishError(f"Play read version code {version_code}, but the build says {expected}.")
            print(f"uploaded version code {version_code} (sha256 {uploaded.get('sha256', '?')[:12]})")

            release = release_body(version_code, notes, args.status, provenance.get("versionName"))
            call(http, "PUT", f"{edit_url}/tracks/{args.track}", json={"track": args.track, "releases": [release]})
            query = "?changesNotSentForReview=true" if args.changes_not_sent_for_review else ""
            call(http, "POST", f"{edit_url}:commit{query}")
            committed = True
            print(f"released {release['name']} to {args.track} as {args.status}")
            return 0
        finally:
            if not committed:
                # An uncommitted edit changes nothing, but delete it so the next run starts clean.
                try:
                    call(http, "DELETE", edit_url)
                except PublishError:
                    pass
    except PublishError as error:
        print(f"error: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
