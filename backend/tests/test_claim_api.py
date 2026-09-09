from datetime import datetime, timezone
from concurrent.futures import ThreadPoolExecutor
from io import BytesIO
import hashlib
import os
from threading import Event

from fastapi.testclient import TestClient
from PIL import Image
import psycopg

from backend.app.claims import get_boundary_registry
from backend.app.main import app


GUEST_ONE = "c" * 43
GUEST_TWO = "d" * 43
ACCOUNT_EMAIL = "claims-api@example.com"


def guest_headers(key=GUEST_ONE):
    return {"X-Collection-Key": key}


def bearer(token):
    return {"Authorization": f"Bearer {token}"}


def location_payload(place_id="provincial-goldstream-park"):
    now = datetime.now(timezone.utc)
    sample = get_boundary_registry().representative_sample(place_id, now)
    return {
        "location": {
            "latitude": sample.latitude,
            "longitude": sample.longitude,
            "accuracyMeters": sample.accuracy_meters,
            "capturedAtEpochMs": int(now.timestamp() * 1000),
        }
    }


def png_photo(color="green"):
    output = BytesIO()
    Image.new("RGB", (1800, 1200), color).save(output, format="PNG")
    return output.getvalue()


def cleanup():
    database_url = os.environ["DATABASE_URL"]
    guest_hashes = [hashlib.sha256(key.encode("ascii")).hexdigest() for key in (GUEST_ONE, GUEST_TWO)]
    with psycopg.connect(database_url) as conn:
        conn.execute("DELETE FROM accounts WHERE email = %s", (ACCOUNT_EMAIL,))
        conn.execute("DELETE FROM visits WHERE owner_hash = ANY(%s)", (guest_hashes,))
        conn.execute("DELETE FROM claim_recommendations WHERE owner_hash = ANY(%s)", (guest_hashes,))
        conn.commit()


def recommend(client, headers):
    response = client.post("/api/claim-recommendations", headers=headers, json=location_payload())
    assert response.status_code == 200, response.text
    assert response.json()["status"] == "recommended"
    return response.json()


def claim(client, headers, recommendation):
    return client.post(
        "/api/claims",
        headers=headers,
        json={
            "recommendationToken": recommendation["recommendationToken"],
            "expectedPlaceId": recommendation["candidate"]["placeId"],
        },
    )


def test_guest_claim_is_owner_bound_photo_private_and_undo_blocks_replay():
    cleanup()
    try:
        with TestClient(app) as client:
            recommendation = recommend(client, guest_headers())
            place_id = recommendation["candidate"]["placeId"]
            legacy_bypass = client.put(f"/api/visits/{place_id}", headers=guest_headers(), json={"visited": True})
            assert legacy_bypass.status_code == 409
            assert legacy_bypass.json()["detail"]["code"] == "location_claim_required"

            stolen = claim(client, guest_headers(GUEST_TWO), recommendation)
            assert stolen.status_code == 404
            mismatch = client.post(
                "/api/claims", headers=guest_headers(),
                json={"recommendationToken": recommendation["recommendationToken"], "expectedPlaceId": "wrong-place"},
            )
            assert mismatch.status_code == 409

            created = claim(client, guest_headers(), recommendation)
            assert created.status_code == 200, created.text
            assert created.json()["placeId"] == place_id
            assert created.json()["claim"]["hasPhoto"] is False
            assert claim(client, guest_headers(), recommendation).json() == created.json()

            photo = png_photo()
            uploaded = client.put(
                f"/api/visits/{place_id}/photo", headers=guest_headers(), files={"photo": ("visit.png", photo, "image/png")},
            )
            assert uploaded.status_code == 200, uploaded.text
            assert uploaded.json()["photo"]["contentType"] == "image/jpeg"
            saved = client.get(f"/api/visits/{place_id}/photo", headers=guest_headers())
            assert saved.status_code == 200
            assert saved.headers["cache-control"] == "private, no-store"
            assert client.get(f"/api/visits/{place_id}/photo", headers=guest_headers(GUEST_TWO)).status_code == 404

            failed_replace = client.put(
                f"/api/visits/{place_id}/photo", headers=guest_headers(), files={"photo": ("bad.jpg", b"bad", "image/jpeg")},
            )
            assert failed_replace.status_code == 422
            assert client.get(f"/api/visits/{place_id}/photo", headers=guest_headers()).content == saved.content

            assert client.delete(f"/api/visits/{place_id}/photo", headers=guest_headers()).status_code == 204
            assert client.get(f"/api/visits/{place_id}/photo", headers=guest_headers()).status_code == 404
            assert client.put(
                f"/api/visits/{place_id}/photo", headers=guest_headers(), files={"photo": ("visit.png", photo, "image/png")},
            ).status_code == 200

            undone = client.put(f"/api/visits/{place_id}", headers=guest_headers(), json={"visited": False})
            assert undone.status_code == 200
            replay = claim(client, guest_headers(), recommendation)
            assert replay.status_code == 404
            assert replay.json()["detail"]["code"] == "claim_recommendation_not_found"
            assert client.get(f"/api/visits/{place_id}/photo", headers=guest_headers()).status_code == 404
    finally:
        cleanup()


