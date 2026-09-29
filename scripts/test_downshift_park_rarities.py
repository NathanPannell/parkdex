import sys
from pathlib import Path
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import downshift_park_rarities as downshift


class RarityDownshiftTests(unittest.TestCase):
    def test_reviewed_plan_covers_exactly_41_changes(self):
        before, after, changes = downshift.load_plan()
        self.assertEqual(len(before), 100)
        self.assertEqual(len(after), 100)
        self.assertEqual(len(changes), 41)
        self.assertEqual(before["regional-sooke-potholes-regional-park"], "legendary")
        self.assertEqual(after["regional-sooke-potholes-regional-park"], "rare")
        self.assertEqual(
            {park_id for park_id in before if before[park_id] != after[park_id]},
            {change["id"] for change in changes},
        )

    def test_plan_hash_binds_revision_and_changes(self):
        _, _, changes = downshift.load_plan()
        baseline = downshift.plan_hash(16, changes)
        self.assertNotEqual(baseline, downshift.plan_hash(17, changes))
        self.assertNotEqual(baseline, downshift.plan_hash(16, changes[:-1]))

    def test_database_identity_refuses_wrong_host_and_main_target(self):
        staging = "postgresql://parkdex_kip_owner:password@staging.example/parkdex_kip"
        downshift.database_identity(staging, "staging.example", "staging", None)
        with self.assertRaises(downshift.DownshiftError):
            downshift.database_identity(staging, "main.example", "staging", None)
        with self.assertRaises(downshift.DownshiftError):
            downshift.database_identity("postgresql://parkdex_kip_owner:password@main.example/main", "main.example", "staging", None)

    def test_preview_database_and_role_must_share_identity(self):
        preview = "postgresql://kip_pr_28_0123456789:password@preview.example/kip_preview_28_0123456789"
        downshift.database_identity(preview, "preview.example", "owned-preview", 28)
        with self.assertRaises(downshift.DownshiftError):
            downshift.database_identity(preview, "preview.example", "owned-preview", 29)
        with self.assertRaises(downshift.DownshiftError):
            downshift.database_identity(preview.replace("kip_pr_28_0123456789", "kip_pr_28_9876543210"), "preview.example", "owned-preview", 28)

    def test_immutable_receipt_must_name_the_selected_environment(self):
        downshift.verify_rollout_receipt(("staging", None, "staging.example"), "staging", None, "staging.example")
        downshift.verify_rollout_receipt(("owned-preview", "28", "preview.example"), "owned-preview", 28, "preview.example")
        for receipt in (None, ("main", None, "staging.example"), ("staging", "28", "staging.example"), ("staging", None, "main.example")):
            with self.assertRaises(downshift.DownshiftError):
                downshift.verify_rollout_receipt(receipt, "staging", None, "staging.example")


if __name__ == "__main__":
    unittest.main()
