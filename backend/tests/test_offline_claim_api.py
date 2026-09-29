import hashlib
import os
import time
from datetime import datetime, timedelta, timezone
from uuid import uuid4

import psycopg
import pytest
from fastapi.testclient import TestClient
from psycopg.rows import dict_row

import backend.app.main as api


PLACE_ID = "provincial-goldstream-park"
PASSWORD = "offline claim test password"


def bearer(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def register(client: TestClient, email: str) -> dict:
    response = client.post(
        "/api/auth/register", json={"email": email, "password": PASSWORD}
    )
    assert response.status_code == 201, response.text
    return response.json()


def cleanup(emails: list[str]) -> None:
    if not os.environ.get("DATABASE_URL"):
        return
    with psycopg.connect(os.environ["DATABASE_URL"]) as conn:
        conn.execute("DELETE FROM accounts WHERE email = ANY(%s)", (emails,))
        conn.commit()


def claim_payload(grant_token: str, captured_at: datetime, *, request_id=None) -> dict:
    sample = api.get_boundary_registry(
        api.settings.staging_field_places_enabled
    ).representative_sample(PLACE_ID, captured_at)
    return {
        "requestId": str(request_id or uuid4()),
        "grantToken": grant_token,
        "expectedPlaceId": PLACE_ID,
        "location": {
            "latitude": sample.latitude,
            "longitude": sample.longitude,
            "accuracyMeters": 5,
            "capturedAtEpochMs": int(captured_at.timestamp() * 1000),
        },
    }


def test_offline_grants_bundle_replay_and_reset_are_account_scoped():
    if not os.environ.get("DATABASE_URL"):
        pytest.skip("DATABASE_URL is required for offline claim integration tests")
    emails = [f"offline-claim-{uuid4().hex}@example.com" for _ in range(2)]
    cleanup(emails)
    try:
        with TestClient(api.app) as client:
            assert client.post("/api/offline-claim-grants").status_code == 401

            summary = client.get("/api/places?summary=true")
            assert summary.status_code == 200, summary.text
            summary_place = next(
                item for item in summary.json()["places"] if item["id"] == PLACE_ID
            )
            assert summary_place["description"] == ""
            assert summary_place["sourceUrl"] == ""
            assert summary_place["sourceName"]
            assert "visitorDetails" not in summary_place
            assert summary.json()["visitClaims"] == {
                "supported": True,
                "enforcement": api.settings.visit_claim_enforcement,
                "offlineSupported": True,
            }

            bundle = client.get(f"/api/places/{PLACE_ID}/offline-bundle")
            assert bundle.status_code == 200, bundle.text
            assert bundle.json()["place"]["id"] == PLACE_ID
            visitor_details = bundle.json()["place"]["visitorDetails"]
            assert visitor_details["schemaVersion"] == "1.0.0"
            assert visitor_details["areaHectares"] == 477
            assert visitor_details["activities"]
            assert "placeId" not in visitor_details
            assert "identity" not in visitor_details
            assert "archiveIds" not in visitor_details["source"]
            assert "extractionMethod" not in visitor_details["source"]
            assert bundle.json()["boundary"]["type"] == "Feature"
            assert bundle.json()["boundary"]["geometry"]["type"] in {
                "Polygon",
                "MultiPolygon",
            }
            assert len(bundle.json()["boundaryVersion"]) == 64

            first = register(client, emails[0])
            second = register(client, emails[1])
            first_headers = bearer(first["token"])
            second_headers = bearer(second["token"])
            full_detail = client.get(f"/api/places/{PLACE_ID}", headers=first_headers)
            assert full_detail.status_code == 200, full_detail.text
            assert full_detail.json()["visitorDetails"] == visitor_details
            search = client.get(
                "/api/places/search",
                headers=first_headers,
                params={"query": "Goldstream"},
            )
            assert search.status_code == 200, search.text
            assert search.json()["places"]
            assert "visitorDetails" not in search.json()["places"][0]
            issued = client.post(
                "/api/offline-claim-grants", headers=first_headers
            )
            assert issued.status_code == 201, issued.text
            grant = issued.json()
            assert len(grant["grantToken"]) == 43
            assert grant["expiresAt"] > grant["issuedAt"]
            assert grant["boundaryVersion"] == bundle.json()["boundaryVersion"]
            grant_hash = hashlib.sha256(grant["grantToken"].encode("ascii")).hexdigest()

            with psycopg.connect(
                os.environ["DATABASE_URL"], row_factory=dict_row
            ) as conn:
                stored = conn.execute(
                    "SELECT token_hash, issued_at, expires_at, revoked_at "
                    "FROM offline_claim_grants WHERE token_hash = %s",
                    (grant_hash,),
                ).fetchone()
                assert stored is not None
                assert stored["token_hash"] != grant["grantToken"]
                assert stored["expires_at"] - stored["issued_at"] == timedelta(days=30)

            captured_at = datetime.now(timezone.utc) - timedelta(days=7)
            body = claim_payload(grant["grantToken"], captured_at)
            wrong_account = client.post(
                "/api/offline-claims", headers=second_headers, json=body
            )
            assert wrong_account.status_code == 404
            assert wrong_account.json()["detail"]["code"] == "offline_claim_grant_not_found"

            # Simulate a device returning after a week with a fix captured inside
            # the grant's window. The grant remains exactly thirty days long.
            issued_at = datetime.now(timezone.utc) - timedelta(days=8)
            expires_at = issued_at + timedelta(days=30)
            with psycopg.connect(os.environ["DATABASE_URL"]) as conn:
                conn.execute(
                    "UPDATE offline_claim_grants SET issued_at = %s, expires_at = %s "
                    "WHERE token_hash = %s",
                    (issued_at, expires_at, grant_hash),
                )
                conn.commit()

            created = client.post(
                "/api/offline-claims", headers=first_headers, json=body
            )
            assert created.status_code == 200, created.text
            confirmation = created.json()
            assert confirmation["placeId"] == PLACE_ID
            assert confirmation["claim"]["matchKind"] == "exact"
            captured_at_sent = datetime.fromtimestamp(
                int(captured_at.timestamp() * 1000) / 1000,
                tz=timezone.utc,
            )
            captured_at_received = datetime.fromisoformat(
                confirmation["claim"]["capturedAt"]
            )
            assert captured_at_received == captured_at_sent

            replay = client.post(
                "/api/offline-claims", headers=first_headers, json=body
            )
            assert replay.status_code == 200, replay.text
            assert replay.json() == confirmation

            changed = {**body, "location": {**body["location"], "accuracyMeters": 6}}
            conflict = client.post(
                "/api/offline-claims", headers=first_headers, json=changed
            )
            assert conflict.status_code == 409
            assert conflict.json()["detail"]["code"] == "offline_claim_request_id_conflict"

            undo = client.put(
                f"/api/visits/{PLACE_ID}",
                headers=first_headers,
                json={"visited": False},
            )
            assert undo.status_code == 200, undo.text
            assert undo.json()["visited"] is False
            after_undo_replay = client.post(
                "/api/offline-claims", headers=first_headers, json=body
            )
            assert after_undo_replay.status_code == 410
            assert (
                after_undo_replay.json()["detail"]["code"]
                == "offline_claim_receipt_invalidated"
            )
            assert "visit was removed" in after_undo_replay.json()["detail"]["message"]
            with psycopg.connect(
                os.environ["DATABASE_URL"], row_factory=dict_row
            ) as conn:
                assert conn.execute(
                    "SELECT 1 FROM account_visits WHERE account_id = %s AND place_id = %s",
                    (first["account"]["id"], PLACE_ID),
                ).fetchone() is None
                assert conn.execute(
                    "SELECT invalidated_at FROM offline_claim_requests "
                    "WHERE account_id = %s AND request_id = %s",
                    (first["account"]["id"], body["requestId"]),
                ).fetchone()["invalidated_at"] is not None

            reset = client.delete("/api/account/progress", headers=first_headers)
            assert reset.status_code == 204, reset.text
            after_reset_replay = client.post(
                "/api/offline-claims", headers=first_headers, json=body
            )
            assert after_reset_replay.status_code == 410
            assert after_reset_replay.json()["detail"]["code"] == "offline_claim_receipt_invalidated"
            with psycopg.connect(
                os.environ["DATABASE_URL"], row_factory=dict_row
            ) as conn:
                assert conn.execute(
                    "SELECT 1 FROM account_visits WHERE account_id = %s AND place_id = %s",
                    (first["account"]["id"], PLACE_ID),
                ).fetchone() is None
                assert conn.execute(
                    "SELECT revoked_at FROM offline_claim_grants WHERE token_hash = %s",
                    (grant_hash,),
                ).fetchone()["revoked_at"] is not None
                assert conn.execute(
                    "SELECT COUNT(*) AS count FROM offline_claim_requests WHERE account_id = %s",
                    (first["account"]["id"],),
                ).fetchone()["count"] == 1

            after_reset_new_request = client.post(
                "/api/offline-claims",
                headers=first_headers,
                json={**body, "requestId": str(uuid4())},
            )
            assert after_reset_new_request.status_code == 410
            assert after_reset_new_request.json()["detail"]["code"] == "offline_claim_grant_revoked"
    finally:
        cleanup(emails)


def test_offline_claim_rechecks_current_boundary_for_historical_grant_version(
    monkeypatch,
):
    if not os.environ.get("DATABASE_URL"):
        pytest.skip("DATABASE_URL is required for offline claim integration tests")
    email = f"offline-claim-validation-{uuid4().hex}@example.com"
    cleanup([email])
    try:
        with TestClient(api.app) as client:
            account = register(client, email)
            headers = bearer(account["token"])
            grant = client.post("/api/offline-claim-grants", headers=headers).json()
            registry = api.get_boundary_registry(
                api.settings.staging_field_places_enabled
            )
            issued_at = datetime.now(timezone.utc) - timedelta(days=8)
            expires_at = issued_at + timedelta(days=30)
            grant_hash = hashlib.sha256(
                grant["grantToken"].encode("ascii")
            ).hexdigest()
            with psycopg.connect(os.environ["DATABASE_URL"]) as conn:
                conn.execute(
                    "UPDATE offline_claim_grants SET issued_at = %s, expires_at = %s "
                    "WHERE token_hash = %s",
                    (issued_at, expires_at, grant_hash),
                )
                conn.commit()
            captured_at = datetime.now(timezone.utc) - timedelta(days=7)
            interior_body = claim_payload(grant["grantToken"], captured_at)
            outside_body = {
                **claim_payload(grant["grantToken"], captured_at),
                "requestId": str(uuid4()),
                "location": {
                    **interior_body["location"],
                    "latitude": 49.0,
                    "longitude": -124.0,
                },
            }
            assert not registry.contains_exact(
                PLACE_ID,
                outside_body["location"]["latitude"],
                outside_body["location"]["longitude"],
            )

            class SameVersionOutside:
                offline_version = registry.offline_version

                @staticmethod
                def contains_exact(place_id, latitude, longitude):
                    return False

            monkeypatch.setattr(api, "get_boundary_registry", lambda _enabled: SameVersionOutside())
            outside = client.post(
                "/api/offline-claims", headers=headers, json=interior_body
            )
            assert outside.status_code == 422
            assert outside.json()["detail"]["code"] == "offline_location_outside_boundary"

            with psycopg.connect(os.environ["DATABASE_URL"]) as conn:
                conn.execute(
                    "UPDATE offline_claim_grants SET boundary_version = %s "
                    "WHERE token_hash = %s",
                    ("f" * 64, grant_hash),
                )
                conn.commit()
            monkeypatch.setattr(api, "get_boundary_registry", lambda _enabled: registry)
            accepted_body = {**interior_body, "requestId": str(uuid4())}
            accepted = client.post(
                "/api/offline-claims",
                headers=headers,
                json=accepted_body,
            )
            assert accepted.status_code == 200, accepted.text
            assert accepted.json()["claim"]["boundaryVersion"] == registry.offline_version
            replay = client.post(
                "/api/offline-claims", headers=headers, json=accepted_body
            )
            assert replay.status_code == 200
            assert replay.json() == accepted.json()

            rejected = client.post(
                "/api/offline-claims",
                headers=headers,
                json={**outside_body, "grantToken": grant["grantToken"]},
            )
            assert rejected.status_code == 422
            assert rejected.json()["detail"]["code"] == "offline_location_outside_boundary"
            with psycopg.connect(os.environ["DATABASE_URL"], row_factory=dict_row) as conn:
                stored_claim = conn.execute(
                    "SELECT boundary_version FROM account_visit_claims "
                    "WHERE account_id = %s AND place_id = %s",
                    (account["account"]["id"], PLACE_ID),
                ).fetchone()
                assert stored_claim["boundary_version"] == registry.offline_version
    finally:
        cleanup([email])


def test_undo_tombstone_rejects_pending_fix_but_allows_a_new_fix():
    if not os.environ.get("DATABASE_URL"):
        pytest.skip("DATABASE_URL is required for offline claim integration tests")
    email = f"offline-claim-undo-{uuid4().hex}@example.com"
    cleanup([email])
    try:
        with TestClient(api.app) as client:
            account = register(client, email)
            headers = bearer(account["token"])
            issued = client.post("/api/offline-claim-grants", headers=headers)
            assert issued.status_code == 201, issued.text
            grant = issued.json()
            grant_hash = hashlib.sha256(
                grant["grantToken"].encode("ascii")
            ).hexdigest()
            issued_at = datetime.now(timezone.utc) - timedelta(minutes=1)
            expires_at = issued_at + timedelta(days=30)
            with psycopg.connect(os.environ["DATABASE_URL"]) as conn:
                conn.execute(
                    "UPDATE offline_claim_grants SET issued_at = %s, expires_at = %s "
                    "WHERE token_hash = %s",
                    (issued_at, expires_at, grant_hash),
                )
                conn.commit()

            captured_before_undo = datetime.now(timezone.utc) - timedelta(seconds=1)
            pending_body = claim_payload(
                grant["grantToken"], captured_before_undo
            )
            online_capture = datetime.now(timezone.utc)
            online_sample = api.get_boundary_registry(
                api.settings.staging_field_places_enabled
            ).representative_sample(PLACE_ID, online_capture)
            online_recommendation = client.post(
                "/api/claim-recommendations",
                headers=headers,
                json={
                    "location": {
                        "latitude": online_sample.latitude,
                        "longitude": online_sample.longitude,
                        "accuracyMeters": 5,
                        "capturedAtEpochMs": int(
                            online_capture.timestamp() * 1000
                        ),
                    }
                },
            )
            assert online_recommendation.status_code == 200, online_recommendation.text
            assert online_recommendation.json()["candidate"]["placeId"] == PLACE_ID
            undo = client.put(
                f"/api/visits/{PLACE_ID}",
                headers=headers,
                json={"visited": False},
            )
            assert undo.status_code == 200, undo.text

            with psycopg.connect(
                os.environ["DATABASE_URL"], row_factory=dict_row
            ) as conn:
                tombstone = conn.execute(
                    "SELECT undone_at FROM offline_claim_undo_tombstones "
                    "WHERE account_id = %s AND place_id = %s",
                    (account["account"]["id"], PLACE_ID),
                ).fetchone()
                assert tombstone is not None
                assert tombstone["undone_at"] > captured_before_undo

            stale = client.post(
                "/api/offline-claims", headers=headers, json=pending_body
            )
            assert stale.status_code == 410, stale.text
            assert stale.json()["detail"]["code"] == "offline_claim_precedes_place_undo"
            late_online_claim = client.post(
                "/api/claims",
                headers=headers,
                json={
                    "recommendationToken": online_recommendation.json()[
                        "recommendationToken"
                    ],
                    "expectedPlaceId": PLACE_ID,
                },
            )
            assert late_online_claim.status_code == 404
            assert (
                late_online_claim.json()["detail"]["code"]
                == "claim_recommendation_not_found"
            )
            stale_online_recommendation = client.post(
                "/api/claim-recommendations",
                headers=headers,
                json={
                    "location": {
                        "latitude": online_sample.latitude,
                        "longitude": online_sample.longitude,
                        "accuracyMeters": 5,
                        "capturedAtEpochMs": int(
                            online_capture.timestamp() * 1000
                        ),
                    }
                },
            )
            assert stale_online_recommendation.status_code == 410
            assert (
                stale_online_recommendation.json()["detail"]["code"]
                == "claim_location_precedes_place_undo"
            )
            with psycopg.connect(
                os.environ["DATABASE_URL"], row_factory=dict_row
            ) as conn:
                assert conn.execute(
                    "SELECT 1 FROM account_visits WHERE account_id = %s AND place_id = %s",
                    (account["account"]["id"], PLACE_ID),
                ).fetchone() is None
                assert conn.execute(
                    "SELECT 1 FROM offline_claim_requests "
                    "WHERE account_id = %s AND request_id = %s",
                    (account["account"]["id"], pending_body["requestId"]),
                ).fetchone() is None

            # Give the timestamp's millisecond representation room to advance
            # past PostgreSQL's microsecond undo time.
            time.sleep(0.02)
            captured_after_undo = datetime.now(timezone.utc)
            assert captured_after_undo > tombstone["undone_at"]
            fresh_online_sample = api.get_boundary_registry(
                api.settings.staging_field_places_enabled
            ).representative_sample(PLACE_ID, captured_after_undo)
            fresh_online_recommendation = client.post(
                "/api/claim-recommendations",
                headers=headers,
                json={
                    "location": {
                        "latitude": fresh_online_sample.latitude,
                        "longitude": fresh_online_sample.longitude,
                        "accuracyMeters": 5,
                        "capturedAtEpochMs": int(
                            captured_after_undo.timestamp() * 1000
                        ),
                    }
                },
            )
            assert fresh_online_recommendation.status_code == 200
            assert (
                fresh_online_recommendation.json()["candidate"]["placeId"]
                == PLACE_ID
            )
            fresh_body = claim_payload(grant["grantToken"], captured_after_undo)
            fresh = client.post(
                "/api/offline-claims", headers=headers, json=fresh_body
            )
            assert fresh.status_code == 200, fresh.text
            assert fresh.json()["placeId"] == PLACE_ID
            with psycopg.connect(
                os.environ["DATABASE_URL"], row_factory=dict_row
            ) as conn:
                assert conn.execute(
                    "SELECT 1 FROM account_visits WHERE account_id = %s AND place_id = %s",
                    (account["account"]["id"], PLACE_ID),
                ).fetchone() is not None
                assert conn.execute(
                    "SELECT 1 FROM offline_claim_requests "
                    "WHERE account_id = %s AND request_id = %s",
                    (account["account"]["id"], fresh_body["requestId"]),
                ).fetchone() is not None
    finally:
        cleanup([email])
