"""Release gates that prevent incomplete or cross-environment account deployments."""
import importlib.util
import argparse
import contextlib
import hashlib
import io
import json
import os
import sys
import tempfile
import unittest
import urllib.error
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
            "feedback_001_init.sql", "accounts_001_init.sql", "progress_001_init.sql", "interactions_001_init.sql", "interactions_002_db_events.sql",
            "app_config_001_init.sql", "park_proposals_001_init.sql", "park_drafts_001_init.sql", "app_config_002_global_rules.sql", "park_drafts_002_proposals.sql",
            "game_001_init.sql",
            "park_proposals_002_moderation.sql",
            "osm_parks_001_init.sql",
            "founders_001_init.sql",
            "feedback_002_archive.sql",
            "app_config_003_ota_publishes.sql",
            "operator_analytics_001_indexes.sql",
            "founders_002_reviews.sql",
            "founders_003_park_removed.sql",
            "game_002_points.sql",
            "social_001_friends.sql",
            "osm_parks_002_sources.sql",
            "game_003_crews.sql",
            "game_004_badges.sql",
            "game_005_dex.sql",
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
            "feedback_001_init.sql", "accounts_001_init.sql", "progress_001_init.sql", "interactions_001_init.sql", "interactions_002_db_events.sql",
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
            "database/migrations/content_004_catalogue_release.sql",
            "database/migrations/content_005_park_visibility.sql",
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
            "database/migrations/interactions_002_db_events.sql",
            "database/migrations/content_001_sync.sql",
            "database/migrations/content_002_authoring.sql",
            "database/migrations/content_003_park_maps_link.sql",
            "database/migrations/content_004_catalogue_release.sql",
            "database/migrations/content_005_park_visibility.sql",
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

    def test_extra_runtime_bundle_carries_a_validated_native_google_client(self):
        bundle = {
            "DATABASE_URL": "postgresql://kip:secret@ep-staging.us-west-2.aws.neon.tech/parkdex_kip",
            "RESEND_API_KEY": "resend-secret",
            "EMAIL_FROM": "Parkdex <hello@example.test>",
            "EMAIL_REPLY_TO": "support@example.test",
            "OPERATOR_EMAIL": "ops@example.test",
            "OPERATOR_PASSWORD_HASH": "ab" * 16 + ":" + "cd" * 32,
        } | self.runtime()
        native = "654321-android.apps.googleusercontent.com"
        with patch.dict(os.environ, {"KIP_STAGING_RUNTIME_JSON": json.dumps(bundle), "KIP_STAGING_EXTRA_RUNTIME_JSON": json.dumps({"GOOGLE_NATIVE_CLIENT_ID": native})}, clear=True):
            merged = delivery.read_runtime_bundle(self.config, environment="staging")
        self.assertEqual(merged["GOOGLE_NATIVE_CLIENT_ID"], native)
        runtime = delivery.staging_runtime_env(self.config, merged, "a" * 40, api_present=True)
        self.assertEqual(runtime["GOOGLE_NATIVE_CLIENT_ID"], native)
        self.assertEqual(runtime["GOOGLE_WEB_CLIENT_ID"], bundle["GOOGLE_WEB_CLIENT_ID"])
        self.assertNotIn("GOOGLE_NATIVE_CLIENT_ID", delivery.staging_runtime_env(self.config, bundle, "a" * 40, api_present=True))

        self.account_files()
        for invalid in ("", "android-client", "654321-android.apps.googleusercontent.com.evil.test"):
            with self.subTest(value=invalid), self.assertRaisesRegex(delivery.DeliveryError, "GOOGLE_NATIVE_CLIENT_ID"):
                delivery.require_account_runtime(self.config, bundle | {"GOOGLE_NATIVE_CLIENT_ID": invalid}, self.root)

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


