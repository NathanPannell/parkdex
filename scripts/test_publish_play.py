import importlib.util
import json
import tempfile
import unittest
import zipfile
from pathlib import Path

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
        self.assertEqual(
            notes,
            [
                {"language": "en-GB", "text": "Found a park.\n- Reviews."},
                {"language": "fr-CA", "text": "Parc."},
            ],
        )

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
            aab.with_name("build-provenance.json").write_text("﻿" + json.dumps({"applicationId": "app.parkdex", "versionCode": 16}), encoding="utf-8")
            self.assertEqual(publish_play.read_provenance(aab)["versionCode"], 16)


class ReleaseTests(unittest.TestCase):
    def test_release_body_names_the_version(self):
        notes = [{"language": "en-GB", "text": "Hi"}]
        self.assertEqual(
            publish_play.release_body(16, notes, "completed", "1.4.0"),
            {
                "name": "16 (1.4.0)",
                "versionCodes": ["16"],
                "status": "completed",
                "releaseNotes": notes,
            },
        )
        self.assertEqual(publish_play.release_body(16, notes, "draft", None)["name"], "16")

    def test_production_needs_explicit_flag(self):
        self.assertEqual(publish_play.main(["--aab", "x.aab", "--notes", "n.txt", "--track", "production"]), 1)


if __name__ == "__main__":
    unittest.main()
