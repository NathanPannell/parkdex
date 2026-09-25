from __future__ import annotations

import hashlib
import os
from datetime import datetime, timezone
from uuid import uuid4

import psycopg
import pytest
from fastapi.testclient import TestClient

from backend.app.achievements import achievements
from backend.app.catalogue import normalize_categories, normalize_visit_filter
from backend.app.main import app


def test_catalogue_filter_normalization_accepts_multi_category_and_visit_aliases() -> None:
    assert normalize_categories(["regional", "provincial", "regional"]) == [
        "regional",
        "provincial",
    ]
    assert normalize_categories([]) is None
    assert normalize_visit_filter("all") is None
    assert normalize_visit_filter("visited") is True
    assert normalize_visit_filter("unseen") is False
    assert normalize_visit_filter("false") is False
    with pytest.raises(ValueError):
        normalize_categories(["campground"])
    with pytest.raises(ValueError):
        normalize_visit_filter("recent")


def test_badge_progress_uses_visible_places_and_visit_chronology() -> None:
    places = [
        {"id": "provincial-juan-de-fuca-park", "name": "Juan de Fuca", "region": "West Coast"},
        {"id": "provincial-carmanah-walbran-park", "name": "Carmanah", "region": "West Coast"},
        {"id": "provincial-macmillan-park", "name": "Macmillan", "region": "Central Island"},
    ]
    visits = [
        {"place_id": "provincial-macmillan-park", "visited_at": datetime(2026, 9, 3, 10, tzinfo=timezone.utc)},
        {"place_id": "provincial-carmanah-walbran-park", "visited_at": datetime(2026, 9, 2, 10, tzinfo=timezone.utc)},
        {"place_id": "provincial-juan-de-fuca-park", "visited_at": datetime(2026, 9, 1, 10, tzinfo=timezone.utc)},
        {"place_id": "retired-place", "visited_at": datetime(2026, 8, 31, 10, tzinfo=timezone.utc)},
    ]
    badges = achievements(places=places, visits=visits)
    banana = next(badge for badge in badges if badge["id"] == "banana-slug-medal")
    rookie = next(badge for badge in badges if badge["id"] == "river-otter-rookie")
    assert banana["current"] == 3
    assert banana["earned"] is True
    assert banana["earned_at"].isoformat() == "2026-09-03T10:00:00+00:00"
    assert banana["required_places"] == [
        {"id": "provincial-juan-de-fuca-park", "name": "Juan de Fuca"},
        {"id": "provincial-carmanah-walbran-park", "name": "Carmanah"},
        {"id": "provincial-macmillan-park", "name": "Macmillan"},
    ]
    assert rookie["current"] == 1


