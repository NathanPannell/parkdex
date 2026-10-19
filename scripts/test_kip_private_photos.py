"""Provider-free tests for the owned private-photo lifecycle adapter."""

from __future__ import annotations

import importlib.util
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


SPEC = importlib.util.spec_from_file_location("kip_private_photos", Path(__file__).with_name("kip_private_photos.py"))
photos = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(photos)


ACCOUNT_ID = "6f0eb57971124f41fadc7897ace74dac"
SHA = "a" * 40
OTHER_SHA = "b" * 40
BUCKET = "parkdex-kip-photos-staging"


class DeliveryError(RuntimeError):
    pass


class FakeDelivery:
    DeliveryError = DeliveryError
    ROOT = Path(".")

    def __init__(self):
        self.saved = []
        self.registered = []
        self.api_calls = []

    def register_secret(self, value):
        self.registered.append(value)

    def save_json(self, path, value):
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(value), encoding="utf-8")
        self.saved.append(path)

    def api_json(self, base, path, **kwargs):
        self.api_calls.append((base, path, kwargs))
        return {"success": True, "result": {}}

    def safe_env(self, **kwargs):
        return kwargs.get("extra", {})

    def npm_args(self):
        return ["npm"]

    def run(self, args, **kwargs):
        self.last_run = (args, kwargs)
        return ""

    def state_root(self):
        return Path(tempfile.gettempdir()) / "kip-private-photo-test-state"


def config():
    return {
        "repository": "NathanPannell/parkdex-kip",
        "stagingUrl": "https://staging.web.parkdex.app",
        "productionUrl": "https://web.parkdex.app",
        "privatePhotos": {
            "accountId": ACCOUNT_ID,
            "sourcePath": "cloudflare/private-photos.mjs",
            "stagingWorkerName": "parkdex-kip-photos-staging",
            "stagingBucketName": "parkdex-kip-photos-staging",
            "productionWorkerName": "parkdex-kip-photos-production",
            "productionBucketName": "parkdex-kip-photos-production",
            "wranglerVersion": "4.132.0",
            "compatibilityDate": "2026-09-27",
            "retentionCron": "23 9 * * *",
        },
    }


def worker_bindings(identity, release_sha=SHA):
    result = [
        {"name": "KIP_ENVIRONMENT", "type": "plain_text", "text": identity["environment"]},
        {"name": "KIP_REPOSITORY", "type": "plain_text", "text": "NathanPannell/parkdex-kip"},
        {"name": "KIP_RESOURCE_ID", "type": "plain_text", "text": identity["resourceId"]},
        {"name": "KIP_PHOTO_BUCKET", "type": "plain_text", "text": identity["bucketName"]},
        {"name": "RETENTION_URL", "type": "plain_text", "text": identity["retentionUrl"]},
        {"name": "KIP_RELEASE_SHA", "type": "plain_text", "text": release_sha},
        {"name": "RELEASE_SHA", "type": "plain_text", "text": release_sha},
        {"name": "PHOTO_SERVICE_TOKEN", "type": "secret_text"},
        {"name": "PHOTOS", "type": "r2_bucket", "bucket_name": identity["bucketName"]},
        {"name": "ACCOUNT_PHOTOS", "type": "durable_object_namespace", "class_name": "AccountPhotos", "namespace_id": "ns-test"},
        {"name": "KIP_CANDIDATE_SHA", "type": "plain_text", "text": release_sha},
        {"name": "KIP_RETENTION_SECRET", "type": "secret_text"},
    ]
    return result


def staging_state():
    return {"resources": {}, "intent": {}}


