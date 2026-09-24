#!/usr/bin/env python3
"""Serve the Parkdex photo review UI and persist review decisions locally."""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import mimetypes
import os
import tempfile
import threading
import webbrowser
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, unquote, urlsplit, urlunsplit


REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SHORTLIST = REPO_ROOT / "data" / "photo-review-leads-2026-09-24.csv"
DEFAULT_STATE = REPO_ROOT / ".codex" / "photo-source-audit-v3" / "photo-review-decisions.json"
DEFAULT_STATIC = Path(__file__).resolve().parent / "photo-review"
VALID_STATUSES = {"approved", "rejected", "pending"}
MAX_REQUEST_BYTES = 64 * 1024
MAX_NOTE_LENGTH = 4000
SCHEMA_VERSION = 1


class ReviewDataError(RuntimeError):
    """Raised when review input or saved state cannot be used safely."""


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def canonical_landing_url(value: str) -> str:
    """Return a stable URL identity while preserving meaningful path casing."""
    parsed = urlsplit(value.strip())
    if parsed.scheme.lower() not in {"http", "https"} or not parsed.hostname:
        raise ReviewDataError(f"Invalid landing URL: {value!r}")
    hostname = parsed.hostname.lower()
    port = parsed.port
    if port and not ((parsed.scheme.lower() == "http" and port == 80) or (parsed.scheme.lower() == "https" and port == 443)):
        hostname = f"{hostname}:{port}"
    path = parsed.path.rstrip("/") or "/"
    return urlunsplit((parsed.scheme.lower(), hostname, path, "", ""))


def candidate_id(row: dict[str, str]) -> str:
    identity = "\n".join((row["place_id"], row["source"], canonical_landing_url(row["landing_url"])))
    return hashlib.sha256(identity.encode("utf-8")).hexdigest()


def atomic_write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="") as stream:
            stream.write(text)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary_name, path)
    except BaseException:
        try:
            os.unlink(temporary_name)
        except FileNotFoundError:
            pass
        raise


def csv_safe(value: Any) -> Any:
    """Prevent data fields from becoming formulas when a CSV is opened."""
    if not isinstance(value, str):
        return value
    inspected = value.lstrip(" \t\r\n")
    if inspected.startswith(("=", "+", "-", "@")) or value.startswith(("\t", "\r", "\n")):
        return "'" + value
    return value


