import hashlib
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

import publish_content


class PublishTests(unittest.TestCase):
    def setUp(self):
        self.data = b"unchanged asset"
        self.item = {"path": "art/badge.webp", "key": "releases/version/art/badge.webp", "sha256": hashlib.sha256(self.data).hexdigest(), "byte_size": len(self.data), "content_type": "image/webp"}

    def response(self, status, data=b""):
        response = Mock(status_code=status, content=data, ok=status < 400)
        return response

    def test_existing_matching_object_is_not_written(self):
        session = Mock()
        session.get.return_value = self.response(200, self.data)
        with patch("publish_content.requests.Session") as constructor:
            constructor.return_value.__enter__.return_value = session
            result = publish_content.upload_one(self.item, Path("unused"), "https://example.test/objects", "test-token")
        self.assertEqual(result["status"], "already-matches")
        session.put.assert_not_called()

    def test_existing_conflicting_object_is_rejected(self):
        session = Mock()
        session.get.return_value = self.response(200, b"different content")
        with patch("publish_content.requests.Session") as constructor:
            constructor.return_value.__enter__.return_value = session
            with self.assertRaisesRegex(ValueError, "Refusing to overwrite"):
                publish_content.upload_one(self.item, Path("unused"), "https://example.test/objects", "test-token")
        session.put.assert_not_called()

    def test_corrupt_upload_fails_readback(self):
        session = Mock()
        session.get.side_effect = [self.response(404), self.response(200, b"corrupted")]
        session.put.return_value = self.response(200)
        with tempfile.TemporaryDirectory() as directory, patch("publish_content.requests.Session") as constructor:
            path = Path(directory) / "asset.webp"
            path.write_bytes(self.data)
            constructor.return_value.__enter__.return_value = session
            with self.assertRaisesRegex(RuntimeError, "byte verification failed"):
                publish_content.upload_one(self.item, path, "https://example.test/objects", "test-token")
        session.put.assert_called_once()


if __name__ == "__main__":
    unittest.main()