class ReleaseUrlPropagation(unittest.TestCase):
    config = {"releasePath": "/release.json", "healthPath": "/api/health"}
    url = "https://staging.web.parkdex.app"
    sha = "a" * 40
    old = "b" * 40

    def verify(self, responses, *, api_present=True, timeout=90):
        now = [0.0]
        sleeps = []

        def sleep(seconds):
            sleeps.append(seconds)
            now[0] += seconds

        def respond(url):
            outcome = responses.pop(0)
            if isinstance(outcome, Exception):
                raise outcome
            return outcome

        with patch.object(delivery, "http_json", side_effect=respond):
            delivery.verify_release_url(
                self.config, self.url, self.sha, "staging", api_present=api_present,
                timeout=timeout, sleep=sleep, clock=lambda: now[0],
            )
        return sleeps

    def release(self, sha):
        return (200, {"sha": sha, "environment": "staging"})

    def health(self, sha):
        return (200, {"ok": True, "releaseSha": sha})

    def test_passes_immediately_when_the_alias_serves_the_release(self):
        self.assertEqual(self.verify([self.release(self.sha), self.health(self.sha)]), [])

    def test_waits_for_a_stale_alias_to_serve_the_new_release(self):
        sleeps = self.verify([
            self.release(self.old),
            (404, None),
            self.release(self.sha), self.health(self.old),
            self.release(self.sha), self.health(self.sha),
        ])
        self.assertEqual(sleeps, [delivery.RELEASE_VERIFY_INTERVAL_SECONDS] * 3)

    def test_retries_when_the_host_is_briefly_unreachable(self):
        error = delivery.DeliveryError("HTTP check could not reach staging.web.parkdex.app.")
        self.assertEqual(len(self.verify([error, self.release(self.sha), self.health(self.sha)])), 1)

    def test_keeps_the_release_error_after_the_deadline(self):
        responses = [self.release(self.old)] * 40
        with self.assertRaisesRegex(delivery.DeliveryError, r"^The deployed /release\.json does not match the expected SHA and environment\.$"):
            self.verify(responses, timeout=12)
        self.assertEqual(len(responses), 40 - 4)

    def test_keeps_the_health_error_after_the_deadline(self):
        responses = [self.release(self.sha), self.health(self.old)] * 40
        with self.assertRaisesRegex(delivery.DeliveryError, r"^The API health check did not confirm the expected release SHA\.$"):
            self.verify(responses, timeout=12)

    def test_skips_health_when_no_api_is_deployed(self):
        self.assertEqual(self.verify([self.release(self.sha)], api_present=False), [])

    def test_default_wait_is_bounded(self):
        self.assertLessEqual(delivery.RELEASE_VERIFY_TIMEOUT_SECONDS, 120)
        self.assertGreater(delivery.RELEASE_VERIFY_TIMEOUT_SECONDS, delivery.RELEASE_VERIFY_INTERVAL_SECONDS)