def test_guest_claim_photo_imports_to_account_and_reset_cascades():
    cleanup()
    try:
        with TestClient(app) as client:
            recommendation = recommend(client, guest_headers())
            place_id = recommendation["candidate"]["placeId"]
            assert claim(client, guest_headers(), recommendation).status_code == 200
            assert client.put(
                f"/api/visits/{place_id}/photo", headers=guest_headers(), files={"photo": ("visit.png", png_photo("blue"), "image/png")},
            ).status_code == 200

            account = client.post("/api/auth/register", json={"email": ACCOUNT_EMAIL, "password": "claims integration password"})
            assert account.status_code == 201
            account_headers = bearer(account.json()["token"])
            pending = recommend(client, account_headers)
            imported = client.post("/api/account/import-guest", headers={**account_headers, "X-Collection-Key": GUEST_ONE})
            assert imported.status_code == 200, imported.text
            visit = next(item for item in imported.json()["visits"] if item["placeId"] == place_id)
            assert visit["claim"]["hasPhoto"] is True
            assert client.get(f"/api/visits/{place_id}/photo", headers=account_headers).status_code == 200
            old_guest_token = claim(client, account_headers, recommendation)
            assert old_guest_token.status_code == 404

            assert client.delete("/api/account/progress", headers=account_headers).status_code == 204
            assert client.get(f"/api/visits/{place_id}/photo", headers=account_headers).status_code == 404
            assert claim(client, account_headers, pending).status_code == 404
    finally:
        cleanup()


def test_late_guest_photo_is_merged_by_a_repeated_import(monkeypatch):
    import backend.app.main as api

    cleanup()
    normalization_started = Event()
    finish_normalization = Event()
    real_normalize = api.normalize_photo

    def blocked_normalize(payload):
        normalization_started.set()
        assert finish_normalization.wait(timeout=10)
        return real_normalize(payload)

    monkeypatch.setattr(api, "normalize_photo", blocked_normalize)
    try:
        with TestClient(app) as upload_client, TestClient(app) as client, ThreadPoolExecutor(max_workers=1) as executor:
            recommendation = recommend(client, guest_headers())
            place_id = recommendation["candidate"]["placeId"]
            assert claim(client, guest_headers(), recommendation).status_code == 200
            account = client.post(
                "/api/auth/register",
                json={"email": ACCOUNT_EMAIL, "password": "claims integration password"},
            )
            account_headers = bearer(account.json()["token"])

            upload = executor.submit(
                upload_client.put,
                f"/api/visits/{place_id}/photo",
                headers=guest_headers(),
                files={"photo": ("visit.png", png_photo("purple"), "image/png")},
            )
            assert normalization_started.wait(timeout=10)

            first_import = client.post(
                "/api/account/import-guest",
                headers={**account_headers, "X-Collection-Key": GUEST_ONE},
            )
            assert first_import.status_code == 200
            first_visit = next(item for item in first_import.json()["visits"] if item["placeId"] == place_id)
            assert first_visit["claim"]["hasPhoto"] is False

            finish_normalization.set()
            assert upload.result(timeout=10).status_code == 200

            repeated = client.post(
                "/api/account/import-guest",
                headers={**account_headers, "X-Collection-Key": GUEST_ONE},
            )
            assert repeated.status_code == 200
            assert repeated.json()["importedVisitCount"] == 0
            repeated_visit = next(item for item in repeated.json()["visits"] if item["placeId"] == place_id)
            assert repeated_visit["claim"]["hasPhoto"] is True
            assert {**repeated_visit["claim"], "hasPhoto": False} == first_visit["claim"]
            assert client.get(f"/api/visits/{place_id}/photo", headers=account_headers).status_code == 200
    finally:
        finish_normalization.set()
        cleanup()