class PrivatePhotoAdapterTests(unittest.TestCase):
    def setUp(self):
        self.delivery = FakeDelivery()
        self.cfg = config()
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.delivery.ROOT = self.root
        self.source = self.root / "cloudflare" / "private-photos.mjs"
        self.source.parent.mkdir(parents=True)
        self.source.write_text(
            "\n".join(
                [
                    "export class AccountPhotos {}",
                    "export function createPhotoWorker() {}",
                    "PHOTO_SERVICE_TOKEN ACCOUNT_PHOTOS PHOTOS PHOTO_MAX_BYTES KIP_RETENTION_SECRET RETENTION_URL",
                ]
            ),
            encoding="utf-8",
        )

    def tearDown(self):
        self.temp.cleanup()

    def test_candidate_validation_checks_binding_and_retention_contract_without_provider_calls(self):
        compile_calls = []

        def compiled(_delivery, _config, args, **kwargs):
            self.assertTrue(kwargs["auth_root"].is_dir())
            compile_calls.append((args, kwargs))

        with patch.object(photos, "_wrangler", side_effect=compiled):
            photos.validate_candidate(self.delivery, self.cfg, self.root)
        self.assertEqual(self.delivery.api_calls, [])
        self.assertIn("--dry-run", compile_calls[0][0])
        self.assertIn("--outdir", compile_calls[0][0])
        self.assertTrue(compile_calls[0][1]["credential_free"])
        self.source.write_text("export class AccountPhotos {}", encoding="utf-8")
        with patch.object(photos, "_wrangler", side_effect=AssertionError("invalid source must fail before compile")):
            with self.assertRaisesRegex(DeliveryError, "required storage or retention contract"):
                photos.validate_candidate(self.delivery, self.cfg, self.root)
        self.assertEqual(self.delivery.api_calls, [])

    def test_wranger_config_has_isolated_staging_and_production_resources(self):
        staging = photos._staging_identity(self.cfg)
        staging_cfg = photos._worker_config(self.cfg, staging, SHA)
        self.assertEqual(staging_cfg["r2_buckets"], [{"binding": "PHOTOS", "bucket_name": BUCKET}])
        self.assertEqual(staging_cfg["durable_objects"]["bindings"], [{"name": "ACCOUNT_PHOTOS", "class_name": "AccountPhotos"}])
        self.assertNotIn("PHOTO_SERVICE_TOKEN", json.dumps(staging_cfg))
        self.assertNotIn("triggers", photos._worker_config(self.cfg, staging, SHA, enable_retention=False))
        self.assertEqual(staging_cfg["triggers"]["crons"], ["23 9 * * *"])
        self.assertEqual(staging_cfg["vars"]["RETENTION_URL"], "https://staging.web.parkdex.app/api/retention/interactions/purge")
        self.assertNotIn("KIP_RETENTION_SECRET", json.dumps(staging_cfg))

        production = photos._production_identity(self.cfg)
        production_cfg = photos._worker_config(self.cfg, production, SHA)
        self.assertEqual(production["workerName"], "parkdex-kip-photos-production")
        self.assertEqual(production["bucketName"], "parkdex-kip-photos-production")
        self.assertEqual(production_cfg["r2_buckets"], [{"binding": "PHOTOS", "bucket_name": "parkdex-kip-photos-production"}])
        self.assertEqual(production_cfg["triggers"]["crons"], ["23 9 * * *"])
        self.assertEqual(production_cfg["vars"]["RETENTION_URL"], "https://web.parkdex.app/api/retention/interactions/purge")

    def test_worker_verification_requires_exact_provenance_bindings_and_secret_types(self):
        identity = photos._staging_identity(self.cfg)
        settings = {"bindings": worker_bindings(identity, SHA)}
        result = photos._check_worker_settings(self.delivery, settings, identity, SHA)
        self.assertEqual(result["namespaceId"], "ns-test")
        settings["bindings"][0]["text"] = "production"
        with self.assertRaisesRegex(DeliveryError, "ownership metadata mismatch"):
            photos._check_worker_settings(self.delivery, settings, identity, SHA)

        settings = {"bindings": worker_bindings(identity, SHA)}
        next(item for item in settings["bindings"] if item["name"] == "PHOTO_SERVICE_TOKEN")["type"] = "plain_text"
        with self.assertRaisesRegex(DeliveryError, "PHOTO_SERVICE_TOKEN binding is missing or not secret"):
            photos._check_worker_settings(self.delivery, settings, identity, SHA)

        settings = {"bindings": [item for item in worker_bindings(identity, SHA) if item["name"] != "KIP_RETENTION_SECRET"]}
        with self.assertRaisesRegex(DeliveryError, "KIP_RETENTION_SECRET binding is missing or not secret"):
            photos._check_worker_settings(self.delivery, settings, identity, SHA)

    def test_bucket_privacy_requires_disabled_managed_url_and_no_custom_domains(self):
        responses = [
            {"success": True, "result": {"enabled": False}},
            {"success": True, "result": {"domains": []}},
        ]
        with patch.object(photos, "_api", side_effect=responses) as api:
            photos._require_private_bucket(self.delivery, self.cfg, BUCKET)
            self.assertEqual(api.call_count, 2)
        with patch.object(photos, "_api", return_value={"success": True, "result": {"enabled": True}}):
            with self.assertRaisesRegex(DeliveryError, "public r2.dev access"):
                photos._require_private_bucket(self.delivery, self.cfg, BUCKET)
        with patch.object(
            photos,
            "_api",
            side_effect=[
                {"success": True, "result": {"enabled": False}},
                {"success": True, "result": {"domains": [{"domain": "photos.example.test", "enabled": False}]}},
            ],
        ):
            with self.assertRaisesRegex(DeliveryError, "custom-domain association"):
                photos._require_private_bucket(self.delivery, self.cfg, BUCKET)

    def test_r2_bucket_inventory_follows_every_cursor_page(self):
        pages = [
            {"success": True, "result": {"buckets": [{"name": "one"}]}, "result_info": {"cursor": "next"}},
            {"success": True, "result": {"buckets": [{"name": "two"}]}, "result_info": {}},
        ]
        with patch.object(photos, "_api", side_effect=pages) as api:
            self.assertEqual([item["name"] for item in photos._list_buckets(self.delivery, self.cfg)], ["one", "two"])
        self.assertEqual(api.call_args_list[1].kwargs["query"]["cursor"], "next")

    def test_namespace_inventory_requires_all_pages(self):
        pages = [
            {"success": True, "result": [{"id": "one"}], "result_info": {"total_pages": 2}},
            {"success": True, "result": [{"id": "two"}], "result_info": {"total_pages": 2}},
        ]
        with patch.object(photos, "_api", side_effect=pages) as api:
            self.assertEqual([item["id"] for item in photos._list_namespaces(self.delivery, self.cfg)], ["one", "two"])
        self.assertEqual(api.call_args_list[1].kwargs["query"]["page"], 2)

    def test_photo_token_only_enters_secret_stdin_and_is_registered_for_redaction(self):
        secret = "p" * 64
        self.delivery.npm_args = lambda: ["npm"]
        with patch.dict(os.environ, {}, clear=True):
            photos._wrangler(self.delivery, self.cfg, ["secret", "put", "PHOTO_SERVICE_TOKEN"], cwd=self.root, secret=secret)
        args, kwargs = self.delivery.last_run
        self.assertNotIn(secret, " ".join(args))
        self.assertNotIn(secret, json.dumps(kwargs["env"]))
        self.assertEqual(kwargs["input_text"], secret)

    def test_credential_free_wrangler_compile_ignores_management_oauth_and_api_token(self):
        token = "m" * 64
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {"CLOUDFLARE_API_TOKEN": token}, clear=True):
            photos._wrangler(
                self.delivery,
                self.cfg,
                ["deploy", "--dry-run"],
                cwd=self.root,
                credential_free=True,
                auth_root=Path(directory),
            )
        args, kwargs = self.delivery.last_run
        self.assertIn("wrangler@4.132.0", " ".join(args))
        self.assertNotIn("--yes", args[args.index("--") + 1 :])
        self.assertNotIn("CLOUDFLARE_API_TOKEN", kwargs["env"])
        self.assertNotIn(token, json.dumps(kwargs["env"]))
        self.assertNotIn(token, self.delivery.registered)

    def test_staging_provision_default_is_plan_only_and_journaled(self):
        journal = self.root / "state" / "private-photos-staging.json"
        with patch.object(photos, "_api", side_effect=AssertionError("provider API must not run in plan mode")):
            result = photos.provision_staging(self.delivery, self.cfg, journal, apply=False)
        self.assertEqual(result["status"], "planned")
        saved = json.loads(journal.read_text(encoding="utf-8"))
        self.assertEqual(saved["status"], "planned")
        self.assertEqual(saved["bucketName"], self.cfg["privatePhotos"]["stagingBucketName"])
        self.assertFalse(any("token" in key.lower() or "secret" in key.lower() for key in saved))

    def test_staging_provision_accepts_trusted_candidate_source_and_sha(self):
        candidate = self.root / "candidate"
        worker_source = candidate / "cloudflare" / "private-photos.mjs"
        worker_source.parent.mkdir(parents=True)
        worker_source.write_text("candidate worker", encoding="utf-8")
        journal = self.root / "state" / "private-photos-staging.json"
        self.delivery.read_runtime_bundle = lambda _config, **_kwargs: {
            "KIP_PHOTO_SERVICE_TOKEN": "p" * 64,
            "KIP_RETENTION_SECRET": "r" * 64,
        }
        deploy_args = []

        def deploy(_delivery, _config, source, identity, sha, _secrets, _journal, _state, **_kwargs):
            deploy_args.append((source, identity, sha))
            return {
                "workerName": identity["workerName"],
                "bucketName": identity["bucketName"],
                "photoServiceUrl": "https://photos.workers.dev",
                "releaseSha": sha,
                "doNamespaceId": "ns-staging",
            }

        with (
            patch.object(photos, "validate_candidate") as validate,
            patch.object(photos, "_ensure_bucket"),
            patch.object(photos, "_deploy_worker", side_effect=deploy),
            patch.object(photos, "_health", return_value={"status": "ok", "releaseSha": OTHER_SHA}),
        ):
            result = photos.provision_staging(
                self.delivery,
                self.cfg,
                journal,
                apply=True,
                candidate_root=candidate,
                release_sha=OTHER_SHA,
            )
        self.assertEqual(validate.call_args.args[2], candidate)
        self.assertEqual(deploy_args[0][0], worker_source)
        self.assertEqual(deploy_args[0][2], OTHER_SHA)
        self.assertEqual(result["releaseSha"], OTHER_SHA)

    def test_created_bucket_without_marker_is_recovered_only_from_exact_create_journal(self):
        state = staging_state()
        identity = photos._staging_identity(self.cfg)
        marker = photos._marker(identity)
        state["intent"]["cloudflarePhotos"] = {
            "bucketCreate": {"status": "created", "name": BUCKET, "owner": marker},
        }
        with (
            patch.object(photos, "_bucket_names", return_value={BUCKET}),
            patch.object(photos, "_owner_marker", return_value=None),
            patch.object(photos, "_require_private_bucket"),
            patch.object(photos, "_put_owner_marker") as put,
        ):
            photos._ensure_bucket(self.delivery, self.cfg, identity, None, state)
        put.assert_called_once_with(self.delivery, self.cfg, BUCKET, marker)
        self.assertEqual(state["intent"]["cloudflarePhotos"]["bucketMarker"]["status"], "stored")

    def test_markerless_unjournaled_bucket_is_preserved(self):
        state = staging_state()
        identity = photos._staging_identity(self.cfg)
        with (
            patch.object(photos, "_bucket_names", return_value={BUCKET}),
            patch.object(photos, "_owner_marker", return_value=None),
            patch.object(photos, "_put_owner_marker") as put,
        ):
            with self.assertRaisesRegex(DeliveryError, "without this release's exact ownership marker"):
                photos._ensure_bucket(self.delivery, self.cfg, identity, None, state)
        put.assert_not_called()

    def test_deploy_journals_namespace_before_secret_put_and_defers_health(self):
        state = staging_state()
        identity = photos._staging_identity(self.cfg)
        journal = self.root / "state" / "private-photos-staging.json"
        settings = {"bindings": worker_bindings(identity, SHA)}
        wrangler_calls = []

        def wrangler(_delivery, _config, args, **kwargs):
            wrangler_calls.append(args)
            if args[0] == "secret":
                self.assertEqual(state["resources"]["photoDoNamespaceId"], "ns-created-first")
                self.assertTrue(journal.exists())

        with (
            patch.object(photos, "_wrangler", side_effect=wrangler),
            patch.object(photos, "_verify_namespace", return_value={"id": "ns-created-first", "use_sqlite": True}),
            patch.object(photos, "_worker_settings", side_effect=[None, settings]),
            patch.object(photos, "_list_workers", return_value=[]),
            patch.object(photos, "_check_worker_settings", return_value={"namespaceId": "ns-created-first"}),
            patch.object(photos, "_worker_url", return_value="https://owned.workers.dev"),
            patch.object(photos, "_health", side_effect=AssertionError("deployment must defer health checks")),
        ):
            result = photos._deploy_worker(
                self.delivery,
                self.cfg,
                self.source,
                identity,
                SHA,
                {"PHOTO_SERVICE_TOKEN": "s" * 64},
                journal,
                state,
            )
        self.assertEqual(result["doNamespaceId"], "ns-created-first")
        self.assertEqual(wrangler_calls[0][0], "deploy")
        self.assertEqual(wrangler_calls[0][wrangler_calls[0].index("--tag") + 1], SHA)
        self.assertEqual(wrangler_calls[1][:3], ["secret", "put", "PHOTO_SERVICE_TOKEN"])

    def test_deploy_refuses_same_named_foreign_worker_before_wrangler(self):
        state = staging_state()
        identity = photos._staging_identity(self.cfg)
        bindings = worker_bindings(identity, SHA)
        next(binding for binding in bindings if binding["name"] == "KIP_RESOURCE_ID")["text"] = "foreign-release"
        with (
            patch.object(photos, "_worker_settings", return_value={"bindings": bindings}),
            patch.object(photos, "_wrangler", side_effect=AssertionError("foreign worker must not be overwritten")),
        ):
            with self.assertRaisesRegex(DeliveryError, "ownership metadata mismatch for KIP_RESOURCE_ID"):
                photos._deploy_worker(
                    self.delivery,
                    self.cfg,
                    self.source,
                    identity,
                    SHA,
                    {"PHOTO_SERVICE_TOKEN": "s" * 64},
                    self.root / "state" / "private-photos-staging.json",
                    state,
                )

    def test_staging_health_gate_rejects_different_merged_sha(self):
        identity = photos._staging_identity(self.cfg)
        with (
            patch.object(photos, "_check_bucket_owned", return_value=True),
            patch.object(photos, "_worker_settings", return_value={"bindings": worker_bindings(identity, OTHER_SHA)}),
            patch.object(photos, "_verify_namespace", return_value={"id": "ns-test", "use_sqlite": True}),
            patch.object(photos, "_worker_url", return_value="https://owned.workers.dev"),
            patch.object(photos, "_health", return_value={"status": "ok", "releaseSha": OTHER_SHA}),
        ):
            with self.assertRaisesRegex(DeliveryError, "ownership metadata mismatch for KIP_RELEASE_SHA"):
                photos._verify_staging_resources(self.delivery, self.cfg, SHA)

    def test_production_health_gate_uses_only_production_bucket_worker_and_sha(self):
        identity = photos._production_identity(self.cfg)
        with (
            patch.object(photos, "_check_bucket_owned", return_value=True),
            patch.object(photos, "_worker_settings", return_value={"bindings": worker_bindings(identity, SHA)}),
            patch.object(photos, "_verify_namespace", return_value={"id": "ns-prod", "use_sqlite": True}),
            patch.object(photos, "_worker_url", return_value="https://owned.workers.dev"),
            patch.object(photos, "_health", return_value={"status": "ok", "releaseSha": SHA}),
        ):
            verified = photos._verify_production_resources(self.delivery, self.cfg, SHA)
        self.assertEqual(verified["identity"]["workerName"], "parkdex-kip-photos-production")
        self.assertEqual(verified["identity"]["bucketName"], "parkdex-kip-photos-production")


if __name__ == "__main__":
    unittest.main()