class TeardownStagingSha(unittest.TestCase):
    config = {"stagingUrl": "https://staging.web.parkdex.app", "releasePath": "/release.json", "healthPath": "/api/health"}
    merged = "a" * 40
    later = "c" * 40
    pr = {"state": "MERGED", "mergedAt": "2026-10-08T20:12:05Z", "mergeCommit": {"oid": "a" * 40}}

    def check(self, deployed, *, ancestors=(), staging_verified="1", state=None):
        state = {"apiPresent": True, "accountsPresent": True} if state is None else state
        compared = []

        def is_ancestor(ancestor, descendant):
            compared.append((ancestor, descendant))
            return (ancestor, descendant) in ancestors

        with patch.dict(os.environ, {"STAGING_VERIFIED": staging_verified}), \
             patch.object(delivery, "http_json", return_value=(200, {"sha": deployed, "environment": "staging"})), \
             patch.object(delivery, "git") as git, \
             patch.object(delivery, "is_ancestor", side_effect=is_ancestor), \
             patch.object(delivery, "verify_release_url") as verify, \
             patch.object(delivery, "photo_provider") as provider, \
             contextlib.redirect_stdout(io.StringIO()):
            delivery.verify_teardown_condition(self.config, state, self.pr)
        return state, verify, provider, git, compared

    def contained(self):
        return {(self.merged, self.later), (self.later, "refs/remotes/origin/staging")}

    def test_exact_merge_sha_still_verifies_without_git(self):
        state, verify, provider, git, compared = self.check(self.merged)
        self.assertEqual(verify.call_args.args[2], self.merged)
        provider.return_value.verify_staging.assert_called_once()
        self.assertEqual(provider.return_value.verify_staging.call_args.args[2], self.merged)
        self.assertEqual(state["stagingVerifiedSha"], self.merged)
        git.assert_not_called()
        self.assertEqual(compared, [])

    def test_later_staging_release_containing_the_merge_is_accepted(self):
        state, verify, provider, git, compared = self.check(self.later, ancestors=self.contained())
        git.assert_called_once_with("fetch", "--no-tags", "origin", "+refs/heads/staging:refs/remotes/origin/staging")
        self.assertEqual(verify.call_args.args[1:4], (self.config["stagingUrl"], self.later, "staging"))
        self.assertTrue(verify.call_args.kwargs["api_present"])
        self.assertEqual(provider.return_value.verify_staging.call_args.args[2], self.later)
        self.assertEqual(state["stagingVerifiedSha"], self.later)
        self.assertEqual(state["stagingMergeSha"], self.merged)

    def test_staging_release_without_the_merge_falls_back_to_the_exact_sha(self):
        state, verify, _, _, _ = self.check(self.later, ancestors={(self.later, "refs/remotes/origin/staging")})
        self.assertEqual(verify.call_args.args[2], self.merged)

    def test_release_outside_staging_history_falls_back_to_the_exact_sha(self):
        _, verify, _, _, _ = self.check(self.later, ancestors={(self.merged, self.later)})
        self.assertEqual(verify.call_args.args[2], self.merged)

    def test_unreachable_staging_falls_back_to_the_exact_sha(self):
        with patch.dict(os.environ, {"STAGING_VERIFIED": "1"}), \
             patch.object(delivery, "http_json", side_effect=delivery.DeliveryError("HTTP check could not reach staging.")), \
             patch.object(delivery, "verify_release_url") as verify, \
             patch.object(delivery, "photo_provider"):
            delivery.verify_teardown_condition(self.config, {}, self.pr)
        self.assertEqual(verify.call_args.args[2], self.merged)

    def test_staging_verified_is_still_required(self):
        with self.assertRaisesRegex(delivery.DeliveryError, "STAGING_VERIFIED=1"):
            self.check(self.later, ancestors=self.contained(), staging_verified="")

    def test_photo_check_is_skipped_without_accounts(self):
        _, _, provider, _, _ = self.check(self.later, ancestors=self.contained(), state={"apiPresent": False})
        provider.assert_not_called()

    def test_is_ancestor_uses_git_merge_base(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            env = {**os.environ, "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@example.invalid",
                   "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@example.invalid"}
            delivery.run(["git", "-C", directory, "init", "-q"], env=env)
            delivery.run(["git", "-C", directory, "commit", "-q", "--allow-empty", "-m", "one"], env=env)
            first = delivery.run(["git", "-C", directory, "rev-parse", "HEAD"], env=env)
            delivery.run(["git", "-C", directory, "commit", "-q", "--allow-empty", "-m", "two"], env=env)
            second = delivery.run(["git", "-C", directory, "rev-parse", "HEAD"], env=env)
            with patch.object(delivery, "ROOT", root), patch.object(delivery, "safe_env", return_value=env):
                self.assertTrue(delivery.is_ancestor(first, second))
                self.assertFalse(delivery.is_ancestor(second, first))
                self.assertFalse(delivery.is_ancestor("d" * 40, second))


class MigrationLockRetry(unittest.TestCase):
    url = "postgresql://kip:secret@ep-test.us-west-2.aws.neon.tech/parkdex_kip"

    def migrate(self, outcomes):
        calls = []

        def fake_run(args, **kwargs):
            calls.append(kwargs["env"].get("PGOPTIONS"))
            outcome = outcomes.pop(0)
            if outcome:
                raise delivery.DeliveryError(f"database migration x.sql failed with exit code 3: {outcome}")
            return ""

        with patch.object(delivery, "run", side_effect=fake_run), \
             patch.object(delivery, "psql_executable", return_value="psql"):
            delivery.run_migration(self.url, delivery.ROOT / "x.sql", sleep=lambda seconds: None)
        return calls

    def test_retries_a_deadlock_then_succeeds_with_a_lock_timeout(self):
        calls = self.migrate(["ERROR:  deadlock detected", "ERROR:  canceling statement due to lock timeout", None])
        self.assertEqual(calls, ["-c lock_timeout=5s"] * 3)

    def test_other_errors_fail_immediately(self):
        with self.assertRaisesRegex(delivery.DeliveryError, "syntax error"):
            self.migrate(["ERROR:  syntax error at or near", None])

    def test_gives_up_after_the_last_attempt(self):
        with self.assertRaisesRegex(delivery.DeliveryError, "deadlock"):
            self.migrate(["ERROR:  deadlock detected"] * delivery.MIGRATION_ATTEMPTS)


def http_error(code):
    return urllib.error.HTTPError("https://api.example.test/x", code, "error", {}, io.BytesIO(b""))


class FakeResponse(io.BytesIO):
    status = 200


class ScriptedUrlopen:
    """Replays network outcomes (an exception or a response body) and records each attempt and backoff."""

    @contextlib.contextmanager
    def scripted(self, outcomes):
        self.sleeps = []
        self.calls = 0

        def fake_urlopen(request, timeout):
            self.calls += 1
            outcome = outcomes.pop(0)
            if isinstance(outcome, BaseException):
                raise outcome
            return FakeResponse(outcome)

        with patch.object(delivery.urllib.request, "urlopen", side_effect=fake_urlopen), \
             contextlib.redirect_stderr(io.StringIO()):
            yield


class ProviderGetRetry(ScriptedUrlopen, unittest.TestCase):
    """A transient provider read must not abort a first-attempt-only release dispatch."""

    def call(self, outcomes, *, method="GET", not_found_ok=False):
        with self.scripted(outcomes):
            return delivery.api_json("https://api.example.test", "/x", token="t", method=method,
                                     body={} if method != "GET" else None,
                                     not_found_ok=not_found_ok, sleep=self.sleeps.append)

    def test_get_succeeds_after_a_transient_network_error(self):
        result = self.call([urllib.error.URLError("reset"), b'{"ok": true}'])
        self.assertEqual(result, {"ok": True})
        self.assertEqual((self.calls, self.sleeps), (2, [2]))

    def test_get_gives_up_after_three_attempts_with_the_same_message(self):
        with self.assertRaisesRegex(delivery.DeliveryError, r"^api\.example\.test API GET request could not complete\.$"):
            self.call([TimeoutError(), ConnectionResetError(), urllib.error.URLError("down")])
        self.assertEqual((self.calls, self.sleeps), (3, [2, 5]))

    def test_get_retries_http_503(self):
        self.assertEqual(self.call([http_error(503), b"{}"]), {})
        self.assertEqual(self.calls, 2)

    def test_get_does_not_retry_not_found(self):
        self.assertIsNone(self.call([http_error(404)], not_found_ok=True))
        self.assertEqual((self.calls, self.sleeps), (1, []))

    def test_get_does_not_retry_other_client_errors(self):
        with self.assertRaisesRegex(delivery.DeliveryError, "HTTP 403"):
            self.call([http_error(403), b"{}"])
        self.assertEqual(self.calls, 1)

    def test_writes_are_never_retried(self):
        for method in ("POST", "PUT", "PATCH", "DELETE"):
            with self.subTest(method=method):
                with self.assertRaisesRegex(delivery.DeliveryError, f"API {method} request could not complete"):
                    self.call([urllib.error.URLError("reset"), b"{}"], method=method)
                self.assertEqual((self.calls, self.sleeps), (1, []))
                with self.assertRaisesRegex(delivery.DeliveryError, "HTTP 503"):
                    self.call([http_error(503), b"{}"], method=method)
                self.assertEqual(self.calls, 1)


class R2ObjectGetRetry(ScriptedUrlopen, unittest.TestCase):
    """The ownership marker read during photo Worker dispatch retries like other provider reads."""

    def setUp(self):
        spec = importlib.util.spec_from_file_location("kip_private_photos_retry", Path(__file__).with_name("kip_private_photos.py"))
        self.photos = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.photos)
        self.config = {"privatePhotos": {"accountId": "6f0eb57971124f41fadc7897ace74dac"}}

    def call(self, outcomes, *, method="GET"):
        with patch.dict(os.environ, {"CLOUDFLARE_API_TOKEN": "cf-test-token"}), self.scripted(outcomes):
            return self.photos._r2_object(delivery, self.config, "bucket", "marker.json", method=method,
                                          body=b"{}" if method == "PUT" else None, sleep=self.sleeps.append)

    def test_get_succeeds_after_a_transient_network_error(self):
        self.assertEqual(self.call([urllib.error.URLError("reset"), b"{}"]), (200, b"{}"))
        self.assertEqual((self.calls, self.sleeps), (2, [2]))

    def test_get_gives_up_after_three_attempts_with_the_same_message(self):
        with self.assertRaisesRegex(delivery.DeliveryError, r"^Cloudflare R2 object GET request could not complete\.$"):
            self.call([http_error(502), TimeoutError(), urllib.error.URLError("down")])
        self.assertEqual((self.calls, self.sleeps), (3, [2, 5]))

    def test_get_retries_http_503(self):
        self.assertEqual(self.call([http_error(503), b"{}"]), (200, b"{}"))
        self.assertEqual(self.calls, 2)

    def test_missing_marker_is_not_retried(self):
        self.assertEqual(self.call([http_error(404)]), (404, b""))
        self.assertEqual((self.calls, self.sleeps), (1, []))

    def test_put_and_delete_are_never_retried(self):
        for method in ("PUT", "DELETE"):
            with self.subTest(method=method):
                with self.assertRaisesRegex(delivery.DeliveryError, f"R2 object {method} request could not complete"):
                    self.call([urllib.error.URLError("reset"), b"{}"], method=method)
                self.assertEqual((self.calls, self.sleeps), (1, []))


