import hashlib
from contextlib import nullcontext
from io import BytesIO
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from PIL import Image

from publish_park_update import MAX_BADGE_BYTES, PARK_FIELDS, ParkUpdate, PublishError, asset_descriptor, run, update_in_transaction


def sample_park() -> dict[str, object]:
    return {
        "id": "park-one",
        "name": "Example Park",
        "short": "Example",
        "category": "regional",
        "region": "Island",
        "lat": 48.4,
        "lng": -123.3,
        "biome": "forest",
        "shape": "circle",
        "rarity": "common",
        "scene": None,
        "seed": 101,
        "blurb": "A small fixture park.",
    }


def valid_webp() -> bytes:
    buffer = BytesIO()
    Image.new("RGB", (1, 1), (24, 80, 120)).save(buffer, format="WEBP")
    return buffer.getvalue()


class MemoryConnection:
    def __init__(self, park: dict[str, object]):
        self.park = dict(park)
        self.assets: dict[str, dict[str, object]] = {}
        self.asset_inserts = 0
        self.park_updates = 0

    def transaction(self):
        return nullcontext()

    def cursor(self):
        return MemoryCursor(self)


class MemoryCursor:
    def __init__(self, connection: MemoryConnection):
        self.connection = connection
        self.row = None
        self.rowcount = 0

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, statement: str, parameters=None):
        sql = " ".join(statement.split())
        if sql.startswith("SELECT id, name, short,"):
            self.row = tuple(self.connection.park[field] for field in PARK_FIELDS)
            self.rowcount = 1
            return
        if sql.startswith("SELECT logical_path, object_key, url, sha256, byte_size, content_type"):
            logical_path = parameters[0]
            asset = self.connection.assets.get(logical_path)
            self.row = None if asset is None else tuple(asset[key] for key in ("logical_path", "object_key", "url", "sha256", "byte_size", "content_type"))
            self.rowcount = 1 if self.row else 0
            return
        if sql.startswith("INSERT INTO public.r2_objects"):
            self.connection.asset_inserts += 1
            self.connection.assets.setdefault(parameters["logical_path"], dict(parameters))
            self.rowcount = 1
            return
        if sql.startswith("UPDATE public.parks SET "):
            assignments = sql.split(" SET ", 1)[1].split(" WHERE ", 1)[0]
            fields = [item.split("=", 1)[0].strip() for item in assignments.split(",")]
            for field in fields:
                self.connection.park[field] = parameters[field]
            self.connection.park_updates += 1
            self.rowcount = 1
            return
        raise AssertionError(f"Unexpected SQL in test double: {sql}")

    def fetchone(self):
        return self.row


