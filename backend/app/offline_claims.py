"""Validation and durable idempotency helpers for offline location claims."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
import hashlib
import json
import math
import secrets

from backend.app.claims import ClaimInputError, LocationSample


OFFLINE_GRANT_VALIDITY = timedelta(days=30)
OFFLINE_GRANT_TOKEN_LENGTH = 43
OFFLINE_FUTURE_SKEW_SECONDS = 10.0


def create_offline_grant_token() -> tuple[str, str]:
    token = secrets.token_urlsafe(32)
    return token, hashlib.sha256(token.encode("ascii")).hexdigest()


def offline_grant_token_hash(token: str) -> str | None:
    if len(token) != OFFLINE_GRANT_TOKEN_LENGTH:
        return None
    try:
        token.encode("ascii")
    except UnicodeEncodeError:
        return None
    return hashlib.sha256(token.encode("ascii")).hexdigest()


def offline_request_fingerprint(
    *,
    grant_token: str,
    expected_place_id: str,
    latitude: float,
    longitude: float,
    accuracy_meters: float,
    captured_at_epoch_ms: int,
) -> str:
    """Hash the canonical request so receipts never retain the grant token."""

    payload = {
        "grantToken": grant_token,
        "expectedPlaceId": expected_place_id,
        "location": {
            "latitude": latitude,
            "longitude": longitude,
            "accuracyMeters": accuracy_meters,
            "capturedAtEpochMs": captured_at_epoch_ms,
        },
    }
    encoded = json.dumps(
        payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def validate_offline_location_sample(
    latitude: float,
    longitude: float,
    accuracy_meters: float,
    captured_at_epoch_ms: int,
    *,
    grant_issued_at: datetime,
    grant_expires_at: datetime,
    now: datetime | None = None,
) -> LocationSample:
    """Validate a saved fix against its grant window, without online freshness."""

    if not all(
        math.isfinite(value)
        for value in (latitude, longitude, accuracy_meters)
    ):
        raise ClaimInputError("invalid_location", "Location values must be finite")
    if not -90 <= latitude <= 90 or not -180 <= longitude <= 180:
        raise ClaimInputError(
            "invalid_location", "Location coordinates are out of range"
        )
    if accuracy_meters <= 0 or accuracy_meters > 50:
        raise ClaimInputError(
            "location_accuracy_too_low",
            "Location accuracy must be 50 metres or better",
        )
    try:
        captured_at = datetime.fromtimestamp(
            captured_at_epoch_ms / 1000, tz=timezone.utc
        )
    except (OverflowError, OSError, ValueError):
        raise ClaimInputError(
            "invalid_location_time", "Location timestamp is invalid"
        ) from None

    issued = grant_issued_at.astimezone(timezone.utc)
    expires = grant_expires_at.astimezone(timezone.utc)
    received_at = now or datetime.now(timezone.utc)
    if captured_at < issued:
        raise ClaimInputError(
            "offline_location_before_grant",
            "Location must be captured after this offline grant was issued",
        )
    if captured_at > expires:
        raise ClaimInputError(
            "offline_location_after_grant",
            "Location must be captured before this offline grant expires",
        )
    if (captured_at - received_at).total_seconds() > OFFLINE_FUTURE_SKEW_SECONDS:
        raise ClaimInputError(
            "location_time_in_future", "Location timestamp is too far in the future"
        )
    return LocationSample(latitude, longitude, accuracy_meters, captured_at)
