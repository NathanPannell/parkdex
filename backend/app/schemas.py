from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator, model_validator

PlaceCategory = Literal["national", "provincial", "regional", "island"]


def normalize_address(value: EmailStr) -> str:
    normalized = str(value).strip().lower()
    if normalized.endswith("@googlemail.com"):
        return normalized.removesuffix("@googlemail.com") + "@gmail.com"
    return normalized


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


class SearchPlace(Place):
    visited: bool = False
    distance_km: float | None = Field(default=None, serialization_alias="distanceKm")


class PlaceSearchResult(BaseModel):
    places: list[SearchPlace]
    total: int
    limit: int
    offset: int


class GroupCreate(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    placeIds: list[str] = Field(
        default_factory=list,
        max_length=100,
    )

    @model_validator(mode="before")
    @classmethod
    def accept_snake_case_place_ids(cls, value):
        if isinstance(value, dict) and "placeIds" not in value and "place_ids" in value:
            return {**value, "placeIds": value["place_ids"]}
        return value


class GroupRename(BaseModel):
    name: str = Field(min_length=1, max_length=200)


class GroupPlaceMutation(BaseModel):
    placeIds: list[str] = Field(
        max_length=100,
    )

    @model_validator(mode="before")
    @classmethod
    def accept_snake_case_place_ids(cls, value):
        if isinstance(value, dict) and "placeIds" not in value and "place_ids" in value:
            return {**value, "placeIds": value["place_ids"]}
        return value


class Group(BaseModel):
    id: str
    name: str
    is_wishlist: bool = Field(serialization_alias="isWishlist")
    created_at: datetime = Field(serialization_alias="createdAt")
    updated_at: datetime = Field(serialization_alias="updatedAt")
    place_ids: list[str] = Field(serialization_alias="placeIds")
    places: list[Place]
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
    password: str = Field(min_length=12, max_length=128)

    @field_validator("email")
    @classmethod
    def normalize_email(cls, value: EmailStr) -> str:
        return normalize_address(value)


class Account(BaseModel):
    id: str
    email: str
    email_verified: bool = Field(serialization_alias="emailVerified")
    has_password: bool = Field(serialization_alias="hasPassword")


class EmailRequest(BaseModel):
    email: EmailStr

    @field_validator("email")
    @classmethod
    def normalize_email(cls, value: EmailStr) -> str:
        return normalize_address(value)


class TokenConfirmation(BaseModel):
    token: str = Field(min_length=43, max_length=43)


class PasswordResetConfirmation(TokenConfirmation):
    newPassword: str = Field(min_length=12, max_length=128)


class PasswordChange(BaseModel):
    currentPassword: str = Field(min_length=1, max_length=128)
    newPassword: str = Field(min_length=12, max_length=128)


class PasswordSet(BaseModel):
    newPassword: str = Field(min_length=12, max_length=128)


class GoogleStart(BaseModel):
    authorization_url: str = Field(serialization_alias="authorizationUrl")


class GoogleCallback(BaseModel):
    code: str = Field(min_length=1, max_length=4096)
    state: str = Field(min_length=43, max_length=43)
    codeVerifier: str = Field(
        min_length=43,
        max_length=128,
        pattern=r"^[A-Za-z0-9._~-]+$",
    )


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