def test_reimport_respects_latest_guest_or_account_photo_mutation():
    cleanup()
    try:
        with TestClient(app) as client:
            recommendation = recommend(client, guest_headers())
            place_id = recommendation["candidate"]["placeId"]
            assert claim(client, guest_headers(), recommendation).status_code == 200
            assert client.put(
                f"/api/visits/{place_id}/photo",
                headers=guest_headers(),
                files={"photo": ("guest.png", png_photo("green"), "image/png")},
            ).status_code == 200
            account = client.post(
                "/api/auth/register",
                json={"email": ACCOUNT_EMAIL, "password": "claims integration password"},
            )
            account_headers = bearer(account.json()["token"])
            import_headers = {**account_headers, "X-Collection-Key": GUEST_ONE}
            assert client.post("/api/account/import-guest", headers=import_headers).status_code == 200
            assert client.get(f"/api/visits/{place_id}/photo", headers=account_headers).status_code == 200

            # A later account deletion is a tombstone. Re-importing unchanged
            # guest progress must not resurrect the older guest photo.
            assert client.delete(f"/api/visits/{place_id}/photo", headers=account_headers).status_code == 204
            assert client.post("/api/account/import-guest", headers=import_headers).status_code == 200
            assert client.get(f"/api/visits/{place_id}/photo", headers=account_headers).status_code == 404

            # Account-side photo choices remain authoritative even when the
            # original guest lineage later uploads a different photo.
            assert client.put(
                f"/api/visits/{place_id}/photo",
                headers=guest_headers(),
                files={"photo": ("new-guest.png", png_photo("blue"), "image/png")},
            ).status_code == 200
            assert client.post("/api/account/import-guest", headers=import_headers).status_code == 200
            assert client.get(f"/api/visits/{place_id}/photo", headers=account_headers).status_code == 404

            # A fresh imported lineage with no account-side edit follows a
            # guest deletion tombstone on the next explicit import.
            second_account = client.post(
                "/api/auth/register",
                json={"email": "claims-delete-propagation@example.com", "password": "claims integration password"},
            )
            second_headers = bearer(second_account.json()["token"])
            second_import_headers = {**second_headers, "X-Collection-Key": GUEST_ONE}
            assert client.post("/api/account/import-guest", headers=second_import_headers).status_code == 200
            assert client.get(f"/api/visits/{place_id}/photo", headers=second_headers).status_code == 200
            assert client.delete(f"/api/visits/{place_id}/photo", headers=guest_headers()).status_code == 204
            assert client.post("/api/account/import-guest", headers=second_import_headers).status_code == 200
            assert client.get(f"/api/visits/{place_id}/photo", headers=second_headers).status_code == 404

            # An account upload also permanently takes ownership of the photo
            # slot for this imported lineage.
            assert client.put(
                f"/api/visits/{place_id}/photo",
                headers=second_headers,
                files={"photo": ("account-owned.png", png_photo("orange"), "image/png")},
            ).status_code == 200
            account_owned = client.get(f"/api/visits/{place_id}/photo", headers=second_headers).content
            assert client.put(
                f"/api/visits/{place_id}/photo",
                headers=guest_headers(),
                files={"photo": ("newer-guest.png", png_photo("purple"), "image/png")},
            ).status_code == 200
            assert client.post("/api/account/import-guest", headers=second_import_headers).status_code == 200
            assert client.get(f"/api/visits/{place_id}/photo", headers=second_headers).content == account_owned
    finally:
        cleanup()
        with psycopg.connect(os.environ["DATABASE_URL"]) as conn:
            conn.execute("DELETE FROM accounts WHERE email = %s", ("claims-delete-propagation@example.com",))
            conn.commit()


