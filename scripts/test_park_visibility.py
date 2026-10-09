from __future__ import annotations

import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import park_visibility as visibility


IDENTITY = {"host": "127.0.0.1", "port": 5432, "database": "kip_qa_x", "environment": "local-qa"}


def park(park_id: str, category: str, hidden_by: str | None = None, proposal: bool = False, floor: int | None = None) -> dict:
    return {"id": park_id, "category": category, "hiddenBy": hidden_by, "playerProposal": proposal, "minimumReader": floor}


STATE = {
    "revision": 12,
    "rules": {},
    "parks": [
        park("municipal-a", "municipal"),
        park("municipal-b", "municipal", floor=3),
        park("municipal-op", "municipal", hidden_by="operator"),
        park("osm-way-1", "municipal", proposal=True),
        park("community-a", "community"),
    ],
}


class ParkVisibilityPlanTests(unittest.TestCase):
    def test_hide_skips_player_proposals_and_parks_already_hidden(self):
        plan = visibility.build_plan("hide", ["community", "municipal"], "Less dense map.", IDENTITY, STATE)
        self.assertEqual(plan["parkIds"], ["municipal-a", "municipal-b", "community-a"])
        self.assertEqual(plan["exemptPlayerProposals"], ["osm-way-1"])
        self.assertEqual(plan["counts"]["municipal"], {
            "parks": 4, "change": 2, "changeServedToReaders1And2": 1, "keptVisibleAsPlayerProposals": 1, "alreadyHidden": 1,
            "keptVisibleBelowReaderFloor": 0,
        })
        self.assertEqual(plan["planSha256"], visibility.plan_digest(plan))

    def test_reader_floor_scope_hides_only_parks_newer_readers_get(self):
        plan = visibility.build_plan("hide", ["community", "municipal"], "Less dense map.", IDENTITY, STATE, min_reader_floor=3)
        self.assertEqual(plan["parkIds"], ["municipal-b"])
        self.assertEqual(plan["minReaderFloor"], 3)
        self.assertEqual(plan["counts"]["municipal"]["keptVisibleBelowReaderFloor"], 1)
        self.assertEqual(plan["counts"]["community"]["keptVisibleBelowReaderFloor"], 1)
        with self.assertRaises(visibility.VisibilityError):
            visibility.build_plan("unhide", ["municipal"], None, IDENTITY, STATE, min_reader_floor=3)

    def test_unhide_restores_only_what_the_category_rule_hid(self):
        state = {**STATE, "parks": [park("municipal-a", "municipal", "category"), park("municipal-op", "municipal", "operator")]}
        plan = visibility.build_plan("unhide", ["municipal"], None, IDENTITY, state)
        self.assertEqual(plan["parkIds"], ["municipal-a"])

    def test_reviewed_plan_hash_is_rechecked(self):
        plan = visibility.build_plan("hide", ["municipal"], "Less dense map.", IDENTITY, STATE)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "plan.json"
            path.write_text(json.dumps(plan), encoding="utf-8")
            self.assertEqual(visibility.load_plan(path, plan["planSha256"])["parkIds"], plan["parkIds"])
            with self.assertRaisesRegex(visibility.VisibilityError, "SHA"):
                visibility.load_plan(path, "0" * 64)
            path.write_text(json.dumps({**plan, "parkIds": ["municipal-a"]}), encoding="utf-8")
            with self.assertRaisesRegex(visibility.VisibilityError, "SHA"):
                visibility.load_plan(path, plan["planSha256"])

    def test_inputs_are_checked(self):
        self.assertEqual(visibility.check_categories(["municipal", "community", "municipal"]), ["community", "municipal"])
        with self.assertRaises(visibility.VisibilityError):
            visibility.check_categories(["island"])
        with self.assertRaises(visibility.VisibilityError):
            visibility.check_categories([])
        with self.assertRaises(visibility.VisibilityError):
            visibility.check_reason("  ")
        with self.assertRaises(visibility.VisibilityError):
            visibility.check_reason("bad\nreason")


if __name__ == "__main__":
    unittest.main()
