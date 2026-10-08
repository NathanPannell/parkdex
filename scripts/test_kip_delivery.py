"""Release gates that prevent incomplete or cross-environment account deployments."""
import importlib.util
import argparse
import contextlib
import hashlib
import json
import os
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

    def content_files(self):
        feature = self.config["contentSync"]
        for name in [
            *feature["supportingMigrationPaths"],
            *feature["migrationPaths"],
            *feature["apiPaths"],
            feature["bootstrapPath"],
            feature["qaSqlPath"],
            *feature["pythonTestPaths"],
            feature["pythonRequirementsPath"],
            feature["legacyImporterPath"],
            feature["legacyImporterTestPath"],
        ]:
            self.touch(name)

    def runtime(self):
        return {
            "SESSION_SECRET": "o" * 48, "AUTH_SESSION_SECRET": "a" * 48,
            "KIP_PHOTO_SERVICE_TOKEN": "p" * 48, "KIP_RETENTION_SECRET": "r" * 48,
            "KIP_PHOTO_SERVICE_URL": "https://parkdex-kip-photos-staging.owned.workers.dev",
            "GOOGLE_WEB_CLIENT_ID": "123456-kip.apps.googleusercontent.com",
            "EMAIL_FROM": "Kip <kip@example.test>",
        }

    def test_release_checks_run_in_order_and_report_each_check(self):
        commands, started, passed = [], [], []
        with patch.object(delivery, "npm_args", return_value=["npm"]), \
             patch.object(delivery, "run", side_effect=lambda args, **_kwargs: commands.append(args) or ""):
            delivery.release_checks(self.root, accounts=False, starting=started.append, passed=passed.append)
        self.assertEqual(started, ["install", "typecheck", "tests", "build"])
        self.assertEqual(passed, ["install", "typecheck", "tests", "build", "delivery-tests"])
        self.assertEqual(commands[0], ["npm", "ci"])
        self.assertIn("unittest", commands[-1])

    def test_candidate_checks_still_journal_every_passed_check(self):
        path = self.root / "journal.json"
        state = {"accountsPresent": False}
        with patch.object(delivery, "npm_args", return_value=["npm"]), \
             patch.object(delivery, "run", return_value=""):
            delivery.candidate_checks(self.root, state, path)
        self.assertEqual([item["check"] for item in state["validation"]], ["install", "typecheck", "tests", "build", "delivery-tests"])
        self.assertEqual(state["status"], "validating-build")
        self.assertEqual(json.loads(path.read_text(encoding="utf-8"))["validation"], state["validation"])

    def test_bootstrap_runs_existing_migration_only(self):
        self.assertEqual([p.name for p in delivery.migration_paths(self.config, self.root)], ["feedback_001_init.sql"])

    def test_independent_migrations_are_appended_last_when_present(self):
        self.account_files()
        for name in self.config["independentMigrationPaths"]:
            self.touch(name)
        self.assertEqual([p.name for p in delivery.migration_paths(self.config, self.root)], [
            "feedback_001_init.sql", "accounts_001_init.sql", "progress_001_init.sql", "interactions_001_init.sql",
            "app_config_001_init.sql", "park_proposals_001_init.sql", "park_drafts_001_init.sql", "app_config_002_global_rules.sql", "park_drafts_002_proposals.sql",
        ])

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

    def test_content_sync_markers_are_all_or_none_and_append_only_allowlisted_migrations(self):
        self.assertFalse(delivery.content_sync_present(self.config, self.root))
        self.assertFalse(delivery.accounts_present(self.config, self.root))
        self.touch(self.config["contentSync"]["apiPaths"][0])
        with self.assertRaises(delivery.DeliveryError):
            delivery.migration_paths(self.config, self.root)

        self.content_files()
        self.assertEqual([p.relative_to(self.root).as_posix() for p in delivery.migration_paths(self.config, self.root)], [
            "database/migrations/feedback_001_init.sql",
            "database/001_cloud_content.sql",
            "database/migrations/content_001_sync.sql",
            "database/migrations/content_002_authoring.sql",
            "database/migrations/content_003_park_maps_link.sql",
        ])
        self.assertFalse(delivery.accounts_present(self.config, self.root))

    def test_tooling_checkout_ignores_existing_publisher_test_without_feature_markers(self):
        self.touch("scripts/test_publish_content.py")
        self.assertTrue((self.root / "scripts" / "test_publish_content.py").is_file())
        self.assertFalse(delivery.content_sync_present(self.config, self.root))

    def test_content_sync_requires_sql_qa_python_tests_and_pinned_dependencies(self):
        self.content_files()
        self.assertTrue(delivery.content_sync_present(self.config, self.root))
        for name in (
            self.config["contentSync"]["qaSqlPath"],
            self.config["contentSync"]["pythonTestPaths"][0],
            self.config["contentSync"]["pythonRequirementsPath"],
            self.config["contentSync"]["legacyImporterPath"],
            self.config["contentSync"]["legacyImporterTestPath"],
        ):
            path = self.root / name
            path.unlink()
            with self.subTest(missing=name), self.assertRaises(delivery.DeliveryError):
                delivery.content_sync_present(self.config, self.root)
            self.touch(name)

    def test_legacy_importer_without_content_sync_fails_closed(self):
        self.touch(self.config["contentSync"]["legacyImporterPath"])
        with self.assertRaises(delivery.DeliveryError):
            delivery.content_sync_present(self.config, self.root)

    def test_account_detection_stays_independent_of_content_migration_count(self):
        self.content_files()
        self.assertFalse(delivery.accounts_present(self.config, self.root))
        self.account_files()
        self.assertTrue(delivery.accounts_present(self.config, self.root))
        self.assertEqual([p.relative_to(self.root).as_posix() for p in delivery.migration_paths(self.config, self.root)], [
            "database/migrations/feedback_001_init.sql",
            "database/001_cloud_content.sql",
            "database/migrations/accounts_001_init.sql",
            "database/migrations/progress_001_init.sql",
            "database/migrations/interactions_001_init.sql",
            "database/migrations/content_001_sync.sql",
            "database/migrations/content_002_authoring.sql",
            "database/migrations/content_003_park_maps_link.sql",
        ])

    def test_preview_empty_gate_allows_only_the_initialized_content_clock_row(self):
        queries = []
        with patch.object(delivery, "preview_psql_query", side_effect=lambda _url, sql: queries.append(sql) or ""):
            delivery.verify_preview_database_empty("postgresql://role:secret@ep-owned-test.us-west-2.aws.neon.tech/db", migration_applied=True, allow_content_clock=True)
        sql = queries[0]
        self.assertIn("SELECT count(*) INTO clock_rows FROM public.content_clock", sql)
        self.assertIn("singleton IS TRUE", sql)
        self.assertIn("revision = 0", sql)
        self.assertIn("retention_floor = 0", sql)
        self.assertIn("last_transaction_id IS NULL", sql)
        self.assertIn("item.table_name = 'content_clock'", sql)
        self.assertIn("IF (item.table_schema", sql)
        self.assertNotIn("IF true OR", sql)

    def test_public_bootstrap_uses_only_the_migration_database_url_and_selected_environment(self):
        self.content_files()
        database_url = "postgresql://kip:secret@ep-owned-test.us-west-2.aws.neon.tech/parkdex_kip"
        with patch.object(delivery, "run") as run:
            delivery.bootstrap_content(self.config, self.root, database_url, "preview")
        args = run.call_args.args[0]
        env = run.call_args.kwargs["env"]
        self.assertEqual(args[-3:], ["--apply", "--environment", "preview"])
        self.assertEqual(env["MIGRATION_DATABASE_URL"], database_url)
        self.assertNotIn("DATABASE_URL", env)
        self.assertNotIn("NEON_API_KEY", env)
        self.assertNotIn("CLOUDFLARE_API_TOKEN", env)
        with self.assertRaisesRegex(delivery.DeliveryError, "preview or staging"):
            delivery.bootstrap_content(self.config, self.root, database_url, "main")

    def test_content_sql_qa_migrates_bootstraps_and_runs_rollback_only(self):
        self.content_files()
        self.touch(self.config["contentSync"]["qaSqlPath"])
        qa_path = self.root / self.config["contentSync"]["qaSqlPath"]
        steps = []
        qa_targets = []
        commands = []
        def qa_run(args, **_kwargs):
            commands.append(args)
            if any("FROM pg_catalog.pg_database" in arg for arg in args):
                return ""
            if any("FROM information_schema.tables" in arg for arg in args):
                return "0"
            return ""
        with patch.object(delivery, "candidate_sql_env", return_value={"PGHOST": "127.0.0.1", "PGPORT": "55437", "PGDATABASE": "kip_qa_candidate", "PGUSER": "kip_qa", "PGPASSWORD": "qa-only"}), \
             patch.object(delivery, "candidate_psql_args", return_value=["psql"]), \
             patch.object(delivery, "run", side_effect=qa_run), \
             patch.object(delivery, "migration_paths", return_value=[self.root / "feedback.sql", self.root / "content.sql"]), \
             patch.object(delivery, "run_candidate_sql_file", side_effect=lambda path, env, **kwargs: (
                 steps.append((path.name, kwargs.get("transactional", True))),
                 qa_targets.append(dict(env)) if path == qa_path else None,
             )), \
             patch.object(delivery, "bootstrap_content", side_effect=lambda _config, _root, url, environment: steps.append(("bootstrap", environment, url))):
            delivery.run_content_sync_sql_qa(self.config, self.root)
        self.assertEqual(steps[:2], [("feedback.sql", True), ("content.sql", True)])
        self.assertEqual(steps[2][:2], ("bootstrap", "preview"))
        self.assertRegex(steps[2][2], r"/kip_qa_content_sync_[0-9a-f]{32}$")
        self.assertEqual(steps[3], (qa_path.name, False))
        self.assertEqual(len(qa_targets), 1)
        self.assertEqual(qa_targets[0]["PGHOST"], "127.0.0.1")
        self.assertRegex(qa_targets[0]["PGDATABASE"], r"^kip_qa_content_sync_[0-9a-f]{32}$")
        create_sql = next(args[-1] for args in commands if args[-1].startswith("CREATE DATABASE"))
        drop_sql = next(args[-1] for args in commands if args[-1].startswith("DROP DATABASE"))
        self.assertEqual(create_sql.replace("CREATE", "DROP"), drop_sql)

    def test_content_sql_qa_owns_its_rollback_transaction(self):
        env = {"PGHOST": "127.0.0.1", "PGPORT": "55437", "PGDATABASE": "kip_qa_content_sync_test", "PGUSER": "kip_qa", "PGPASSWORD": "qa-only"}
        with patch.object(delivery, "candidate_psql_args", return_value=["psql"]), patch.object(delivery, "run") as run:
            delivery.run_candidate_sql_file(self.root / "qa-content-sync.sql", env, cwd=self.root, transactional=False)
        args = run.call_args.args[0]
        self.assertEqual(args, ["psql", "-f", str(self.root / "qa-content-sync.sql")])

    def test_content_sql_qa_runner_passes_loopback_endpoint_and_owned_database_to_psql(self):
        database_name = "kip_qa_content_sync_" + "a" * 32
        env = {
            "PGHOST": "127.0.0.1", "PGPORT": "55437", "PGDATABASE": database_name,
            "PGUSER": "kip_qa", "PGPASSWORD": "qa-only",
        }
        with patch.object(delivery, "psql_executable", return_value="psql"), patch.object(delivery, "run") as run:
            delivery.run_candidate_sql_file(self.root / "qa-content-sync.sql", env, cwd=self.root, transactional=False)
        args = run.call_args.args[0]
        self.assertEqual(args[args.index("-h") + 1], "127.0.0.1")
        self.assertEqual(args[args.index("-d") + 1], database_name)
        self.assertEqual(args[-2:], ["-f", str(self.root / "qa-content-sync.sql")])

    def test_content_sql_qa_refuses_a_preexisting_owned_name_without_dropping_it(self):
        self.content_files()
        self.touch(self.config["contentSync"]["qaSqlPath"])
        with patch.object(delivery, "candidate_sql_env", return_value={"PGHOST": "127.0.0.1", "PGPORT": "55437", "PGDATABASE": "kip_qa_candidate", "PGUSER": "kip_qa", "PGPASSWORD": "qa-only"}), \
             patch.object(delivery, "candidate_psql_args", return_value=["psql"]), \
             patch.object(delivery, "run", return_value="occupied") as run:
            with self.assertRaises(delivery.DeliveryError):
                delivery.run_content_sync_sql_qa(self.config, self.root)
        self.assertEqual(run.call_count, 1)
        self.assertIn("pg_catalog.pg_database", " ".join(run.call_args.args[0]))

    def test_legacy_import_pg_qa_uses_its_own_empty_database_and_drops_it(self):
        self.content_files()
        commands = []
        def qa_run(args, **kwargs):
            commands.append((args, kwargs))
            if any("FROM information_schema.tables" in arg for arg in args):
                return "0"
            return ""
        local_env = {
            "PGHOST": "127.0.0.1", "PGPORT": "55438", "PGDATABASE": "kip_qa_candidate",
            "PGUSER": "kip_qa", "PGPASSWORD": "qa-only",
        }
        with patch.object(delivery, "candidate_sql_env", return_value=local_env), \
             patch.object(delivery, "psql_executable", return_value="psql"), \
             patch.object(delivery, "run", side_effect=qa_run):
            delivery.run_legacy_import_postgres_qa(self.config, self.root)
        create = next(args for args, _ in commands if args[-1].startswith("CREATE DATABASE"))
        database_name = create[-1].split('"')[1]
        self.assertRegex(database_name, r"^kip_qa_legacy_import_[0-9a-f]{32}$")
        self.assertNotEqual(database_name, local_env["PGDATABASE"])
        self.assertEqual(commands[-1][0][-1], f'DROP DATABASE "{database_name}"')
        test_command, test_kwargs = next((args, kwargs) for args, kwargs in commands if "PostgreSQLImportTests" in args)
        self.assertEqual(test_command[-2:], [str(self.root / self.config["contentSync"]["legacyImporterTestPath"]), "PostgreSQLImportTests"])
        self.assertEqual(test_kwargs["env"]["PGDATABASE"], database_name)
        self.assertTrue(test_kwargs["env"]["LEGACY_IMPORT_TEST_DATABASE_URL"].endswith("/" + database_name))
        self.assertFalse(any("feedback_001_init.sql" in " ".join(args) for args, _ in commands))

    def test_legacy_import_pg_qa_does_not_drop_a_preexisting_name(self):
        self.content_files()
        local_env = {
            "PGHOST": "127.0.0.1", "PGPORT": "55438", "PGDATABASE": "kip_qa_candidate",
            "PGUSER": "kip_qa", "PGPASSWORD": "qa-only",
        }
        with patch.object(delivery, "candidate_sql_env", return_value=local_env), \
             patch.object(delivery, "psql_executable", return_value="psql"), \
             patch.object(delivery, "run", return_value="1") as run:
            with self.assertRaises(delivery.DeliveryError):
                delivery.run_legacy_import_postgres_qa(self.config, self.root)
        self.assertEqual(run.call_count, 1)
        self.assertIn("pg_catalog.pg_database", " ".join(run.call_args.args[0]))

    def test_legacy_import_pg_qa_drops_its_database_when_regression_fails(self):
        self.content_files()
        commands = []
        def qa_run(args, **_kwargs):
            commands.append(args)
            if any("PostgreSQLImportTests" == item for item in args):
                raise delivery.DeliveryError("regression failed")
            if any("FROM information_schema.tables" in item for item in args):
                return "0"
            return ""
        local_env = {
            "PGHOST": "127.0.0.1", "PGPORT": "55438", "PGDATABASE": "kip_qa_candidate",
            "PGUSER": "kip_qa", "PGPASSWORD": "qa-only",
        }
        with patch.object(delivery, "candidate_sql_env", return_value=local_env), \
             patch.object(delivery, "psql_executable", return_value="psql"), \
             patch.object(delivery, "run", side_effect=qa_run):
            with self.assertRaisesRegex(delivery.DeliveryError, "regression failed"):
                delivery.run_legacy_import_postgres_qa(self.config, self.root)
        created_name = next(args[-1].split('"')[1] for args in commands if args[-1].startswith("CREATE DATABASE"))
        self.assertEqual(commands[-1][-1], f'DROP DATABASE "{created_name}"')

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

    def test_main_content_gate_checks_pointer_shape_and_exact_manifest_hash(self):
        origin = "https://kip-assets.parkdex.app"
        manifest_bytes = b'{"version":"' + b"a" * 64 + b'","cdnOrigin":"' + origin.encode() + b'","files":[]}'
        pinned_path = self.root / "database" / "content-manifest.json"
        pinned_path.parent.mkdir(parents=True, exist_ok=True)
        pinned_path.write_bytes(manifest_bytes)
        pointer = {
            "schema": "parkdex.content-channel/v1",
            "environment": "main",
            "generation": 1,
            "releaseId": "a" * 64,
            "manifestUrl": f"{origin}/releases/{'a' * 64}/manifest.json",
            "manifestSha256": hashlib.sha256(manifest_bytes).hexdigest(),
            "minimumReaderVersion": 1,
        }
        with patch.object(delivery, "ROOT", self.root), \
             patch.object(delivery, "http_json", return_value=(200, pointer)), \
             patch.object(delivery, "http_bytes", return_value=(200, manifest_bytes)):
            delivery.verify_main_content_channel(self.config)

        with patch.object(delivery, "ROOT", self.root), \
             patch.object(delivery, "http_json", return_value=(200, {**pointer, "releaseId": None})), \
             self.assertRaises(delivery.DeliveryError):
            delivery.verify_main_content_channel(self.config)

        with patch.object(delivery, "ROOT", self.root), \
             patch.object(delivery, "http_json", return_value=(200, pointer)), \
             patch.object(delivery, "http_bytes", return_value=(200, b"{}")), \
             self.assertRaisesRegex(delivery.DeliveryError, "hash"):
            delivery.verify_main_content_channel(self.config)

        wrong_baseline = json.dumps({"version": "b" * 64}, separators=(",", ":")).encode()
        pinned_path.write_bytes(wrong_baseline)
        with patch.object(delivery, "ROOT", self.root), \
             patch.object(delivery, "http_json", return_value=(200, pointer)), \
             self.assertRaisesRegex(delivery.DeliveryError, "baseline"):
            delivery.verify_main_content_channel(self.config)

    def test_production_database_urls_must_match_neon_main_read_write_endpoint(self):
        endpoints = {"endpoints": [{
            "branch_id": self.config["neonProductionBranchId"],
            "type": "read_write",
            "host": "ep-main.us-west-2.aws.neon.tech",
        }]}
        main_url = "postgresql://kip:secret@ep-main-pooler.us-west-2.aws.neon.tech/parkdex_kip"
        staging_url = "postgresql://kip:secret@ep-staging.us-west-2.aws.neon.tech/parkdex_kip"
        with patch.dict(os.environ, {}, clear=True), patch.object(delivery, "neon_request", return_value=endpoints) as neon:
            delivery.verify_production_database_urls(self.config, main_url, main_url)
            self.assertEqual(neon.call_args.args[1], f"/projects/{self.config['neonProjectId']}/branches/{self.config['neonProductionBranchId']}/endpoints")
            with self.assertRaisesRegex(delivery.DeliveryError, "Neon main branch"):
                delivery.verify_production_database_urls(self.config, main_url, staging_url)

    def test_staging_database_urls_must_match_the_new_staging_child_branch(self):
        endpoints = {"endpoints": [{
            "branch_id": self.config["neonStagingBranchId"],
            "type": "read_write",
            "host": "ep-shiny-cherry-akobwdis.c-3.us-west-2.aws.neon.tech",
        }]}
        staging_url = "postgresql://kip:secret@ep-shiny-cherry-akobwdis-pooler.c-3.us-west-2.aws.neon.tech/parkdex_kip"
        main_url = "postgresql://kip:secret@ep-main.us-west-2.aws.neon.tech/parkdex_kip"
        with patch.dict(os.environ, {}, clear=True), patch.object(delivery, "neon_request", return_value=endpoints) as neon:
            delivery.verify_staging_database_urls(self.config, staging_url, staging_url)
            self.assertEqual(neon.call_args.args[1], f"/projects/{self.config['neonProjectId']}/branches/{self.config['neonStagingBranchId']}/endpoints")
            with self.assertRaisesRegex(delivery.DeliveryError, "Neon staging branch"):
                delivery.verify_staging_database_urls(self.config, staging_url, main_url)

    def test_production_migrations_do_not_replay_the_historical_content_bootstrap(self):
        self.content_files()
        args = argparse.Namespace(sha="a" * 40, apply=True)
        bundle = {"DATABASE_URL": "postgresql://kip:secret@ep-main.us-west-2.aws.neon.tech/parkdex_kip"}
        with patch.object(delivery, "ROOT", self.root), \
             patch.object(delivery, "load_config", return_value=self.config), \
             patch.object(delivery, "verify_git_sha"), \
             patch.object(delivery, "verify_main_content_channel"), \
             patch.object(delivery, "staging_api_state", return_value=(True, True)), \
             patch.object(delivery, "migration_paths", return_value=[self.root / "migration.sql"]), \
             patch.object(delivery, "content_sync_present", return_value=True), \
             patch.object(delivery, "read_runtime_bundle", return_value=bundle), \
             patch.object(delivery, "verify_runtime_bundle"), \
             patch.object(delivery, "verify_production_runtime_branch"), \
             patch.object(delivery, "require_account_runtime"), \
             patch.object(delivery, "run_migration"), \
             patch.object(delivery, "bootstrap_content") as bootstrap:
            delivery.migration_release(args, "production")
        bootstrap.assert_not_called()

    def test_production_runtime_bundle_is_separate_and_uses_production_photo_worker(self):
        bundle = {
            "DATABASE_URL": "postgresql://kip:secret@ep-main.us-west-2.aws.neon.tech/parkdex_kip",
            "RESEND_API_KEY": "resend-secret",
            "EMAIL_FROM": "Parkdex <hello@example.test>",
            "EMAIL_REPLY_TO": "support@example.test",
            "OPERATOR_EMAIL": "ops@example.test",
            "OPERATOR_PASSWORD_HASH": "ab" * 16 + ":" + "cd" * 32,
            "SESSION_SECRET": "o" * 48,
            "AUTH_SESSION_SECRET": "a" * 48,
            "KIP_PHOTO_SERVICE_URL": "https://parkdex-kip-photos-production.example.workers.dev",
            "KIP_PHOTO_SERVICE_TOKEN": "p" * 48,
            "KIP_RETENTION_SECRET": "r" * 48,
            "GOOGLE_WEB_CLIENT_ID": "123456-kip.apps.googleusercontent.com",
        }
        with patch.dict(os.environ, {"KIP_PRODUCTION_RUNTIME_JSON": json.dumps(bundle)}, clear=True):
            self.assertEqual(delivery.read_runtime_bundle(self.config, environment="production"), bundle)
        with patch.dict(os.environ, {"KIP_STAGING_RUNTIME_JSON": "{}"}, clear=True), \
             self.assertRaisesRegex(delivery.DeliveryError, "KIP_PRODUCTION_RUNTIME_JSON"):
            delivery.read_runtime_bundle(self.config, environment="production")

        extra = {"OPENROUTER_API_KEY": "or-secret", "POSTHOG_PROJECT_KEY": "phc_public"}
        with patch.dict(os.environ, {"KIP_PRODUCTION_RUNTIME_JSON": json.dumps(bundle), "KIP_PRODUCTION_EXTRA_RUNTIME_JSON": json.dumps(extra)}, clear=True):
            merged = delivery.read_runtime_bundle(self.config, environment="production")
        self.assertEqual(merged, bundle | extra)
        self.assertEqual(delivery.production_runtime_env(self.config, merged, "a" * 40, api_present=True)["OPENROUTER_API_KEY"], "or-secret")
        for invalid in ({"DATABASE_URL": "postgresql://other"}, {"UNDOCUMENTED_KEY": "x"}, {"OPENROUTER_API_KEY": ""}):
            with patch.dict(os.environ, {"KIP_PRODUCTION_RUNTIME_JSON": json.dumps(bundle), "KIP_PRODUCTION_EXTRA_RUNTIME_JSON": json.dumps(invalid)}, clear=True), \
                 self.assertRaisesRegex(delivery.DeliveryError, "KIP_PRODUCTION_EXTRA_RUNTIME_JSON"):
                delivery.read_runtime_bundle(self.config, environment="production")

        self.account_files()
        production = self.runtime() | {
            "KIP_PHOTO_SERVICE_URL": "https://parkdex-kip-photos-production.owned.workers.dev",
            "GOOGLE_WEB_CLIENT_ID": "123456-kip.apps.googleusercontent.com",
        }
        delivery.require_account_runtime(self.config, production, self.root, environment="production")
        with self.assertRaises(delivery.DeliveryError):
            delivery.require_account_runtime(self.config, self.runtime(), self.root, environment="production")
        runtime = delivery.production_runtime_env(self.config, bundle, "a" * 40, api_present=True)
        self.assertEqual(runtime["CONTENT_CHANNEL"], "main")
        self.assertEqual(runtime["PUBLIC_APP_URL"], "https://web.parkdex.app")

    def test_production_dispatch_stages_domain_until_exact_release_verification(self):
        self.assertEqual(delivery.vercel_release_target_args("production"), ["--prod", "--skip-domain"])
        self.assertEqual(delivery.vercel_release_target_args("staging"), ["--target", "preview"])
        with self.assertRaises(delivery.DeliveryError):
            delivery.vercel_release_target_args("preview")

    def test_exact_release_sha_is_bound_to_the_correct_push_branch(self):
        sha = "a" * 40
        def git_result(*args):
            return "" if args and args[0] == "status" else sha

        with patch.object(delivery, "git", side_effect=git_result), \
             patch.dict(os.environ, {"GITHUB_REF": "refs/heads/main"}, clear=True):
            delivery.verify_git_sha(sha, production_only=True)
            with self.assertRaisesRegex(delivery.DeliveryError, "staging branch"):
                delivery.verify_git_sha(sha, staging_only=True)
        with patch.object(delivery, "git", side_effect=git_result), \
             patch.dict(os.environ, {"GITHUB_REF": "refs/heads/staging"}, clear=True):
            with self.assertRaisesRegex(delivery.DeliveryError, "main branch"):
                delivery.verify_git_sha(sha, production_only=True)

    def test_first_staging_release_can_verify_known_cutover_sha_on_legacy_alias(self):
        sha = self.config["legacyStagingCutoverSha"]
        deployment = {
            "createdAt": 1,
            "readyState": "READY",
            "target": None,
            "meta": {"githubCommitSha": sha, "kipEnvironment": "staging"},
        }
        def response(url):
            if url == self.config["stagingUrl"] + "/release.json":
                return (404, None)
            if url == "https://" + self.config["legacyStagingAlias"] + "/release.json":
                return (200, {"sha": sha, "environment": "staging"})
            self.fail(f"unexpected release URL: {url}")

        with patch.object(delivery, "list_vercel_deployments", return_value=[deployment]) as inventory, \
             patch.object(delivery, "http_json", side_effect=response):
            delivery.ensure_previous_release_resolved(self.config, "prj_test", "staging")
        self.assertNotIn("target", inventory.call_args.kwargs)

    def test_legacy_staging_fallback_is_limited_to_the_known_cutover_sha(self):
        sha = "a" * 40
        deployment = {
            "createdAt": 1,
            "readyState": "READY",
            "target": None,
            "meta": {"githubCommitSha": sha, "kipEnvironment": "staging"},
        }
        def response(url):
            if url == self.config["stagingUrl"] + "/release.json":
                return (404, None)
            if url == "https://" + self.config["legacyStagingAlias"] + "/release.json":
                return (200, {"sha": sha, "environment": "staging"})
            self.fail(f"unexpected release URL: {url}")

        with patch.object(delivery, "list_vercel_deployments", return_value=[deployment]), \
             patch.object(delivery, "http_json", side_effect=response), \
             self.assertRaisesRegex(delivery.DeliveryError, "stable URL verification"):
            delivery.ensure_previous_release_resolved(self.config, "prj_test", "staging")

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

    def test_candidate_sql_credentials_are_local_only_and_provider_secrets_are_removed(self):
        values = {"PGHOST": "127.0.0.1", "PGPORT": "55437", "PGDATABASE": "kip_qa_candidate", "PGUSER": "kip_qa", "PGPASSWORD": "qa-only", "NEON_API_KEY": "persistent-secret"}
        with patch.dict(os.environ, values, clear=True):
            env = delivery.candidate_sql_env()
            self.assertNotIn("NEON_API_KEY", env)
            self.assertEqual(env["PGDATABASE"], "kip_qa_candidate")
            self.assertNotIn("qa-only", delivery.redact("failure qa-only"))
        for overrides in ({"PGHOST": "ep-staging.neon.tech"}, {"PGDATABASE": "parkdex_kip"}, {"PGPORT": "65536"}):
            with patch.dict(os.environ, {**values, **overrides}, clear=True), self.assertRaises(delivery.DeliveryError):
                delivery.candidate_sql_env()

    def test_staging_bootstrap_source_requires_current_browser_verified_preview(self):
        head, base, candidate = "a" * 40, "b" * 40, "c" * 40
        path = self.root / "preview.json"
        state = {
            "schema": "parkdex-kip.preview/v1", "repository": delivery.REPOSITORY,
            "pullRequest": 12, "releaseId": "a1111111-1111-4111-8111-111111111111",
            "status": "ready-for-browser-verification", "accountsPresent": True,
            "headSha": head, "baseSha": base, "candidateSha": candidate,
            "browserVerifiedHeadSha": head, "browserVerifiedCandidateSha": candidate,
            "browserVerifiedDeploymentId": "dpl_owned", "browserVerifiedAt": "2026-09-28T00:00:00Z",
            "resources": {"vercelDeploymentId": "dpl_owned"}, "url": "https://owned.vercel.app",
        }
        pr = {"number": 12, "state": "OPEN", "isDraft": True, "isCrossRepository": False,
              "baseRefName": "staging", "headRefName": "feat/accounts", "headRefOid": head}
        with patch.object(delivery, "journal_path", return_value=path), patch.object(delivery, "gh_pr", return_value=pr), patch.object(delivery, "fetch_pr_head", return_value=head), patch.object(delivery, "photo_provider") as provider, patch.object(delivery, "git") as git, patch.object(delivery, "vercel_request", return_value={"readyState": "READY", "url": "owned.vercel.app"}), patch.object(delivery, "verify_deployment"), patch.object(delivery, "verify_release_url"):
            for change in ({"browserVerifiedHeadSha": None}, {"browserVerifiedCandidateSha": "d" * 40},
                           {"browserVerifiedDeploymentId": "dpl_other"}, {"headSha": "d" * 40},
                           {"baseSha": "e" * 40}, {"status": "failed-needs-teardown"}):
                path.write_text(json.dumps({**state, **change}), encoding="utf-8")
                with self.subTest(change=change), self.assertRaises(delivery.DeliveryError):
                    delivery.verified_photo_source(self.config, 12, base)
            provider.assert_not_called()
            path.write_text(json.dumps(state), encoding="utf-8")
            git.side_effect = [f"{candidate} {base} {head}", "f" * 40, "f" * 40]
            self.assertEqual(delivery.verified_photo_source(self.config, 12, base), state)
            provider.return_value.verify_preview.assert_called_once()

    def test_browser_attestation_binds_current_preview_and_deployment(self):
        path = self.root / "preview.json"
        state = {
            "headSha": "a" * 40, "candidateSha": "c" * 40,
            "resources": {"vercelDeploymentId": "dpl_owned"},
        }
        args = argparse.Namespace(pr=12, deployment_id="dpl_owned")
        with patch.object(delivery, "load_config", return_value=self.config), \
             patch.object(delivery, "assert_clean_staging_harness", return_value=("b" * 40, None)), \
             patch.object(delivery, "lifecycle_lock", return_value=contextlib.nullcontext()), \
             patch.object(delivery, "journal_path", return_value=path), \
             patch.object(delivery, "verified_photo_source", return_value=state):
            delivery.attest_preview_browser(args)
            saved = json.loads(path.read_text(encoding="utf-8"))
            self.assertEqual(saved["browserVerifiedHeadSha"], state["headSha"])
            self.assertEqual(saved["browserVerifiedCandidateSha"], state["candidateSha"])
            self.assertEqual(saved["browserVerifiedDeploymentId"], args.deployment_id)
            self.assertTrue(saved["browserVerifiedAt"])
            with self.assertRaises(delivery.DeliveryError):
                delivery.attest_preview_browser(argparse.Namespace(pr=12, deployment_id="dpl_wrong"))
            self.assertEqual(json.loads(path.read_text(encoding="utf-8")), saved)


if __name__ == "__main__":
    unittest.main()
