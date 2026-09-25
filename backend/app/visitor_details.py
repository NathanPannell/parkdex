from __future__ import annotations

from datetime import date, datetime
from typing import Annotated, Literal
from urllib.parse import urlsplit

from pydantic import AfterValidator, BaseModel, ConfigDict, Field, field_validator


VisitorText = Annotated[str, Field(min_length=1)]
VisitorTimestamp = Annotated[
    str,
    Field(min_length=1, json_schema_extra={"format": "date-time"}),
]


def validate_visitor_url(value: str) -> str:
    if value != value.strip() or any(
        character.isspace() or ord(character) < 0x20 or ord(character) == 0x7F
        for character in value
    ):
        raise ValueError("URL must not contain whitespace or control characters")
    try:
        parsed = urlsplit(value)
        hostname = parsed.hostname
        port = parsed.port
    except ValueError as exc:
        raise ValueError("URL must be a valid HTTP(S) URL with a hostname") from exc
    if parsed.scheme not in {"http", "https"} or not hostname:
        raise ValueError("URL must be a valid HTTP(S) URL with a hostname")
    if port is not None and not 1 <= port <= 65535:
        raise ValueError("URL port must be between 1 and 65535")
    if parsed.username is not None or parsed.password is not None:
        raise ValueError("URL must not contain credentials")
    return value


VisitorUrl = Annotated[
    str,
    Field(
        min_length=1,
        pattern=r"^https?://",
        json_schema_extra={"format": "uri"},
    ),
    AfterValidator(validate_visitor_url),
]
Latitude = Annotated[float, Field(ge=-90, le=90)]
Longitude = Annotated[float, Field(ge=-180, le=180)]


class VisitorModel(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        populate_by_name=True,
        allow_inf_nan=False,
    )


class VisitorScope(VisitorModel):
    kind: Literal["park", "site", "island", "community", "dataset"]
    matched_name: VisitorText | None = Field(alias="matchedName")
    parent_name: VisitorText | None = Field(alias="parentName")
    match_method: VisitorText | None = Field(alias="matchMethod")


class VisitorSource(VisitorModel):
    primary_url: VisitorUrl | None = Field(alias="primaryUrl")
    authority: VisitorText | None
    kind: Literal[
        "visitor_page",
        "official_park_api",
        "geographic_record",
        "shared_dataset",
        "directory",
    ]
    geographic_source_url: VisitorUrl | None = Field(alias="geographicSourceUrl")
    retrieved_at: VisitorTimestamp | None = Field(alias="retrievedAt")
    status: Literal[
        "pending",
        "extracted",
        "partial",
        "no_park_specific_content",
        "fetch_failed",
        "blocked_by_policy",
        "needs_review",
    ]

    @field_validator("retrieved_at")
    @classmethod
    def retrieved_at_is_an_iso_timestamp(cls, value: str | None) -> str | None:
        if value is None:
            return None
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError as exc:
            raise ValueError("retrievedAt must be an ISO timestamp or null") from exc
        if parsed.tzinfo is None or parsed.utcoffset() is None:
            raise ValueError("retrievedAt must include a timezone offset")
        return value


class DatasetSource(VisitorSource):
    archive_ids: list[str] = Field(alias="archiveIds")
    extraction_method: Literal["api_mapping", "luna_html", "catalogue_only"] | None = Field(
        alias="extractionMethod"
    )


class VisitorActivity(VisitorModel):
    name: VisitorText
    details: VisitorText | None


class VisitorFacility(VisitorModel):
    name: VisitorText
    details: VisitorText | None
    availability: Literal[
        "available", "unavailable", "seasonal", "conditional", "unspecified", None
    ]


class VisitorEntryPoint(VisitorModel):
    name: VisitorText | None
    latitude: Latitude
    longitude: Longitude


class VisitorAccess(VisitorModel):
    directions: VisitorText | None
    address: VisitorText | None
    transport_notes: VisitorText | None = Field(alias="transportNotes")
    entry_points: list[VisitorEntryPoint] | None = Field(alias="entryPoints")


class VisitorTrail(VisitorModel):
    name: VisitorText
    description: VisitorText | None
    length_km: Annotated[float, Field(ge=0)] | None = Field(alias="lengthKm")
    elevation_gain_m: Annotated[float, Field(ge=0)] | None = Field(alias="elevationGainM")
    difficulty: VisitorText | None
    map_url: VisitorUrl | None = Field(alias="mapUrl")


class VisitorMap(VisitorModel):
    title: VisitorText | None
    url: VisitorUrl | None
    kind: Literal["park", "trail", "directions", "other", None]


class VisitorRules(VisitorModel):
    pets: VisitorText | None
    cycling: VisitorText | None
    campfires: VisitorText | None
    other: list[VisitorActivity] | None


class VisitorAccessibility(VisitorModel):
    summary: VisitorText | None
    features: list[VisitorActivity] | None


class VisitorOperations(VisitorModel):
    hours: VisitorText | None
    seasons: VisitorText | None
    notes: VisitorText | None


class VisitorCamping(VisitorModel):
    summary: VisitorText | None
    reservation_required: bool | None = Field(alias="reservationRequired")
    booking_url: VisitorUrl | None = Field(alias="bookingUrl")
    reservation_notes: VisitorText | None = Field(alias="reservationNotes")
    fees: VisitorText | None


class VisitorContact(VisitorModel):
    name: VisitorText | None
    role: VisitorText | None
    phone: VisitorText | None
    email: VisitorText | None
    url: VisitorUrl | None


class VisitorBackground(VisitorModel):
    history: VisitorText | None
    conservation: VisitorText | None
    cultural_context: VisitorText | None = Field(alias="culturalContext")
    wildlife: VisitorText | None


class PlaceVisitorDetails(VisitorModel):
    schema_version: Literal["1.0.0"] = Field(alias="schemaVersion")
    scope: VisitorScope
    source: VisitorSource
    overview: VisitorText | None
    area_hectares: Annotated[float, Field(gt=0)] | None = Field(alias="areaHectares")
    activities: list[VisitorActivity] | None
    facilities: list[VisitorFacility] | None
    access: VisitorAccess
    trails: list[VisitorTrail] | None
    maps: list[VisitorMap] | None
    map_notes: VisitorText | None = Field(alias="mapNotes")
    rules: VisitorRules
    accessibility: VisitorAccessibility
    operations: VisitorOperations
    camping: VisitorCamping
    contacts: list[VisitorContact] | None
    background: VisitorBackground
    official_updates_url: VisitorUrl | None = Field(alias="officialUpdatesUrl")


class DatasetIdentity(VisitorModel):
    name: VisitorText
    category: Literal["provincial", "national", "regional", "island"]
    region: VisitorText | None
    latitude: Latitude
    longitude: Longitude
    coordinate_role: Literal["catalogue_reference_point_not_verified_entrance"] = Field(
        alias="coordinateRole"
    )


class DatasetRecord(PlaceVisitorDetails):
    place_id: VisitorText = Field(alias="placeId")
    identity: DatasetIdentity
    source: DatasetSource
    review_flag_ids: list[str] = Field(alias="reviewFlagIds")


class ReviewedPlace(VisitorModel):
    place_id: VisitorText = Field(alias="placeId")
    visitor_details: PlaceVisitorDetails = Field(alias="visitorDetails")


class ReviewedDataset(VisitorModel):
    schema_version: Literal["1.0.0"] = Field(alias="schemaVersion")
    snapshot_date: date = Field(alias="snapshotDate")
    places: list[ReviewedPlace]
