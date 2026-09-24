import csv
import io
import json
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from photo_review_server import ReviewDataError, ReviewHTTPServer, ReviewStore


FIELDS = [
    "place_id", "place_name", "source", "title", "landing_url", "image_url",
    "thumbnail_url", "creator", "license", "license_url", "inside_boundary",
    "bc_in_metadata", "raw_location_text",
]


class ReviewServerTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.shortlist = self.root / "shortlist.csv"
        self.state = self.root / "decisions.json"
        self.static = self.root / "static"
        self.static.mkdir()
        (self.static / "index.html").write_text("review", encoding="utf-8")
        rows = [
            self.row("park-one", "First", "https://commons.example/File:First.jpg"),
            self.row("park-one", "Second", "https://commons.example/File:Second.jpg?tracking=yes"),
            self.row("park-two", "Third", "https://photos.example/third/"),
        ]
        with self.shortlist.open("w", encoding="utf-8", newline="") as stream:
            writer = csv.DictWriter(stream, fieldnames=FIELDS)
            writer.writeheader()
            writer.writerows(rows)

    def tearDown(self):
        self.temporary.cleanup()

    @staticmethod
    def row(place_id, title, landing_url):
        return {
            "place_id": place_id,
            "place_name": place_id.replace("-", " ").title(),
            "source": "wikimedia_commons",
            "title": title,
            "landing_url": landing_url,
            "image_url": "https://images.example/image.jpg",
            "thumbnail_url": "https://images.example/thumb.jpg",
            "creator": "Photographer",
            "license": "CC BY 4.0",
            "license_url": "https://creativecommons.org/licenses/by/4.0/",
            "inside_boundary": "True",
            "bc_in_metadata": "True",
            "raw_location_text": "British Columbia",
        }

    def test_persists_multiple_approvals_for_one_place_and_exports(self):
        store = ReviewStore(self.shortlist, self.state)
        first, second = store.candidates[:2]
        store.save_decision({"candidate_id": first["candidate_id"], "status": "approved", "note": "wide view"})
        store.save_decision({"candidate_id": second["candidate_id"], "status": "approved"})

        reloaded = ReviewStore(self.shortlist, self.state).api_data()
        self.assertEqual(2, len(reloaded["decisions"]))
        self.assertEqual("approved", reloaded["decisions"][first["candidate_id"]]["status"])
        with store.approved_export_path.open(encoding="utf-8", newline="") as stream:
            exported = list(csv.DictReader(stream))
        self.assertEqual(["First", "Second"], [row["title"] for row in exported])
        self.assertEqual("wide view", exported[0]["note"])
        with store.rejected_export_path.open(encoding="utf-8", newline="") as stream:
            self.assertEqual([], list(csv.DictReader(stream)))

    def test_pending_removes_candidate_from_decision_exports(self):
        store = ReviewStore(self.shortlist, self.state)
        key = store.candidates[0]["candidate_id"]
        store.save_decision({"candidate_id": key, "status": "rejected", "note": "wrong park"})
        store.save_decision({"candidate_id": key, "status": "pending", "note": "reconsider"})
        with store.rejected_export_path.open(encoding="utf-8", newline="") as stream:
            self.assertEqual([], list(csv.DictReader(stream)))
        self.assertEqual("pending", json.loads(self.state.read_text(encoding="utf-8"))["decisions"][key]["status"])

    def test_fingerprint_mismatch_refuses_write_without_changing_state(self):
        store = ReviewStore(self.shortlist, self.state)
        key = store.candidates[0]["candidate_id"]
        store.save_decision({"candidate_id": key, "status": "approved"})
        before = self.state.read_bytes()
        with self.shortlist.open("a", encoding="utf-8") as stream:
            stream.write("\n")
        changed_store = ReviewStore(self.shortlist, self.state)
        with self.assertRaisesRegex(ReviewDataError, "shortlist changed"):
            changed_store.save_decision({"candidate_id": changed_store.candidates[0]["candidate_id"], "status": "rejected"})
        self.assertEqual(before, self.state.read_bytes())

    def test_shortlist_change_during_server_run_refuses_write(self):
        store = ReviewStore(self.shortlist, self.state)
        key = store.candidates[0]["candidate_id"]
        with self.shortlist.open("a", encoding="utf-8") as stream:
            stream.write("\n")
        with self.assertRaisesRegex(ReviewDataError, "server was running"):
            store.save_decision({"candidate_id": key, "status": "approved"})
        self.assertFalse(self.state.exists())

    def test_corrupt_state_is_not_overwritten(self):
        self.state.write_text("{broken", encoding="utf-8")
        before = self.state.read_bytes()
        store = ReviewStore(self.shortlist, self.state)
        with self.assertRaisesRegex(ReviewDataError, "left untouched"):
            store.save_decision({"candidate_id": store.candidates[0]["candidate_id"], "status": "approved"})
        self.assertEqual(before, self.state.read_bytes())

    def test_http_rejects_invalid_and_cross_origin_writes(self):
        store = ReviewStore(self.shortlist, self.state)
        server = ReviewHTTPServer(("127.0.0.1", 0), store, self.static)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        base = f"http://127.0.0.1:{server.server_port}"
        try:
            with urllib.request.urlopen(f"{base}/api/data") as response:
                data = json.load(response)
            self.assertEqual(3, len(data["candidates"]))
            self.assertEqual(FIELDS, [key for key in data["candidates"][0] if key != "candidate_id"])

            invalid = self.request(base, {"candidate_id": data["candidates"][0]["candidate_id"], "status": "maybe"})
            with self.assertRaises(urllib.error.HTTPError) as invalid_error:
                urllib.request.urlopen(invalid)
            self.assertEqual(400, invalid_error.exception.code)
            self.assertFalse(self.state.exists())

            foreign = self.request(
                base,
                {"candidate_id": data["candidates"][0]["candidate_id"], "status": "approved"},
                origin="https://evil.example",
            )
            with self.assertRaises(urllib.error.HTTPError) as foreign_error:
                urllib.request.urlopen(foreign)
            self.assertEqual(403, foreign_error.exception.code)
            self.assertFalse(self.state.exists())
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)

    def test_http_exports_csv_and_decision_json(self):
        store = ReviewStore(self.shortlist, self.state)
        first, second = store.candidates[:2]
        store.save_decision({"candidate_id": first["candidate_id"], "status": "approved", "note": "primary"})
        store.save_decision({"candidate_id": second["candidate_id"], "status": "rejected", "note": "too similar"})
        server = ReviewHTTPServer(("127.0.0.1", 0), store, self.static)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        base = f"http://127.0.0.1:{server.server_port}"
        try:
            with urllib.request.urlopen(f"{base}/api/export?status=approved") as response:
                self.assertIn("photo-review-approved.csv", response.headers["Content-Disposition"])
                rows = list(csv.DictReader(io.StringIO(response.read().decode("utf-8"))))
            self.assertEqual(["First"], [row["title"] for row in rows])
            with urllib.request.urlopen(f"{base}/api/export?status=all") as response:
                state = json.load(response)
            self.assertEqual("rejected", state["decisions"][second["candidate_id"]]["status"])
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)

    @staticmethod
    def request(base, payload, origin=None):
        headers = {"Content-Type": "application/json"}
        if origin:
            headers["Origin"] = origin
        return urllib.request.Request(
            f"{base}/api/decision",
            data=json.dumps(payload).encode("utf-8"),
            headers=headers,
            method="POST",
        )


if __name__ == "__main__":
    unittest.main()
