import contextlib
import importlib.util
import io
import json
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest import mock

spec = importlib.util.spec_from_file_location("publish_play", Path(__file__).with_name("publish-play.py"))
publish_play = importlib.util.module_from_spec(spec)
spec.loader.exec_module(publish_play)


def write_bundle(path: Path, *, signed=True, manifest=True):
    with zipfile.ZipFile(path, "w") as bundle:
        bundle.writestr("BundleConfig.pb", b"")
        if manifest:
            bundle.writestr("base/manifest/AndroidManifest.xml", b"")
        if signed:
            bundle.writestr("META-INF/UPLOAD.RSA", b"")


class ReleaseNotesTests(unittest.TestCase):
    def test_reads_each_language_block(self):
        notes = publish_play.parse_release_notes("<en-GB>\nFound a park.\n- Reviews.\n</en-GB>\n<fr-CA>Parc.</fr-CA>\n")
        self.assertEqual(notes, [
            {"language": "en-GB", "text": "Found a park.\n- Reviews."},
            {"language": "fr-CA", "text": "Parc."},
        ])

    def test_refuses_missing_empty_long_and_repeated_notes(self):
        for text in ("Just text", "<en-GB>  </en-GB>", f"<en-GB>{'x' * 501}</en-GB>", "<en-GB>a</en-GB><en-GB>b</en-GB>"):
            with self.subTest(text=text[:20]), self.assertRaises(publish_play.PublishError):
                publish_play.parse_release_notes(text)


class BundleTests(unittest.TestCase):
    def test_accepts_a_signed_bundle_and_refuses_others(self):
        with tempfile.TemporaryDirectory() as folder:
            good = Path(folder) / "good.aab"
            write_bundle(good)
            publish_play.check_bundle(good)
            for name, kwargs in (("unsigned.aab", {"signed": False}), ("nomanifest.aab", {"manifest": False})):
                path = Path(folder) / name
                write_bundle(path, **kwargs)
                with self.subTest(name=name), self.assertRaises(publish_play.PublishError):
                    publish_play.check_bundle(path)
            apk = Path(folder) / "app.apk"
            write_bundle(apk)
            with self.assertRaises(publish_play.PublishError):
                publish_play.check_bundle(apk)

    def test_provenance_must_name_this_app(self):
        with tempfile.TemporaryDirectory() as folder:
            aab = Path(folder) / "app.aab"
            self.assertEqual(publish_play.read_provenance(aab), {})
            aab.with_name("build-provenance.json").write_text(json.dumps({"applicationId": "app.other"}), encoding="utf-8")
            with self.assertRaises(publish_play.PublishError):
                publish_play.read_provenance(aab)
            aab.with_name("build-provenance.json").write_text(
                "﻿" + json.dumps({"applicationId": "app.parkdex", "versionCode": 16}), encoding="utf-8")
            self.assertEqual(publish_play.read_provenance(aab)["versionCode"], 16)


class ReleaseTests(unittest.TestCase):
    def test_release_body_names_the_version(self):
        notes = [{"language": "en-GB", "text": "Hi"}]
        self.assertEqual(publish_play.release_body(16, notes, "completed", "1.4.0"), {
            "name": "16 (1.4.0)", "versionCodes": ["16"], "status": "completed", "releaseNotes": notes,
        })
        self.assertEqual(publish_play.release_body(16, notes, "draft", None)["name"], "16")

    def test_production_needs_explicit_flag(self):
        self.assertEqual(publish_play.main(["--aab", "x.aab", "--notes", "n.txt", "--track", "production"]), 1)
        self.assertEqual(publish_play.main(["--promote", "16", "--track", "production"]), 1)

    def test_aab_and_promote_are_exclusive_and_aab_needs_notes(self):
        for argv in (["--aab", "x.aab", "--promote", "16", "--notes", "n.txt"], ["--aab", "x.aab"], []):
            with self.subTest(argv=argv), self.assertRaises(SystemExit), \
                    contextlib.redirect_stderr(io.StringIO()):
                publish_play.main(argv)


NOTES = [{"language": "en-GB", "text": "Found a park."}]
INTERNAL_16 = {"name": "16 (1.4.0)", "versionCodes": ["16"], "status": "completed", "releaseNotes": NOTES}
ALPHA_15 = {"name": "15 (1.3.0)", "versionCodes": ["15"], "status": "completed",
            "releaseNotes": [{"language": "en-GB", "text": "Older."}]}


class FakeResponse:
    def __init__(self, body, status_code=200):
        self.status_code = status_code
        self._body = body
        self.content = json.dumps(body).encode() if body is not None else b""
        self.text = self.content.decode()

    def json(self):
        return self._body


class FakePlay:
    """Answers the edit calls the script makes, with tracks and bundles held in memory."""

    def __init__(self, tracks, bundles):
        self.tracks = tracks
        self.bundles = bundles
        self.calls = []

    def request(self, method, url, timeout=None, **kwargs):
        path = url.split("/applications/app.parkdex/")[-1]
        self.calls.append((method, path, kwargs.get("json")))
        if method == "POST" and path == "edits":
            return FakeResponse({"id": "e1"})
        if method == "GET" and path == "edits/e1/bundles":
            return FakeResponse({"bundles": [{"versionCode": code} for code in self.bundles]})
        if method == "GET" and path.startswith("edits/e1/tracks/"):
            track = path.rsplit("/", 1)[-1]
            return FakeResponse({"track": track, "releases": self.tracks.get(track, [])})
        if method in ("PUT", "DELETE") or path.startswith("edits/e1:commit"):
            return FakeResponse(None)
        return FakeResponse({"error": {"message": f"unexpected {method} {path}"}}, 400)

    def methods(self):
        return [(method, path) for method, path, _ in self.calls]


