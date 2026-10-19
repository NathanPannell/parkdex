from __future__ import annotations

import hashlib
import shutil
import sys
import tempfile
import unittest
from contextlib import contextmanager
from pathlib import Path
from typing import Any
from unittest.mock import patch

import importlib.util


_SCRIPT_PATH = Path(__file__).with_name("bootstrap-content.py")
_SPEC = importlib.util.spec_from_file_location("bootstrap_content", _SCRIPT_PATH)
assert _SPEC and _SPEC.loader
bootstrap = importlib.util.module_from_spec(_SPEC)
sys.modules[_SPEC.name] = bootstrap
_SPEC.loader.exec_module(bootstrap)


class FakeCursor:
    def __init__(self, connection: "FakeConnection") -> None:
        self.connection = connection
        self.result: tuple[Any, ...] | None = None
        self.rows: list[tuple[Any, ...]] = []

    def __enter__(self) -> "FakeCursor":
        return self

    def __exit__(self, *_: Any) -> None:
        return None

    def execute(self, sql: str, params: Any = None) -> None:
        compact = " ".join(sql.split())
        self.connection.statements.append((compact, params))
        if compact.startswith("SELECT manifest_version"):
            self.rows = [self.connection.receipt] if self.connection.receipt is not None else []
        elif compact.startswith("SELECT manifest FROM public.version_manifests"):
            self.rows = [(self.connection.manifest,)] if self.connection.manifest is not None else []
        elif compact.startswith("SELECT logical_path, object_key"):
            self.rows = list(self.connection.objects.values())
        elif compact.startswith("SELECT id, name, short"):
            wanted_ids = set(params[0])
            self.rows = [row for park_id, row in self.connection.parks.items() if park_id in wanted_ids]
        elif compact.startswith("SELECT park_id, feature"):
            wanted_ids = set(params[0])
            self.rows = [(park_id, value) for park_id, value in self.connection.boundaries.items() if park_id in wanted_ids]
        elif compact.startswith("SELECT position, name, lng, lat"):
            self.rows = list(self.connection.hubs.values())
        elif compact.startswith("SELECT park_id, walk_m"):
            wanted_ids = set(params[0])
            self.rows = [(park_id, value) for park_id, value in self.connection.settings.items() if park_id in wanted_ids]
        elif compact.startswith("SELECT park_id, hub_position"):
            wanted_ids = set(params[0])
            self.rows = [row for key, row in self.connection.routes.items() if key[0] in wanted_ids]
        elif compact.startswith("SELECT version, manifest_url, manifest_sha256 FROM public.content_map"):
            self.rows = [self.connection.content_map] if self.connection.content_map is not None else []
        elif compact.startswith("INSERT INTO public.parks"):
            self.connection.parks[params["id"]] = tuple(params[field] for field in bootstrap.PARK_FIELDS)
            self.rows = []
        elif compact.startswith("INSERT INTO public.version_manifests"):
            self.connection.manifest = params[1]
            self.rows = []
        elif compact.startswith("INSERT INTO public.r2_objects"):
            self.connection.objects[params["path"]] = (
                params["path"],
                params["key"],
                params["url"],
                params["sha256"],
                params["byte_size"],
                params["content_type"],
            )
            self.rows = []
        elif compact.startswith("INSERT INTO public.boundaries"):
            self.connection.boundaries[params[0]] = params[1]
            self.rows = []
        elif compact.startswith("INSERT INTO public.drive_hubs"):
            self.connection.hubs[params[0]] = tuple(params)
            self.rows = []
        elif compact.startswith("INSERT INTO public.park_drive_settings"):
            self.connection.settings[params[0]] = params[1]
            self.rows = []
        elif compact.startswith("INSERT INTO public.park_drive"):
            self.connection.routes[(params[0], params[1])] = tuple(params)
            self.rows = []
        elif compact.startswith("INSERT INTO public.content_map"):
            self.connection.content_map = tuple(params)
            self.rows = []
        elif compact.startswith("INSERT INTO public.content_bootstrap_receipt"):
            self.connection.receipt = tuple(params)
            self.rows = []
        else:
            self.result = None
            self.rows = []

    def fetchone(self) -> tuple[Any, ...] | None:
        if self.rows:
            return self.rows.pop(0)
        return self.result

    def fetchall(self) -> list[tuple[Any, ...]]:
        rows, self.rows = self.rows, []
        return rows


