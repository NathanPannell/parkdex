import pytest
from fastapi import HTTPException

from backend.app.main import collection_hash


def test_collection_key_is_hashed_and_never_used_as_owner_id() -> None:
    key = "a" * 43
    owner = collection_hash(key)
    assert owner is not None
    assert owner != key
    assert len(owner) == 64


def test_collection_keys_are_isolated() -> None:
    assert collection_hash("a" * 43) != collection_hash("b" * 43)


@pytest.mark.parametrize("value", ["short", "contains spaces" + "x" * 40, "!" * 43])
def test_invalid_collection_key_is_rejected(value: str) -> None:
    with pytest.raises(HTTPException):
        collection_hash(value, required=True)