def test_map_sampling_search_and_progress_are_bounded_and_identity_aware() -> None:
    database_url = os.environ.get("DATABASE_URL")
    if not database_url:
        pytest.skip("DATABASE_URL is required for catalogue API integration coverage")

    run_id = uuid4().hex
    place_ids = [f"viewport-fixture-{run_id}-{index:02}" for index in range(99)]
    guest_key = (run_id * 2)[:43]
    guest_hash = hashlib.sha256(guest_key.encode("ascii")).hexdigest()
    email = f"catalogue-{run_id}@example.com"
    base_latitude = 47.01
    base_longitude = -129.98
    categories = ["national"] + ["island"] * 20 + ["provincial"] * 25 + ["regional"] * 24 + ["provincial"] * 29
    special_names = [
        "Literal % wildcard",
        "Literal X wildcard",
        "Literal _ wildcard",
        "Literal A wildcard",
        r"Literal \ wildcard",
        "Literal - wildcard",
    ]
    region_match_names = [f"Alpine Region Match {index:02}" for index in range(22)] + [
        "Strathcona Park"
    ]

    with psycopg.connect(database_url) as conn:
        conn.execute("DELETE FROM places WHERE id = ANY(%s)", (place_ids,))
        conn.execute("DELETE FROM visits WHERE owner_hash = %s", (guest_hash,))
        conn.cursor().executemany(
            """INSERT INTO places (
                id, name, category, latitude, longitude, region, description,
                source_url, source_name
            ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)""",
            [
                (
                    place_ids[index],
                    region_match_names[index - 76]
                    if index >= 76
                    else special_names[index - 70]
                    if index >= 70
                    else f"Viewport Fixture {run_id} {index:02}",
                    categories[index],
                    base_latitude + index * 0.002,
                    base_longitude + index * 0.002,
                    "Strathcona Test Region" if index >= 76 else "Catalogue viewport test region",
                    "" if index >= 70 else f"search-token-{run_id}",
                    f"https://example.test/{place_ids[index]}",
                    "Test source",
                )
                for index in range(len(place_ids))
            ],
        )
        conn.execute(
            "INSERT INTO visits (owner_hash, place_id) VALUES (%s, %s), (%s, %s)",
            (guest_hash, place_ids[21], guest_hash, place_ids[46]),
        )
        conn.commit()

    try:
        with TestClient(app) as client:
            registration = client.post(
                "/api/auth/register",
                json={"email": email, "password": "catalogue fixture password"},
            )
            assert registration.status_code == 201, registration.text
            account_id = registration.json()["account"]["id"]
            account_headers = {"Authorization": f"Bearer {registration.json()['token']}"}
            guest_headers = {"X-Collection-Key": guest_key}
            group = client.post(
                "/api/groups",
                headers=account_headers,
                json={"name": "Viewport map fixture", "placeIds": [place_ids[0], place_ids[21], place_ids[46]]},
            )
            assert group.status_code == 201, group.text
            with psycopg.connect(database_url) as conn:
                conn.execute(
                    "INSERT INTO account_visits (account_id, place_id) VALUES (%s, %s)",
                    (account_id, place_ids[22]),
                )
                conn.commit()

            # Broad viewport queries return a stable, bounded sample. Every
            # visible national park and globally selected island is retained.
            broad_bounds = {"west": -180, "south": -90, "east": 180, "north": 90}
            full_catalogue = client.get("/api/places", params={"summary": "true"})
            assert full_catalogue.status_code == 200
            all_places = full_catalogue.json()["places"]
            island_priority = {
                place["id"]
                for place in sorted(
                    (place for place in all_places if place["category"] == "island"),
                    key=lambda place: (hashlib.md5(place["id"].encode()).hexdigest(), place["id"]),
                )[:12]
            }
            expected_priority = {
                place["id"]
                for place in all_places
                if place["category"] == "national" or place["id"] in island_priority
            }
            first = client.get("/api/map/places", params=broad_bounds)
            again = client.get("/api/map/places", params=broad_bounds)
            assert first.status_code == 200, first.text
            markers = first.json()["places"]
            marker_ids = [place["id"] for place in markers]
            assert len(markers) == 50
            assert first.json()["total"] > 50
            assert set(expected_priority).issubset(marker_ids)
            assert marker_ids == [place["id"] for place in again.json()["places"]]
            tiers = [place["priorityTier"] for place in markers]
            assert tiers == sorted(tiers)
            assert all(len(place["priorityKey"]) == 32 for place in markers)
            assert all(place["authority"] and place["listRegion"] for place in markers)
            assert all("sourceUrl" in place for place in markers)
            national_fixture = next(place for place in markers if place["id"] == place_ids[0])
            assert national_fixture["sourceUrl"] == f"https://example.test/{place_ids[0]}"

            # A selected regular place can displace a tier-two sample, but
            # the exception cannot bypass viewport or category filters.
            sampled = set(marker_ids)
            selected = next(
                place
                for place in all_places
                if place["id"].startswith(f"viewport-fixture-{run_id}-")
                and place["category"] in {"provincial", "regional"}
                and place["id"] not in sampled
            )
            selected_response = client.get(
                "/api/map/places",
                params={**broad_bounds, "selected_id": selected["id"]},
            )
            assert selected_response.status_code == 200
            assert len(selected_response.json()["places"]) == 50
            assert selected["id"] in {
                place["id"] for place in selected_response.json()["places"]
            }
            outside_view = client.get(
                "/api/map/places",
                params={
                    "west": -122,
                    "south": 51,
                    "east": -122,
                    "north": 52,
                    "selected_id": selected["id"],
                },
            )
            assert selected["id"] not in {
                place["id"] for place in outside_view.json()["places"]
            }
            boundary_page = client.get(
                "/api/map/boundaries",
                params={"place_id": "provincial-goldstream-park"},
            )
            assert boundary_page.status_code == 200, boundary_page.text
            assert {
                feature["properties"]["id"]
                for feature in boundary_page.json()["features"]
            } <= {"provincial-goldstream-park"}
            over_limit = client.get(
                "/api/map/boundaries",
                params=[("place_id", place_ids[0])] * 51,
            )
            assert over_limit.status_code == 400

            # A viewport with one fixture returns the complete sparse result.
            sparse = client.get(
                "/api/map/places",
                params={
                    "west": base_longitude,
                    "south": base_latitude,
                    "east": base_longitude,
                    "north": base_latitude,
                },
            )
            assert sparse.status_code == 200, sparse.text
            assert sparse.json()["total"] == 1
            assert [place["id"] for place in sparse.json()["places"]] == [place_ids[0]]

            # Repeated categories and guest/account visit state are applied in
            # SQL before rows are returned, for both map and paged search.
            guest_map = client.get(
                "/api/map/places",
                params={**broad_bounds, "category": ["provincial", "regional"], "visited": "visited"},
                headers=guest_headers,
            )
            account_map = client.get(
                "/api/map/places",
                params={**broad_bounds, "visited": "visited"},
                headers=account_headers,
            )
            assert set(place["id"] for place in guest_map.json()["places"]) == {
                place_ids[21],
                place_ids[46],
            }
            assert {place["id"] for place in account_map.json()["places"]} == {
                place_ids[22]
            }
            group_map = client.get(
                "/api/map/places",
                params={**broad_bounds, "group_id": group.json()["id"]},
                headers=account_headers,
            )
            assert group_map.status_code == 200, group_map.text
            assert group_map.json()["total"] == 3
            assert {place["id"] for place in group_map.json()["places"]} == {
                place_ids[0],
                place_ids[21],
                place_ids[46],
            }
            assert client.get(
                "/api/map/places",
                params={**broad_bounds, "group_id": group.json()["id"]},
                headers=guest_headers,
            ).status_code == 401
            search = client.get(
                "/api/places/search",
                params={
                    "query": run_id,
                    "category": ["provincial", "regional"],
                    "visited": "visited",
                    "limit": 10,
                },
                headers=guest_headers,
            )
            assert search.status_code == 200, search.text
            assert search.json()["total"] == 2
            assert {place["id"] for place in search.json()["places"]} == {
                place_ids[21],
                place_ids[46],
            }
            assert all(place["description"] == "" for place in search.json()["places"])
            assert all("sourceUrl" in place for place in search.json()["places"])
            for literal_query, expected_id in (
                ("Literal % wildcard", place_ids[70]),
                ("Literal _ wildcard", place_ids[72]),
                (r"Literal \ wildcard", place_ids[74]),
            ):
                literal_search = client.get(
                    "/api/places/search",
                    params={"query": literal_query, "category": "provincial", "limit": 10},
                )
                assert literal_search.status_code == 200, literal_search.text
                assert literal_search.json()["total"] == 1
                assert literal_search.json()["places"][0]["id"] == expected_id
            relevance_search = client.get(
                "/api/places/search",
                params={"query": "Strathcona", "category": "provincial", "limit": 20},
            )
            assert relevance_search.status_code == 200, relevance_search.text
            assert relevance_search.json()["total"] >= 23
            assert place_ids[98] in {
                place["id"] for place in relevance_search.json()["places"]
            }
            visited_page = client.get(
                "/api/catalogue/visited",
                params={"limit": 1, "offset": 0},
                headers=guest_headers,
            )
            assert visited_page.status_code == 200, visited_page.text
            assert visited_page.json()["total"] == 2
            assert len(visited_page.json()["places"]) == 1

            guest_state = client.get("/api/catalogue/state", headers=guest_headers)
            account_state = client.get("/api/catalogue/state", headers=account_headers)
            assert guest_state.status_code == account_state.status_code == 200
            assert set(guest_state.json()["visitedIds"]) == {place_ids[21], place_ids[46]}
            assert account_state.json()["visitedIds"] == [place_ids[22]]
            assert guest_state.json()["categoryTotals"]["national"] >= 1
            assert sum(guest_state.json()["categoryTotals"].values()) == guest_state.json()["total"]
            assert guest_state.json()["visitedCategoryTotals"]["provincial"] == 1
            assert guest_state.json()["visitedCategoryTotals"]["regional"] == 1
            rookie = next(
                badge for badge in guest_state.json()["badges"]
                if badge["id"] == "river-otter-rookie"
            )
            assert rookie["earned"] is True
            assert rookie["earnedAt"]

            # The long-standing full-catalogue endpoint remains available.
            legacy = client.get("/api/places", headers=guest_headers)
            assert legacy.status_code == 200
            assert len(legacy.json()["places"]) == guest_state.json()["total"]
    finally:
        with psycopg.connect(database_url) as conn:
            conn.execute("DELETE FROM accounts WHERE email = %s", (email,))
            conn.execute("DELETE FROM visits WHERE owner_hash = %s", (guest_hash,))
            conn.execute("DELETE FROM guest_trail_completions WHERE owner_hash = %s", (guest_hash,))
            conn.execute("DELETE FROM places WHERE id = ANY(%s)", (place_ids,))
            conn.commit()
