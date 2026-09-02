from unittest.mock import patch

from backend.worker.checker import check_url, host_is_public


def test_rejects_private_ip() -> None:
    with patch("socket.getaddrinfo", return_value=[(2, 1, 6, "", ("127.0.0.1", 0))]):
        assert host_is_public("localhost") is False


def test_private_target_is_down_without_request() -> None:
    with patch("backend.worker.checker.host_is_public", return_value=False):
        result = check_url("http://localhost/secret", 1)
    assert result.status == "DOWN"
    assert result.http_status is None

