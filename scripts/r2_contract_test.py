import importlib.util
from pathlib import Path

import pytest

from backend.app.object_storage import ObjectStorageNotFound


SPEC = importlib.util.spec_from_file_location(
    "r2_contract", Path(__file__).with_name("r2-contract.py")
)
assert SPEC and SPEC.loader
r2_contract = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(r2_contract)


class FakeStorage:
    def __init__(self, *, fail_get: bool = False, fail_missing_read: bool = False):
        self.values = {}
        self.events = []
        self.fail_get = fail_get
        self.fail_missing_read = fail_missing_read

    def put(self, key, content, content_type):
        self.events.append(("put", key, content_type))
        self.values[key] = content

    def get(self, key):
        self.events.append(("get", key))
        if self.fail_get:
            raise RuntimeError("provider read failed")
        if key not in self.values:
            if self.fail_missing_read:
                raise RuntimeError("provider verification read failed")
            raise ObjectStorageNotFound(key)
        return self.values[key]

    def delete(self, key):
        self.events.append(("delete", key))
        self.values.pop(key, None)


def test_contract_puts_gets_deletes_and_confirms_missing_read():
    storage = FakeStorage()
    result = r2_contract.run_contract(
        storage, byte_count=4, random_bytes=lambda count: b"data"
    )

    assert result["status"] == "success"
    assert result["byteCount"] == 4
    assert set(result["timingsMs"]) == {"put", "get", "delete", "missingRead", "total"}
    assert [event[0] for event in storage.events] == ["put", "get", "delete", "get"]
    assert not storage.values
    assert storage.events[0][2] == "application/octet-stream"


def test_contract_guarantees_cleanup_after_a_failed_read():
    storage = FakeStorage(fail_get=True)

    with pytest.raises(RuntimeError, match="provider read failed"):
        r2_contract.run_contract(
            storage, byte_count=4, random_bytes=lambda count: b"data"
        )

    assert not storage.values
    assert [event[0] for event in storage.events] == ["put", "get", "delete"]


def test_contract_retries_delete_when_missing_read_cannot_verify_deletion():
    storage = FakeStorage(fail_missing_read=True)

    with pytest.raises(RuntimeError, match="verification read failed"):
        r2_contract.run_contract(
            storage, byte_count=4, random_bytes=lambda count: b"data"
        )

    assert not storage.values
    assert [event[0] for event in storage.events] == [
        "put",
        "get",
        "delete",
        "get",
        "delete",
    ]