class PromoteTests(unittest.TestCase):
    def run_main(self, play, argv):
        out, err = io.StringIO(), io.StringIO()
        with mock.patch.object(publish_play, "session", return_value=play), \
                contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = publish_play.main(argv)
        return code, out.getvalue(), err.getvalue()

    def test_promotion_body_copies_the_source_release_or_takes_given_notes(self):
        self.assertEqual(publish_play.promotion_body(16, INTERNAL_16, None, "completed", "internal"), INTERNAL_16)
        given = [{"language": "en-GB", "text": "New."}]
        self.assertEqual(publish_play.promotion_body(16, None, given, "draft", "internal"),
                         {"name": "16", "versionCodes": ["16"], "status": "draft", "releaseNotes": given})
        for source in (None, {**INTERNAL_16, "releaseNotes": []}):
            with self.subTest(source=source), self.assertRaises(publish_play.PublishError):
                publish_play.promotion_body(16, source, None, "completed", "internal")

    def test_dry_run_prints_the_change_and_commits_nothing(self):
        play = FakePlay({"internal": [INTERNAL_16], "alpha": [ALPHA_15]}, [15, 16])
        code, out, _ = self.run_main(play, ["--promote", "16", "--track", "alpha"])
        self.assertEqual(code, 0)
        self.assertIn("alpha now: 15 (1.3.0) [completed] codes 15", out)
        self.assertIn("alpha would become: 16 (1.4.0) [completed] codes 16; notes copied from internal", out)
        self.assertIn("dry run", out)
        self.assertNotIn("PUT", [method for method, _ in play.methods()])
        self.assertEqual(play.methods()[-1], ("DELETE", "edits/e1"))

    def test_apply_puts_the_copied_release_and_commits(self):
        play = FakePlay({"internal": [INTERNAL_16], "alpha": [ALPHA_15]}, [15, 16])
        code, out, _ = self.run_main(play, ["--promote", "16", "--track", "alpha", "--apply"])
        self.assertEqual(code, 0)
        self.assertIn(("PUT", "edits/e1/tracks/alpha", {"track": "alpha", "releases": [INTERNAL_16]}), play.calls)
        self.assertEqual(play.methods()[-1], ("POST", "edits/e1:commit"))
        self.assertNotIn("DELETE", [method for method, _ in play.methods()])
        self.assertIn("promoted 16 (1.4.0) to alpha", out)

    def test_given_notes_replace_the_copied_ones(self):
        play = FakePlay({"internal": [INTERNAL_16]}, [16])
        with tempfile.TemporaryDirectory() as folder:
            notes = Path(folder) / "notes.txt"
            notes.write_text("<en-GB>For testers.</en-GB>", encoding="utf-8")
            code, _, _ = self.run_main(play, ["--promote", "16", "--track", "beta", "--notes", str(notes), "--apply"])
        self.assertEqual(code, 0)
        put = next(body for method, _, body in play.calls if method == "PUT")
        self.assertEqual(put["releases"][0]["name"], "16 (1.4.0)")
        self.assertEqual(put["releases"][0]["releaseNotes"], [{"language": "en-GB", "text": "For testers."}])

    def test_refuses_codes_that_are_not_uploaded_or_not_on_the_source_track(self):
        for bundles, tracks, message in (
            ([15], {"internal": [INTERNAL_16]}, "has not been uploaded"),
            ([15, 16], {"internal": [ALPHA_15]}, "No release on internal holds version code 16"),
        ):
            play = FakePlay(tracks, bundles)
            with self.subTest(message=message):
                code, _, err = self.run_main(play, ["--promote", "16", "--track", "alpha", "--apply"])
                self.assertEqual(code, 1)
                self.assertIn(message, err)
                self.assertNotIn("PUT", [method for method, _ in play.methods()])
                self.assertEqual(play.methods()[-1], ("DELETE", "edits/e1"))

    def test_already_released_is_a_no_op(self):
        play = FakePlay({"internal": [INTERNAL_16], "alpha": [INTERNAL_16]}, [16])
        code, out, _ = self.run_main(play, ["--promote", "16", "--track", "alpha", "--apply"])
        self.assertEqual(code, 0)
        self.assertIn("already releases 16", out)
        self.assertNotIn("PUT", [method for method, _ in play.methods()])

    def test_refuses_the_same_source_and_target_track(self):
        code, _, err = self.run_main(FakePlay({}, []), ["--promote", "16", "--track", "internal"])
        self.assertEqual(code, 1)
        self.assertIn("both internal", err)

    def test_upload_refusal_points_at_promote(self):
        play = FakePlay({"internal": [INTERNAL_16]}, [16])
        with tempfile.TemporaryDirectory() as folder:
            aab = Path(folder) / "app.aab"
            write_bundle(aab)
            aab.with_name("build-provenance.json").write_text(json.dumps({"versionCode": 16}), encoding="utf-8")
            notes = Path(folder) / "notes.txt"
            notes.write_text("<en-GB>Hi</en-GB>", encoding="utf-8")
            code, _, err = self.run_main(play, ["--aab", str(aab), "--notes", str(notes), "--track", "alpha"])
        self.assertEqual(code, 1)
        self.assertIn("use --promote", err)


if __name__ == "__main__":
    unittest.main()