def test_guest_import_does_not_graft_photo_onto_an_independent_account_claim():
    cleanup()
    try:
        with TestClient(app) as client:
            account = client.post(
                "/api/auth/register",
                json={"email": ACCOUNT_EMAIL, "password": "claims integration password"},
            )
            account_headers = bearer(account.json()["token"])
            account_recommendation = recommend(client, account_headers)
            place_id = account_recommendation["candidate"]["placeId"]
            assert claim(client, account_headers, account_recommendation).status_code == 200
            account_upload = client.put(
                f"/api/visits/{place_id}/photo",
                headers=account_headers,
                files={"photo": ("account.png", png_photo("orange"), "image/png")},
            )
            assert account_upload.status_code == 200
            original = client.get(f"/api/visits/{place_id}/photo", headers=account_headers).content

            guest_recommendation = recommend(client, guest_headers())
            assert claim(client, guest_headers(), guest_recommendation).status_code == 200
            assert client.put(
                f"/api/visits/{place_id}/photo",
                headers=guest_headers(),
                files={"photo": ("guest.png", png_photo("green"), "image/png")},
            ).status_code == 200

            imported = client.post(
                "/api/account/import-guest",
                headers={**account_headers, "X-Collection-Key": GUEST_ONE},
            )
            assert imported.status_code == 200
            assert client.get(f"/api/visits/{place_id}/photo", headers=account_headers).content == original
    finally:
        cleanup()


def test_two_guest_tokens_for_one_place_never_surface_a_unique_constraint():
    cleanup()
    try:
        with TestClient(app) as client, ThreadPoolExecutor(max_workers=2) as executor:
            first = recommend(client, guest_headers())
            second = recommend(client, guest_headers())
            assert first["candidate"]["placeId"] == second["candidate"]["placeId"]

            responses = list(executor.map(lambda item: claim(client, guest_headers(), item), (first, second)))
            statuses = sorted(response.status_code for response in responses)
            assert statuses == [200, 409]
            rejected = next(response for response in responses if response.status_code == 409)
            assert rejected.json()["detail"]["code"] == "claim_place_already_claimed"
    finally:
        cleanup()


def test_stale_location_and_expired_recommendation_are_rejected():
    cleanup()
    try:
        with TestClient(app) as client:
            payload = location_payload()
            payload["location"]["capturedAtEpochMs"] -= 61_000
            stale = client.post("/api/claim-recommendations", headers=guest_headers(), json=payload)
            assert stale.status_code == 422
            assert stale.json()["detail"]["code"] == "location_stale"
            inaccurate_payload = location_payload()
            inaccurate_payload["location"]["accuracyMeters"] = 50.1
            inaccurate = client.post("/api/claim-recommendations", headers=guest_headers(), json=inaccurate_payload)
            assert inaccurate.status_code == 422
            assert inaccurate.json()["detail"]["code"] == "location_accuracy_too_low"

            recommendation = recommend(client, guest_headers())
            token_hash = hashlib.sha256(recommendation["recommendationToken"].encode("ascii")).hexdigest()
            with psycopg.connect(os.environ["DATABASE_URL"]) as conn:
                conn.execute(
                    "UPDATE claim_recommendations SET captured_at = NOW() - INTERVAL '2 minutes', expires_at = NOW() - INTERVAL '1 minute' WHERE token_hash = %s",
                    (token_hash,),
                )
                conn.commit()
            expired = claim(client, guest_headers(), recommendation)
            assert expired.status_code == 410
            assert expired.json()["detail"]["code"] == "claim_recommendation_expired"
    finally:
        cleanup()


def test_named_fixture_gate_has_no_arbitrary_coordinate_override(monkeypatch):
    import backend.app.main as api

    cleanup()
    original_mode = api.settings.claim_test_mode
    original_environment = api.settings.app_environment
    try:
        with TestClient(app) as client:
            disabled = client.post(
                "/api/claim-recommendations", headers=guest_headers(), json={"testFixtureId": "inside-goldstream"}
            )
            assert disabled.status_code == 403
            monkeypatch.setattr(api.settings, "claim_test_mode", True)
            monkeypatch.setattr(api.settings, "app_environment", "test")
            fixture = client.post(
                "/api/claim-recommendations", headers=guest_headers(), json={"testFixtureId": "inside-goldstream"}
            )
            assert fixture.status_code == 200
            assert fixture.json()["candidate"]["placeId"] == "provincial-goldstream-park"
            unknown = client.post(
                "/api/claim-recommendations", headers=guest_headers(), json={"testFixtureId": "latitude=49"}
            )
            assert unknown.status_code == 404
    finally:
        api.settings.claim_test_mode = original_mode
        api.settings.app_environment = original_environment
        cleanup()
