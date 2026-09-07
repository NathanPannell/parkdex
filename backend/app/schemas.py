from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

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
    coverage_note: str = Field(serialization_alias="coverageNote")


class VisitUpdate(BaseModel):
    visited: bool


class VisitResult(BaseModel):
    place_id: str = Field(serialization_alias="placeId")
    visited: bool
    visited_count: int = Field(serialization_alias="visitedCount")
