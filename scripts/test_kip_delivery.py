"""Release gates that prevent incomplete or cross-environment account deployments."""
import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("kip_delivery", Path(__file__).with_name("kip-delivery.py"))
delivery = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = delivery
SPEC.loader.exec_module(delivery)


class AccountReleaseGates(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.config = delivery.load_config()
        self.touch(self.config["apiEntrypoint"])
        self.touch(self.config["migrationPath"])

    def tearDown(self):
        self.temp.cleanup()

    def touch(self, name):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("", encoding="utf-8")

    def account_files(self):
        for name in self.config["optionalMigrationPaths"]:
            self.touch(name)
        self.touch(self.config["privatePhotos"]["sourcePath"])

    def runtime(self):
        return {
            "SESSION_SECRET": "o" * 48, "AUTH_SESSION_SECRET": "a" * 48,
            "KIP_PHOTO_SERVICE_TOKEN": "p" * 48, "KIP_RETENTION_SECRET": "r" * 48,
            "KIP_PHOTO_SERVICE_URL": "https://parkdex-kip-photos-staging.owned.workers.dev",
            "GOOGLE_WEB_CLIENT_ID": "123456-kip.apps.googleusercontent.com",
            "EMAIL_FROM": "Kip <kip@example.test>",
        }

    def test_bootstrap_runs_existing_migration_only(self):
        self.assertEqual([p.name for p in delivery.migration_paths(self.config, self.root)], ["feedback_001_init.sql"])

    def test_account_code_without_any_migration_fails_closed(self):
        self.touch("worker/accounts/auth.ts")
        with self.assertRaises(delivery.DeliveryError):
            delivery.migration_paths(self.config, self.root)

    def test_partial_account_schema_and_missing_photo_service_fail(self):
        self.touch(self.config["optionalMigrationPaths"][0])
        with self.assertRaises(delivery.DeliveryError):
            delivery.migration_paths(self.config, self.root)
        for name in self.config["optionalMigrationPaths"]:
            self.touch(name)
        with self.assertRaises(delivery.DeliveryError):
            delivery.migration_paths(self.config, self.root)

    def test_complete_migrations_keep_foreign_key_order(self):
        self.account_files()
        self.assertEqual([p.name for p in delivery.migration_paths(self.config, self.root)], [
            "feedback_001_init.sql", "accounts_001_init.sql", "progress_001_init.sql", "interactions_001_init.sql",
        ])

    def test_staging_rejects_preview_photo_origin_and_missing_google(self):
        self.account_files()
        bundle = self.runtime()
        delivery.require_account_runtime(self.config, bundle, self.root)
        for origin in ("https://kip-pr-12.owned.workers.dev", "https://parkdex-kip-photos-staging.owned.workers.dev:444", "https://parkdex-kip-photos-staging.evil.test"):
            with self.subTest(origin=origin), self.assertRaises(delivery.DeliveryError):
                delivery.require_account_runtime(self.config, {**bundle, "KIP_PHOTO_SERVICE_URL": origin}, self.root)
        bundle.pop("GOOGLE_WEB_CLIENT_ID")
        with self.assertRaises(delivery.DeliveryError):
            delivery.require_account_runtime(self.config, bundle, self.root)

    def test_purpose_secrets_must_be_distinct(self):
        self.account_files()
        bundle = self.runtime()
        bundle["AUTH_SESSION_SECRET"] = bundle["SESSION_SECRET"]
        with self.assertRaises(delivery.DeliveryError):
            delivery.require_account_runtime(self.config, bundle, self.root)

    def test_preview_uses_fresh_secrets_without_email_or_google_credentials(self):
        path = self.root / "credentials.json"
        document = {"sessionSecret": "s", "operatorPasswordHash": "h", "authSessionSecret": "a", "photoServiceToken": "p", "retentionSecret": "r"}
        path.write_text(json.dumps(document), encoding="utf-8")
        state = {"headSha": "a" * 40, "accountsPresent": True, "resources": {"photoServiceUrl": "https://owned-preview.workers.dev"}}
        env = delivery.runtime_env_for_preview(self.config, state, "postgres://fresh", path)
        self.assertEqual(env["EMAIL_MODE"], "disabled")
        self.assertEqual(env["KIP_PHOTO_SERVICE_TOKEN"], "p")
        self.assertFalse(set(env) & {"GOOGLE_WEB_CLIENT_ID", "RESEND_API_KEY", "CLOUDFLARE_API_TOKEN", "NEON_API_KEY"})

    def test_all_generated_credentials_are_redacted(self):
        path = self.root / "generated.json"
        with patch.object(delivery, "credential_path", return_value=path):
            delivery.make_operator_credentials(12, "owned-release")
        document = json.loads(path.read_text(encoding="utf-8"))
        self.assertEqual(len(set(document.values())), len(document))
        for secret in document.values():
            self.assertNotIn(secret, delivery.redact("failure " + secret))

    def test_migration_is_atomic_and_stops_on_sql_error(self):
        with patch.object(delivery, "run") as run:
            delivery.run_migration("postgresql://role:secret@ep-owned-test.us-west-2.aws.neon.tech/db", self.root / "migration.sql")
        args = run.call_args.args[0]
        self.assertIn("-1", args)
        self.assertIn("ON_ERROR_STOP=1", args)
        self.assertNotIn("secret", " ".join(args))


if __name__ == "__main__":
    unittest.main()