class FailureDetail(unittest.TestCase):
    """A failed command shows its first error, not only a tail that can be all object dump."""

    def test_long_output_keeps_the_first_error_the_end_and_the_last_progress(self):
        secret = "pg-password-qa-only-value"
        delivery.register_secret(secret)
        stderr = "\n".join([
            "node:events:486",
            "      throw er; // Unhandled 'error' event",
            "      ^",
            "",
            f"error: terminating connection due to administrator command postgres://kip_qa:{secret}@127.0.0.1/db",
            "    at Parser.parseErrorMessage (node_modules/pg-protocol/dist/parser.js:285:98)",
            *[f"    field_{index}: {'x' * 60}," for index in range(200)],
            "    _poolUseCount: 44,",
            "}",
        ])
        stdout = "deleting the founder account removes the founder and photo: PASS\nqa-osm-parks: PASS\nlast step: PASS"
        with patch.object(delivery.subprocess, "run", return_value=delivery.subprocess.CompletedProcess([], 1, stdout, stderr)):
            with self.assertRaises(delivery.DeliveryError) as raised:
                delivery.run(["npm", "run", "test:sql"], label="candidate PostgreSQL integration tests")
        message = str(raised.exception)
        self.assertIn("failed with exit code 1", message)
        self.assertIn("first error:", message)
        self.assertIn("error: terminating connection due to administrator command", message)
        self.assertIn("end of output:", message)
        self.assertIn("_poolUseCount: 44", message)
        self.assertIn("last progress on stdout:\ndeleting the founder account", message)
        self.assertNotIn(secret, message)
        self.assertNotIn("kip_qa:", message)
        self.assertLess(len(message), 3200)

    def test_short_output_is_shown_whole_and_empty_output_adds_nothing(self):
        self.assertEqual(delivery.failure_detail("", "AssertionError: 1 !== 2"), "AssertionError: 1 !== 2")
        self.assertEqual(delivery.failure_detail("", ""), "")
        long_without_marker = "\n".join(f"line {index} {'y' * 40}" for index in range(100))
        detail = delivery.failure_detail(long_without_marker, "")
        self.assertTrue(detail.startswith("start of output:\nline 0"))
        self.assertIn("line 99", detail)


if __name__ == "__main__":
    unittest.main()