class ReviewStore:
    def __init__(self, shortlist_path: Path, state_path: Path):
        self.shortlist_path = shortlist_path.resolve()
        self.state_path = state_path.resolve()
        self.approved_export_path = self.state_path.with_name("photo-review-approved.csv")
        self.rejected_export_path = self.state_path.with_name("photo-review-rejected.csv")
        self._lock = threading.RLock()
        self.shortlist_sha256 = file_sha256(self.shortlist_path)
        self.candidates, self.csv_fields = self._read_candidates()
        self.candidates_by_id = {row["candidate_id"]: row for row in self.candidates}
        if len(self.candidates_by_id) != len(self.candidates):
            raise ReviewDataError("The shortlist contains duplicate candidate identities")
        self._exports_need_recovery = self.state_path.exists()
        self._export_warning: str | None = None
        try:
            self._recover_exports()
        except ReviewDataError as exc:
            # Keep the server available to report the state error without
            # modifying either a corrupt file or one tied to another shortlist.
            self._export_warning = str(exc)

    def _read_candidates(self) -> tuple[list[dict[str, str]], list[str]]:
        with self.shortlist_path.open("r", encoding="utf-8-sig", newline="") as stream:
            reader = csv.DictReader(stream)
            fields = list(reader.fieldnames or [])
            required = {"place_id", "place_name", "source", "landing_url"}
            missing = required - set(fields)
            if missing:
                raise ReviewDataError(f"Shortlist is missing required fields: {', '.join(sorted(missing))}")
            rows = []
            for source_row in reader:
                row = {field: source_row.get(field, "") for field in fields}
                row["candidate_id"] = candidate_id(row)
                rows.append(row)
        return rows, fields

    def _empty_state(self) -> dict[str, Any]:
        return {
            "schema_version": SCHEMA_VERSION,
            "shortlist_sha256": self.shortlist_sha256,
            "shortlist_path": str(self.shortlist_path),
            "updated_at": None,
            "decisions": {},
        }

    def load_state(self) -> dict[str, Any]:
        if file_sha256(self.shortlist_path) != self.shortlist_sha256:
            raise ReviewDataError("The shortlist changed while the review server was running. Restart it before saving more decisions.")
        if not self.state_path.exists():
            return self._empty_state()
        try:
            state = json.loads(self.state_path.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, json.JSONDecodeError) as exc:
            raise ReviewDataError(
                f"Saved review state is unreadable and was left untouched: {self.state_path}"
            ) from exc
        if not isinstance(state, dict) or not isinstance(state.get("decisions"), dict):
            raise ReviewDataError(f"Saved review state has an invalid structure and was left untouched: {self.state_path}")
        if state.get("schema_version") != SCHEMA_VERSION:
            raise ReviewDataError(f"Unsupported review state schema version: {state.get('schema_version')!r}")
        saved_hash = state.get("shortlist_sha256")
        if saved_hash != self.shortlist_sha256:
            raise ReviewDataError(
                "The shortlist changed after review began. The saved decisions were left untouched; "
                f"expected {saved_hash}, current {self.shortlist_sha256}."
            )
        return state

    def api_data(self) -> dict[str, Any]:
        with self._lock:
            state = self.load_state()
            self._recover_exports(state)
            result = {
                "candidates": self.candidates,
                "decisions": state["decisions"],
                "shortlist_sha256": self.shortlist_sha256,
                "state_path": str(self.state_path),
                "approved_export_path": str(self.approved_export_path),
                "rejected_export_path": str(self.rejected_export_path),
            }
            if self._export_warning:
                result["warning"] = self._export_warning
            return result

    def save_decision(self, payload: dict[str, Any]) -> tuple[dict[str, Any], str | None]:
        candidate_key = payload.get("candidate_id")
        status = payload.get("status")
        note = payload.get("note", "")
        if not isinstance(candidate_key, str) or candidate_key not in self.candidates_by_id:
            raise KeyError("Unknown candidate_id")
        if status not in VALID_STATUSES:
            raise ValueError("status must be approved, rejected, or pending")
        if not isinstance(note, str):
            raise ValueError("note must be a string")
        if len(note) > MAX_NOTE_LENGTH:
            raise ValueError(f"note must be at most {MAX_NOTE_LENGTH} characters")

        with self._lock:
            state = self.load_state()
            decided_at = utc_now()
            state["decisions"][candidate_key] = {
                "candidate_id": candidate_key,
                "place_id": self.candidates_by_id[candidate_key]["place_id"],
                "status": status,
                "note": note,
                "decided_at": decided_at,
            }
            state["updated_at"] = decided_at
            atomic_write_text(self.state_path, json.dumps(state, indent=2, ensure_ascii=False) + "\n")
            self._exports_need_recovery = True
            self._recover_exports(state)
            return state["decisions"][candidate_key], self._export_warning

    def _recover_exports(self, state: dict[str, Any] | None = None) -> None:
        if not self._exports_need_recovery:
            return
        try:
            current_state = state if state is not None else self.load_state()
            self._write_exports(current_state)
        except (OSError, UnicodeError) as exc:
            self._export_warning = (
                "The decision was saved, but CSV exports could not be refreshed. "
                f"They will be retried on the next request: {exc}"
            )
            return
        self._exports_need_recovery = False
        self._export_warning = None

    def _write_exports(self, state: dict[str, Any]) -> None:
        export_fields = ["candidate_id", *self.csv_fields, "status", "note", "decided_at"]
        for status, path in (("approved", self.approved_export_path), ("rejected", self.rejected_export_path)):
            output = []
            buffer = _StringWriter()
            writer = csv.DictWriter(buffer, fieldnames=export_fields, lineterminator="\n")
            writer.writeheader()
            for row in self.candidates:
                decision = state["decisions"].get(row["candidate_id"])
                if not decision or decision.get("status") != status:
                    continue
                export_row = dict(row)
                export_row.update({
                    "status": status,
                    "note": decision.get("note", ""),
                    "decided_at": decision.get("decided_at", ""),
                })
                writer.writerow({key: csv_safe(value) for key, value in export_row.items()})
            output.append(buffer.value)
            atomic_write_text(path, "".join(output))

    def export_bytes(self, status: str) -> tuple[str, str, bytes]:
        """Return a current download without weakening state fingerprint checks."""
        with self._lock:
            state = self.load_state()
            self._recover_exports(state)
            if status == "all":
                content = (json.dumps(state, indent=2, ensure_ascii=False) + "\n").encode("utf-8")
                return "photo-review-decisions.json", "application/json; charset=utf-8", content
            if status not in {"approved", "rejected"}:
                raise ValueError("status must be approved, rejected, or all")
            export_fields = ["candidate_id", *self.csv_fields, "status", "note", "decided_at"]
            buffer = _StringWriter()
            writer = csv.DictWriter(buffer, fieldnames=export_fields, lineterminator="\n")
            writer.writeheader()
            for row in self.candidates:
                decision = state["decisions"].get(row["candidate_id"])
                if not decision or decision.get("status") != status:
                    continue
                export_row = dict(row)
                export_row.update({
                    "status": status,
                    "note": decision.get("note", ""),
                    "decided_at": decision.get("decided_at", ""),
                })
                writer.writerow({key: csv_safe(value) for key, value in export_row.items()})
            filename = f"photo-review-{status}.csv"
            return filename, "text/csv; charset=utf-8", buffer.value.encode("utf-8")


class _StringWriter:
    """Minimal text stream accepted by csv.DictWriter."""

    def __init__(self) -> None:
        self.parts: list[str] = []

    def write(self, value: str) -> int:
        self.parts.append(value)
        return len(value)

    @property
    def value(self) -> str:
        return "".join(self.parts)


