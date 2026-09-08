from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator

PlaceCategory = Literal["national", "provincial", "regional", "island"]


class Place(BaseModel):
    model_config = ConfigDict(from_attributes=True, populate_by_name=True)
    id: str
    name: str
    category: PlaceCategory
    latitude: float
    longitude: float
    region: str
    description: str
    source_url: str = Field(serialization_alias="sourceUrl")
    source_name: str = Field(serialization_alias="sourceName")
    source_id: str | None = Field(default=None, serialization_alias="sourceId")


class PlaceCollection(BaseModel):
    places: list[Place]
    visited_ids: list[str] = Field(serialization_alias="visitedIds")
    visits: list["Visit"]
    coverage_note: str = Field(serialization_alias="coverageNote")
    completed_trail_ids: list[str] = Field(default_factory=list, serialization_alias="completedTrailIds")


class Visit(BaseModel):
    place_id: str = Field(serialization_alias="placeId")
    visited_at: datetime = Field(serialization_alias="visitedAt")


class VisitUpdate(BaseModel):
    visited: bool


class VisitResult(BaseModel):
    place_id: str = Field(serialization_alias="placeId")
    visited: bool
    visited_count: int = Field(serialization_alias="visitedCount")
    visited_at: datetime | None = Field(default=None, serialization_alias="visitedAt")


class TrailUpdate(BaseModel):
    completed: bool


class TrailResult(BaseModel):
    trail_id: str = Field(serialization_alias="trailId")
    completed: bool
    completed_trail_count: int = Field(serialization_alias="completedTrailCount")


class Credentials(BaseModel):
    email: EmailStr
    password: str = Field(min_length=8, max_length=128)

    @field_validator("email")
    @classmethod
    def normalize_email(cls, value: EmailStr) -> str:
        return str(value).strip().lower()


class Account(BaseModel):
    id: str
    email: str


class AuthResult(BaseModel):
    token: str
    expires_at: datetime = Field(serialization_alias="expiresAt")
    account: Account
    visited_ids: list[str] = Field(serialization_alias="visitedIds")
    visits: list[Visit]
    completed_trail_ids: list[str] = Field(default_factory=list, serialization_alias="completedTrailIds")


class AccountState(BaseModel):
    account: Account
    visited_ids: list[str] = Field(serialization_alias="visitedIds")
    visits: list[Visit]
    completed_trail_ids: list[str] = Field(default_factory=list, serialization_alias="completedTrailIds")


class GuestImportResult(BaseModel):
    imported_visit_count: int = Field(serialization_alias="importedVisitCount")
    visited_ids: list[str] = Field(serialization_alias="visitedIds")
    visits: list[Visit]
    imported_trail_count: int = Field(default=0, serialization_alias="importedTrailCount")
    completed_trail_ids: list[str] = Field(default_factory=list, serialization_alias="completedTrailIds")