class FakeConnection:
    def __init__(self) -> None:
        self.receipt: tuple[Any, ...] | None = None
        self.parks: dict[str, tuple[Any, ...]] = {}
        self.manifest: Any = None
        self.objects: dict[str, tuple[Any, ...]] = {}
        self.boundaries: dict[str, Any] = {}
        self.hubs: dict[int, tuple[Any, ...]] = {}
        self.settings: dict[str, Any] = {}
        self.routes: dict[tuple[str, int], tuple[Any, ...]] = {}
        self.content_map: tuple[Any, ...] | None = None
        self.statements: list[tuple[str, Any]] = []
        self.transaction_count = 0

    def cursor(self) -> FakeCursor:
        return FakeCursor(self)

    @contextmanager
    def transaction(self):
        self.transaction_count += 1
        yield

    def __enter__(self) -> "FakeConnection":
        return self

    def __exit__(self, *_: Any) -> None:
        return None


class BootstrapContentTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.baseline = bootstrap.load_baseline()

    def test_loads_and_validates_pinned_public_baseline(self) -> None:
        self.assertEqual(self.baseline.manifest["version"], bootstrap.PINNED_VERSION)
        self.assertEqual(len(self.baseline.parks), 122)
        self.assertEqual(len(self.baseline.boundaries), 122)
        self.assertEqual(len(self.baseline.drive["hubs"]), 8)
        self.assertEqual(len(self.baseline.active_scene_bytes), 20)
        self.assertEqual(
            hashlib.sha256(self.baseline.map_manifest_bytes).hexdigest(),
            self.baseline.map_report["manifestSha256"],
        )

    def test_rejects_changed_tracked_json_before_network_or_database_use(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "database").mkdir()
            (root / "src" / "data").mkdir(parents=True)
            (root / "public").mkdir()
            shutil.copy2(bootstrap.ROOT / "database" / "content-manifest.json", root / "database" / "content-manifest.json")
            shutil.copy2(bootstrap.ROOT / "src" / "data" / "parks.json", root / "src" / "data" / "parks.json")
            shutil.copy2(bootstrap.ROOT / "src" / "data" / "drive.json", root / "src" / "data" / "drive.json")
            shutil.copy2(bootstrap.ROOT / "public" / "boundaries.geojson", root / "public" / "boundaries.geojson")
            (root / "src" / "data" / "parks.json").write_bytes((root / "src" / "data" / "parks.json").read_bytes() + b" ")
            with self.assertRaisesRegex(bootstrap.BootstrapError, "tracked source does not match"):
                bootstrap.load_baseline(root)

    def test_verifies_exact_public_manifest_source_json_and_map_manifest_bytes(self) -> None:
        responses = {
            f"{bootstrap.CDN_ORIGIN}/releases/{bootstrap.PINNED_VERSION}/manifest.json": self.baseline.manifest_bytes,
            **{
                descriptor["url"]: self.baseline.source_bytes[path]
                for path, descriptor in self.baseline.files_by_path.items()
                if path in bootstrap.SOURCE_PATHS
            },
            self.baseline.map_report["manifestUrl"]: self.baseline.map_manifest_bytes,
        }
        responses.update({self.baseline.files_by_path[path]["url"]: content for path, content in self.baseline.active_scene_bytes.items()})
        requested: list[str] = []

        def fetch(url: str) -> bytes:
            requested.append(url)
            return responses[url]

        bootstrap.verify_public_artifacts(self.baseline, fetch)
        self.assertEqual(len(requested), 25)

    def test_rejects_mismatched_public_map_manifest_before_seeding(self) -> None:
        def fetch(url: str) -> bytes:
            if url == self.baseline.map_report["manifestUrl"]:
                return b"{}\n"
            if url.endswith("/manifest.json"):
                return self.baseline.manifest_bytes
            logical_path = next(path for path, item in self.baseline.files_by_path.items() if item["url"] == url)
            if logical_path in self.baseline.active_scene_bytes:
                return self.baseline.active_scene_bytes[logical_path]
            return self.baseline.source_bytes[logical_path]

        with self.assertRaisesRegex(bootstrap.BootstrapError, "map-only manifest bytes"):
            bootstrap.verify_public_artifacts(self.baseline, fetch)

    def test_inserts_public_seed_in_order_and_records_receipt_last(self) -> None:
        connection = FakeConnection()
        applied = bootstrap.seed_once(connection, self.baseline, lambda value: value, "preview")
        self.assertTrue(applied)
        self.assertEqual(connection.transaction_count, 1)
        sql = [statement for statement, _ in connection.statements]
        manifest_index = next(index for index, item in enumerate(sql) if item.startswith("INSERT INTO public.version_manifests"))
        assets_index = next(index for index, item in enumerate(sql) if item.startswith("INSERT INTO public.r2_objects"))
        parks_index = next(index for index, item in enumerate(sql) if item.startswith("INSERT INTO public.parks"))
        receipt_index = next(index for index, item in enumerate(sql) if item.startswith("INSERT INTO public.content_bootstrap_receipt"))
        self.assertLess(manifest_index, assets_index)
        self.assertLess(assets_index, parks_index)
        self.assertEqual(receipt_index, len(sql) - 1)
        self.assertEqual(len(connection.parks), len(self.baseline.parks))
        touched_tables = {item.split("public.", 1)[1].split()[0] for item in sql if "public." in item and item.startswith("INSERT")}
        self.assertEqual(
            touched_tables,
            {
                "version_manifests",
                "r2_objects",
                "drive_hubs",
                "parks",
                "boundaries",
                "park_drive_settings",
                "park_drive",
                "content_map",
                "content_bootstrap_receipt",
            },
        )

    def test_receipt_prevents_deleted_baseline_park_from_being_recreated(self) -> None:
        connection = FakeConnection()
        bootstrap.seed_once(connection, self.baseline, lambda value: value, "staging")
        removed_id = self.baseline.parks[0]["id"]
        connection.parks.pop(removed_id)
        connection.statements.clear()

        applied = bootstrap.seed_once(connection, self.baseline, lambda value: value, "staging")

        self.assertFalse(applied)
        self.assertNotIn(removed_id, connection.parks)
        self.assertFalse(any(sql.startswith("INSERT INTO public.parks") for sql, _ in connection.statements))
        self.assertFalse(any(sql.startswith("INSERT INTO public.content_bootstrap_receipt") for sql, _ in connection.statements))

    def test_refuses_to_record_receipt_when_existing_seed_row_differs(self) -> None:
        connection = FakeConnection()
        park = dict(self.baseline.parks[0])
        park["blurb"] = "an existing authored change"
        connection.parks[park["id"]] = tuple(park[field] for field in bootstrap.PARK_FIELDS)

        with self.assertRaisesRegex(bootstrap.BootstrapError, "existing park differs"):
            bootstrap.seed_once(connection, self.baseline, lambda value: value, "staging")

        self.assertIsNone(connection.receipt)
        self.assertFalse(any(sql.startswith("INSERT INTO public.parks") for sql, _ in connection.statements))

    def test_existing_receipt_must_match_pin_and_can_noop_without_cdn_access(self) -> None:
        connection = FakeConnection()
        connection.receipt = (
            bootstrap.PINNED_VERSION,
            f"{bootstrap.CDN_ORIGIN}/releases/{bootstrap.PINNED_VERSION}/manifest.json",
            self.baseline.manifest_sha256,
        )

        class FakePsycopg:
            @staticmethod
            def connect(*_args: Any, **_kwargs: Any) -> FakeConnection:
                return connection

        with (
            patch.object(bootstrap, "_database_url", return_value="postgresql://hidden"),
            patch.object(bootstrap, "_import_psycopg", return_value=(FakePsycopg, lambda value: value)),
            patch.object(bootstrap, "verify_public_artifacts", side_effect=AssertionError("CDN should not be read")),
        ):
            result = bootstrap.run("staging", True)
        self.assertIn(f"receipt {bootstrap.PINNED_VERSION}", result)

        connection.receipt = ("0" * 64, "https://kip-assets.parkdex.app/releases/" + "0" * 64 + "/manifest.json", "0" * 64)
        with (
            patch.object(bootstrap, "_database_url", return_value="postgresql://hidden"),
            patch.object(bootstrap, "_import_psycopg", return_value=(FakePsycopg, lambda value: value)),
        ):
            with self.assertRaisesRegex(bootstrap.BootstrapError, "receipt does not match"):
                bootstrap.run("staging", True)

    def test_main_cannot_replay_the_historical_public_catalogue(self) -> None:
        with self.assertRaisesRegex(bootstrap.BootstrapError, "preview or staging"):
            bootstrap.run("main", True)


if __name__ == "__main__":
    unittest.main()
