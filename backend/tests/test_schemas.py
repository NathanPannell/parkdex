import pytest
from pydantic import ValidationError

from backend.app.schemas import MonitorCreate


def test_monitor_name_is_trimmed() -> None:
    monitor = MonitorCreate(name="  Marketing site  ", url="https://example.com")
    assert monitor.name == "Marketing site"


def test_monitor_name_cannot_be_blank() -> None:
    with pytest.raises(ValidationError):
        MonitorCreate(name="   ", url="https://example.com")