class ReviewRequestHandler(BaseHTTPRequestHandler):
    server_version = "ParkdexPhotoReview/1.0"

    @property
    def review_server(self) -> "ReviewHTTPServer":
        return self.server  # type: ignore[return-value]

    def log_message(self, format_string: str, *args: Any) -> None:
        print(f"[{self.log_date_time_string()}] {format_string % args}")

    def _json(self, status: HTTPStatus, payload: dict[str, Any]) -> None:
        encoded = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(encoded)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(encoded)

    def _loopback_host(self) -> bool:
        host = self.headers.get("Host", "").split(":", 1)[0].strip("[]").lower()
        return host in {"127.0.0.1", "localhost", "::1"}

    def _same_origin(self) -> bool:
        if not self._loopback_host():
            return False
        origin = self.headers.get("Origin")
        if not origin:
            return True
        parsed = urlsplit(origin)
        host = self.headers.get("Host", "").lower()
        return parsed.scheme == "http" and parsed.netloc.lower() == host

    def do_GET(self) -> None:  # noqa: N802
        if not self._loopback_host():
            self._json(HTTPStatus.FORBIDDEN, {"error": "Only loopback requests are allowed"})
            return
        parsed_request = urlsplit(self.path)
        path = parsed_request.path
        if path == "/api/data":
            try:
                self._json(HTTPStatus.OK, self.review_server.store.api_data())
            except ReviewDataError as exc:
                self._json(HTTPStatus.CONFLICT, {"error": str(exc)})
            return
        if path == "/api/export":
            query = parse_qs(parsed_request.query)
            status = query.get("status", [""])[0]
            try:
                filename, content_type, content = self.review_server.store.export_bytes(status)
            except ValueError as exc:
                self._json(HTTPStatus.BAD_REQUEST, {"error": str(exc)})
                return
            except ReviewDataError as exc:
                self._json(HTTPStatus.CONFLICT, {"error": str(exc)})
                return
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(content)))
            self.send_header("Content-Disposition", f'attachment; filename="{filename}"')
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            self.wfile.write(content)
            return
        self._serve_static(path)

    def do_POST(self) -> None:  # noqa: N802
        if urlsplit(self.path).path != "/api/decision":
            self._json(HTTPStatus.NOT_FOUND, {"error": "Not found"})
            return
        if not self._same_origin():
            self._json(HTTPStatus.FORBIDDEN, {"error": "Cross-origin writes are not allowed"})
            return
        media_type = self.headers.get("Content-Type", "").split(";", 1)[0].strip().lower()
        if media_type != "application/json":
            self._json(HTTPStatus.UNSUPPORTED_MEDIA_TYPE, {"error": "Content-Type must be application/json"})
            return
        try:
            length = int(self.headers.get("Content-Length", ""))
        except ValueError:
            length = -1
        if length < 0 or length > MAX_REQUEST_BYTES:
            self._json(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, {"error": "Invalid or oversized request body"})
            return
        try:
            payload = json.loads(self.rfile.read(length))
            if not isinstance(payload, dict):
                raise ValueError("JSON body must be an object")
            decision, warning = self.review_server.store.save_decision(payload)
        except json.JSONDecodeError:
            self._json(HTTPStatus.BAD_REQUEST, {"error": "Request body is not valid JSON"})
            return
        except KeyError as exc:
            self._json(HTTPStatus.NOT_FOUND, {"error": str(exc.args[0])})
            return
        except ValueError as exc:
            self._json(HTTPStatus.BAD_REQUEST, {"error": str(exc)})
            return
        except ReviewDataError as exc:
            self._json(HTTPStatus.CONFLICT, {"error": str(exc)})
            return
        response: dict[str, Any] = {"decision": decision}
        if warning:
            response["warning"] = warning
        self._json(HTTPStatus.OK, response)

    def _serve_static(self, request_path: str) -> None:
        relative = "index.html" if request_path == "/" else unquote(request_path).lstrip("/")
        root = self.review_server.static_dir
        target = (root / relative).resolve()
        try:
            target.relative_to(root)
        except ValueError:
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        if not target.is_file():
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        content = target.read_bytes()
        content_type = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        if content_type.startswith("text/") or content_type in {"application/javascript", "application/json"}:
            content_type += "; charset=utf-8"
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(content)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Security-Policy", "default-src 'self'; img-src 'self' https:; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'")
        self.end_headers()
        self.wfile.write(content)


class ReviewHTTPServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address: tuple[str, int], store: ReviewStore, static_dir: Path):
        self.store = store
        self.static_dir = static_dir.resolve()
        super().__init__(address, ReviewRequestHandler)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--shortlist", type=Path, default=DEFAULT_SHORTLIST)
    parser.add_argument("--state", type=Path, default=DEFAULT_STATE)
    parser.add_argument("--static-dir", type=Path, default=DEFAULT_STATIC)
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--no-browser", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    store = ReviewStore(args.shortlist, args.state)
    server = ReviewHTTPServer(("127.0.0.1", args.port), store, args.static_dir)
    url = f"http://127.0.0.1:{server.server_port}/"
    print(f"Parkdex photo review: {url}")
    print(f"Decisions: {store.state_path}")
    if not args.no_browser:
        threading.Timer(0.2, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping photo review server.")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
