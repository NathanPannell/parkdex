from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import AnyHttpUrl, BaseModel, ConfigDict, Field, field_validator


class MonitorCreate(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    url: AnyHttpUrl = Field(max_length=2048)

    @field_validator("name")
    @classmethod
    def normalize_name(cls, value: str) -> str:
        normalized = value.strip()
        if not normalized:
            raise ValueError("Name cannot be blank")
        return normalized


class Monitor(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    name: str
    url: str
    status: Literal["UNKNOWN", "UP", "DOWN"]
    http_status: int | None
    response_time_ms: int | None
    checked_at: datetime | None
    created_at: datetime
