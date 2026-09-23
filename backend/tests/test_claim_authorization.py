import inspect

import pytest
from fastapi import HTTPException

import backend.app.main as api
from backend.app.auth import AccountIdentity
from backend.app.claims import create_recommendation_token, recommendation_token_hash


def test_claims_reject_collection_keys_even_when_present_without_bearer():
    with pytest.raises(HTTPException) as raised:
        api.authenticated_claim_identity(object(), None, "x" * 43)
    assert raised.value.status_code == 401
    assert raised.value.detail["code"] == "authentication_required"


def test_claim_identity_delegates_only_to_bearer(monkeypatch):
    identity = AccountIdentity("account", "a@example.com", "session", True)
    monkeypatch.setattr(api, "require_bearer", lambda conn, authorization: identity)
    assert api.authenticated_claim_identity(object(), "Bearer token", None) == identity


def test_recommendation_tokens_are_hashed_and_reject_malformed_replays():
    token, digest = create_recommendation_token()
    assert len(token) == 43
    assert recommendation_token_hash(token) == digest
    assert recommendation_token_hash(token[:-1]) is None
    assert recommendation_token_hash("é" * 43) is None


def test_account_mutation_revalidates_session_after_account_lock(monkeypatch):
    identity = AccountIdentity("account", "a@example.com", "session", True)
    events = []
    monkeypatch.setattr(
        api,
        "lock_account_progress",
        lambda conn, account_id: events.append(("lock", account_id)),
    )

    def authenticate(conn, authorization):
        events.append(("authenticate", authorization))
        return identity

    monkeypatch.setattr(api, "require_bearer", authenticate)
    assert api.revalidate_locked_account_identity(
        object(), identity, "Bearer token"
    ) == identity
    assert events == [
        ("lock", "account"),
        ("authenticate", "Bearer token"),
    ]


def test_claim_revalidation_rejects_collection_keys_before_lock(monkeypatch):
    identity = AccountIdentity("account", "a@example.com", "session", True)
    locks = []
    monkeypatch.setattr(
        api,
        "revalidate_locked_account_identity",
        lambda *args: locks.append(args) or identity,
    )
    with pytest.raises(HTTPException) as raised:
        api.revalidate_locked_claim_identity(
            object(), identity, "Bearer token", "collection-key"
        )
    assert raised.value.status_code == 401
    assert locks == []


def test_logout_revalidates_session_after_account_lock(monkeypatch):
    identity = AccountIdentity("account", "a@example.com", "session", True)
    events = []

    class Connection:
        def execute(self, sql, params=()):
            events.append(("execute", " ".join(sql.split()), params))

        def commit(self):
            events.append(("commit",))

    monkeypatch.setattr(
        api,
        "require_bearer",
        lambda conn, authorization: events.append(("authenticate", authorization))
        or identity,
    )
    monkeypatch.setattr(
        api,
        "revalidate_locked_account_identity",
        lambda conn, expected, authorization: events.append(
            ("lock-and-revalidate", expected.account_id, authorization)
        )
        or identity,
    )

    response = api.logout(Connection(), "Bearer token")
    assert response.status_code == 204
    assert events[0] == ("authenticate", "Bearer token")
    assert events[1] == (
        "lock-and-revalidate",
        "account",
        "Bearer token",
    )
    assert events[2][0] == "execute"
    assert events[2][2] == (identity.session_hash,)
    assert events[3] == ("commit",)


def test_all_group_and_wishlist_writes_use_locked_bearer_revalidation():
    for handler in (
        api.list_groups,
        api.create_group,
        api.rename_group,
        api.delete_group,
        api.add_group_places_api,
        api.remove_group_places_api,
        api.get_wishlist,
        api.add_wishlist_places,
        api.remove_wishlist_places,
    ):
        assert "revalidate_locked_account_identity" in inspect.getsource(handler)


def test_claim_and_photo_capacity_is_reserved_globally_and_per_account(
    monkeypatch,
):
    calls = []

    class Connection:
        def commit(self):
            calls.append(("commit",))

    monkeypatch.setattr(
        api,
        "reserve_rate_limit",
        lambda conn, action, scope, limit, window: calls.append(
            (action, scope, limit, window)
        ),
    )
    conn = Connection()
    api.reserve_claim_recommendation_capacity(conn, "account")
    api.reserve_photo_upload_capacity(conn, "account")
    assert [call[:2] for call in calls] == [
        ("claim_recommendation_global", "global"),
        ("claim_recommendation", "account"),
        ("commit",),
        ("claim_photo_upload_global", "global"),
        ("claim_photo_upload", "account"),
        ("commit",),
    ]


def test_photo_object_keys_are_opaque_and_non_reusable():
    first = api.make_photo_object_key()
    second = api.make_photo_object_key()
    assert first.startswith("postcards/") and first.endswith(".jpg")
    assert first.count("/") == 1
    assert first != second
    assert "account" not in first and "place" not in first