class PublishParkUpdateTests(unittest.TestCase):
    def test_badge_asset_descriptor_uses_slug_and_immutable_content_hash(self):
        with tempfile.TemporaryDirectory() as directory:
            image = Path(directory) / "selected.webp"
            data = valid_webp()
            image.write_bytes(data)
            update = ParkUpdate("park-one", {"scene": "example-badge"}, {}, None)

            descriptor = asset_descriptor(update, image)

        digest = hashlib.sha256(data).hexdigest()
        self.assertEqual(descriptor["logical_path"], "art/badges/scenes/example-badge.webp")
        self.assertEqual(descriptor["sha256"], digest)
        self.assertEqual(descriptor["object_key"], f"releases/{digest}/art/badges/scenes/example-badge.webp")
        self.assertEqual(descriptor["content_type"], "image/webp")

    def test_badge_over_four_mib_is_rejected_before_upload(self):
        with tempfile.TemporaryDirectory() as directory:
            image = Path(directory) / "selected.webp"
            image.write_bytes(b"RIFF\x04\x00\x00\x00WEBP" + b"x" * (MAX_BADGE_BYTES - 11))
            update = ParkUpdate("park-one", {"scene": "example-badge"}, {}, None)

            with self.assertRaisesRegex(PublishError, "delivery limit"):
                asset_descriptor(update, image)

    def test_badge_with_only_a_webp_header_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            image = Path(directory) / "selected.webp"
            image.write_bytes(b"RIFF\x04\x00\x00\x00WEBP")
            update = ParkUpdate("park-one", {"scene": "example-badge"}, {}, None)

            with self.assertRaisesRegex(PublishError, "not a decodable WebP image"):
                asset_descriptor(update, image)

    def test_exact_replay_does_not_insert_asset_or_update_park_twice(self):
        park = sample_park()
        image_bytes = valid_webp()
        digest = hashlib.sha256(image_bytes).hexdigest()
        descriptor = {
            "logical_path": "art/badges/scenes/example-badge.webp",
            "object_key": f"releases/{digest}/art/badges/scenes/example-badge.webp",
            "url": f"https://kip-assets.parkdex.app/releases/{digest}/art/badges/scenes/example-badge.webp",
            "sha256": digest,
            "byte_size": len(image_bytes),
            "content_type": "image/webp",
        }
        update = ParkUpdate(
            "park-one",
            {"blurb": "A memorable new description.", "rarity": "rare", "scene": "example-badge"},
            {"blurb": park["blurb"], "rarity": "common", "scene": None},
            None,
        )
        connection = MemoryConnection(park)

        first = update_in_transaction(connection, update, descriptor)
        replay = update_in_transaction(connection, update, descriptor)

        self.assertEqual(first, "updated")
        self.assertEqual(replay, "already-current")
        self.assertEqual(connection.park_updates, 1)
        self.assertEqual(connection.asset_inserts, 1)
        self.assertEqual(connection.park["scene"], "example-badge")
        self.assertEqual(connection.park["blurb"], "A memorable new description.")
        self.assertEqual(connection.park["rarity"], "rare")

    def test_metadata_only_update_preserves_scene_and_all_other_park_fields(self):
        park = sample_park()
        park["scene"] = "existing-scene"
        connection = MemoryConnection(park)
        update = ParkUpdate("park-one", {"blurb": "Updated description."}, {"blurb": park["blurb"]}, None)

        result = update_in_transaction(connection, update, None)

        self.assertEqual(result, "updated")
        self.assertEqual(connection.park["blurb"], "Updated description.")
        self.assertEqual(connection.park["scene"], "existing-scene")
        for field in set(PARK_FIELDS) - {"blurb"}:
            self.assertEqual(connection.park[field], park[field])

    def test_upload_failure_stops_before_any_database_operation(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            update_path = root / "update.json"
            image_path = root / "selected.webp"
            update_path.write_text(
                json.dumps(
                    {
                        "id": "park-one",
                        "scene": "new-badge",
                        "blurb": "A new description.",
                    }
                ),
                encoding="utf-8",
            )
            image_path.write_bytes(valid_webp())
            args = type(
                "Args",
                (),
                {
                    "park_json": update_path,
                    "badge_webp": image_path,
                    "apply": True,
                    "account_id": "test-account",
                    "bucket": "test-bucket",
                    "wrangler_config": None,
                },
            )()
            with (
                patch.dict("os.environ", {"DATABASE_URL": "postgresql://example.invalid/db"}),
                patch("publish_park_update.publish_content.token_from", return_value="test-token"),
                patch("publish_park_update.publish_content.upload_one", side_effect=RuntimeError("R2 upload failed (503)")),
                patch("publish_park_update.publish_content.verify_one") as verify,
                patch("publish_park_update.apply_database_update") as database,
            ):
                with self.assertRaisesRegex(PublishError, "R2 upload failed"):
                    run(args)

            verify.assert_not_called()
            database.assert_not_called()

    def test_cdn_verification_completes_before_database_update(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            update_path = root / "update.json"
            image_path = root / "selected.webp"
            image_bytes = valid_webp()
            update_path.write_text(
                json.dumps(
                    {
                        "id": "park-one",
                        "scene": "new-badge",
                        "blurb": "A new description.",
                    }
                ),
                encoding="utf-8",
            )
            image_path.write_bytes(image_bytes)
            args = type(
                "Args",
                (),
                {
                    "park_json": update_path,
                    "badge_webp": image_path,
                    "apply": True,
                    "account_id": "test-account",
                    "bucket": "test-bucket",
                    "wrangler_config": None,
                },
            )()
            events = []
            with (
                patch.dict("os.environ", {"DATABASE_URL": "postgresql://example.invalid/db"}),
                patch("publish_park_update.publish_content.token_from", return_value="test-token"),
                patch(
                    "publish_park_update.publish_content.upload_one", side_effect=lambda *args: events.append("upload") or {"status": "uploaded-and-verified"}
                ),
                patch(
                    "publish_park_update.publish_content.verify_one",
                    side_effect=lambda *args: events.append("verify")
                    or {
                        "status": 200,
                        "sha256": hashlib.sha256(image_bytes).hexdigest(),
                        "byte_size": len(image_bytes),
                    },
                ),
                patch("publish_park_update.apply_database_update", side_effect=lambda *args: events.append("database") or "updated"),
            ):
                result = run(args)

        self.assertEqual(events, ["upload", "verify", "database"])
        self.assertEqual(result["database_result"], "updated")

    def test_cdn_verification_failure_stops_before_database_update(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            update_path = root / "update.json"
            image_path = root / "selected.webp"
            update_path.write_text(json.dumps({"id": "park-one", "scene": "new-badge"}), encoding="utf-8")
            image_path.write_bytes(valid_webp())
            args = type(
                "Args",
                (),
                {
                    "park_json": update_path,
                    "badge_webp": image_path,
                    "apply": True,
                    "account_id": "test-account",
                    "bucket": "test-bucket",
                    "wrangler_config": None,
                },
            )()
            with (
                patch.dict("os.environ", {"DATABASE_URL": "postgresql://example.invalid/db"}),
                patch("publish_park_update.publish_content.token_from", return_value="test-token"),
                patch("publish_park_update.publish_content.upload_one", return_value={"status": "uploaded-and-verified"}),
                patch("publish_park_update.publish_content.verify_one", side_effect=RuntimeError("CDN byte verification failed (404)")),
                patch("publish_park_update.apply_database_update") as database,
            ):
                with self.assertRaisesRegex(PublishError, "CDN byte verification failed"):
                    run(args)

            database.assert_not_called()

    def test_default_run_is_local_dry_run_only(self):
        with tempfile.TemporaryDirectory() as directory:
            update_path = Path(directory) / "update.json"
            update_path.write_text(json.dumps({"id": "park-one", "blurb": "Updated description."}), encoding="utf-8")
            args = type(
                "Args",
                (),
                {
                    "park_json": update_path,
                    "badge_webp": None,
                    "apply": False,
                    "account_id": None,
                    "bucket": None,
                    "wrangler_config": None,
                },
            )()
            with patch("publish_park_update.apply_database_update") as database:
                result = run(args)
            database.assert_not_called()

        self.assertEqual(result["mode"], "dry-run")
        self.assertEqual(result["asset_upload"], "not-needed")
        self.assertFalse(result["database_writes"])


if __name__ == "__main__":
    unittest.main()
