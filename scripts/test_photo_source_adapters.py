"""Provider contract tests using representative API responses."""

from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
from photo_audit_nature import search_inaturalist  # noqa: E402
from photo_audit_open import search_commons, search_openverse  # noqa: E402


class Response:
    def __init__(self, payload):
        self.payload = payload

    def raise_for_status(self):
        pass

    def json(self):
        return self.payload


class Client:
    def __init__(self, handler):
        self.handler = handler
        self.calls = []

    def get(self, url, **kwargs):
        self.calls.append((url, kwargs.get("params", {})))
        return Response(self.handler(url, kwargs.get("params", {})))


def commons_page(page_id, title, description):
    return {
        "pageid": page_id,
        "title": f"File:{title}",
        "imageinfo": [{
            "url": f"https://upload.wikimedia.org/{page_id}.jpg",
            "descriptionurl": f"https://commons.wikimedia.org/wiki/File:{title}",
            "extmetadata": {
                "LicenseShortName": {"value": "CC BY 4.0"},
                "LicenseUrl": {"value": "https://creativecommons.org/licenses/by/4.0/"},
                "Artist": {"value": "A photographer"},
                "ImageDescription": {"value": description},
            },
        }],
    }


class PhotoSourceAdapterTests(unittest.TestCase):
    def test_commons_does_not_return_video_as_photo(self):
        def handler(_url, params):
            if params["generator"] == "search":
                return {"query": {"pages": [commons_page(1, "Tuya Mountains Park.webm", "Tuya Mountains Park, BC")]}}
            return {"query": {"pages": [commons_page(2, "Tuya Mountains Park.jpg", "Tuya Mountains Park, BC")]}}

        client = Client(handler)
        result = search_commons(client, {"name": "Tuya Mountains Park", "latitude": 59.17, "longitude": -130.5})
        self.assertEqual([item["source_id"] for item in result], ["2"])

    def test_commons_geosearch_runs_after_unrelated_licensed_result(self):
        def handler(_url, params):
            if params["generator"] == "search":
                return {"query": {"pages": [commons_page(1, "Alpine flower", "A flower")]} }
            return {"query": {"pages": [commons_page(2, "Tuya landscape", "Tuya Mountains Park, British Columbia")]} }

        client = Client(handler)
        result = search_commons(client, {"name": "Tuya Mountains Park", "latitude": 59.17, "longitude": -130.5})
        self.assertEqual([call[1]["generator"] for call in client.calls], ["search", "geosearch"])
        self.assertEqual(result[0]["source_id"], "2")

    def test_openverse_checks_beyond_first_five_results(self):
        def item(number, title):
            return {
                "id": str(number), "title": title, "license": "by", "license_version": "4.0",
                "license_url": "https://creativecommons.org/licenses/by/4.0/",
                "foreign_landing_url": f"https://example.org/{number}", "creator": "A photographer",
            }

        def handler(_url, params):
            return {"results": [item(i, f"Unrelated mountain {i}") for i in range(6)] + [item(7, "Tuya Mountains Park in British Columbia")]}

        client = Client(handler)
        result = search_openverse(client, {"name": "Tuya Mountains Park"}, limit=5)
        self.assertEqual(result[0]["source_id"], "7")
        self.assertEqual(len(client.calls), 1)

    def test_inaturalist_filters_photo_license_then_checks_each_photo(self):
        def handler(url, params):
            if "places/autocomplete" in url:
                return {"results": []}
            return {"results": [{
                "id": 20, "location": "49.0,-123.0", "species_guess": "A flower", "obscured": False,
                "photos": [
                    {"id": 1, "license_code": "cc-by-nc", "url": "https://inaturalist.org/photos/1/square.jpg"},
                    {"id": 2, "license_code": "cc-by", "url": "https://inaturalist.org/photos/2/square.jpg", "attribution": "A photographer"},
                ],
            }]}

        client = Client(handler)
        result = search_inaturalist(client, {"name": "Example Park", "latitude": 49.0, "longitude": -123.0})
        self.assertEqual(client.calls[-1][1]["photo_license"], "cc0,cc-by,cc-by-sa")
        self.assertEqual([row["source_id"] for row in result], ["2"])
        self.assertEqual(result[0]["license"], "CC BY")
        self.assertEqual(result[0]["license_url"], "https://www.inaturalist.org/photos/2")


if __name__ == "__main__":
    unittest.main()
