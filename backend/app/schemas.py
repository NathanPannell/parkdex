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


class Visit(BaseModel):
    place_id: str = Field(serialization_alias="placeId")
    visited_at: datetime = Field(serialization_alias="visitedAt")
    claim: "VisitClaim | None" = Field(default=None, exclude_if=lambda value: value is None)


class ClaimCoordinates(BaseModel):
    latitude: float
    longitude: float


class VisitClaim(BaseModel):
    claimed_at: datetime = Field(serialization_alias="claimedAt")
    captured_at: datetime = Field(serialization_alias="capturedAt")
    coordinates: ClaimCoordinates
    accuracy_meters: float = Field(serialization_alias="accuracyMeters")
    boundary_version: str = Field(serialization_alias="boundaryVersion")
    match_kind: Literal["exact", "buffer"] = Field(serialization_alias="matchKind")
    distance_meters: float = Field(serialization_alias="distanceMeters")
    has_photo: bool = Field(serialization_alias="hasPhoto")


class ClaimLocation(BaseModel):
    latitude: float = Field(allow_inf_nan=False)
    longitude: float = Field(allow_inf_nan=False)
    accuracy_meters: float = Field(serialization_alias="accuracyMeters", validation_alias="accuracyMeters", allow_inf_nan=False)
    captured_at_epoch_ms: int = Field(serialization_alias="capturedAtEpochMs", validation_alias="capturedAtEpochMs")


class ClaimRecommendationRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    location: ClaimLocation | None = None
    testFixtureId: str | None = Field(default=None, min_length=1, max_length=80)

    @model_validator(mode="after")
    def require_one_location_source(self):
        if (self.location is None) == (self.testFixtureId is None):
            raise ValueError("Send exactly one of location or testFixtureId")
        return self


class ClaimCandidate(BaseModel):
    place_id: str = Field(serialization_alias="placeId")
    match_kind: Literal["exact", "buffer"] = Field(serialization_alias="matchKind")
    distance_meters: float = Field(serialization_alias="distanceMeters")


class ClaimRecommendationResponse(BaseModel):
    status: Literal["recommended", "none"]
    recommendation_token: str | None = Field(default=None, serialization_alias="recommendationToken")
    expires_at: datetime | None = Field(default=None, serialization_alias="expiresAt")
    candidate: ClaimCandidate | None = None


class CreateClaimRequest(BaseModel):
    recommendationToken: str = Field(min_length=43, max_length=43)
    expectedPlaceId: str = Field(min_length=1, max_length=200)


class CreateClaimResponse(BaseModel):
    place_id: str = Field(serialization_alias="placeId")
    visited: Literal[True]
    visited_count: int = Field(serialization_alias="visitedCount")
    visited_at: datetime = Field(serialization_alias="visitedAt")
    claim: VisitClaim


class VisitPhoto(BaseModel):
    content_type: Literal["image/jpeg"] = Field(serialization_alias="contentType")
    width: int
    height: int
    byte_length: int = Field(serialization_alias="byteLength")
    sha256: str
    updated_at: datetime = Field(serialization_alias="updatedAt")


class VisitPhotoResult(BaseModel):
    place_id: str = Field(serialization_alias="placeId")
    photo: VisitPhoto


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
