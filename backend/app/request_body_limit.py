"""Streaming request-body limits for routes that parse uploaded content.

FastAPI parses a multipart body before it enters an endpoint function.  A
limit in the endpoint (for example, ``UploadFile.read(limit)``) therefore
does not bound the amount of data the multipart parser has already consumed.
This module provides a small ASGI middleware that sits in front of that
parser.  It rejects an over-limit ``Content-Length`` without dispatching the
request and counts bytes as they arrive when the request is chunked or has no
``Content-Length`` header.
"""

from __future__ import annotations

import re
from collections.abc import Callable

from starlette.exceptions import HTTPException
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from backend.app.claim_photos import MAX_UPLOAD_BYTES


# The image limit applies to the photo part, while the ASGI guard sees the
# complete multipart envelope.  This leaves room for boundaries and headers
# without allowing a materially larger upload to reach python-multipart.
MULTIPART_OVERHEAD_BYTES = 64 * 1024
MAX_CLAIM_PHOTO_BODY_BYTES = MAX_UPLOAD_BYTES + MULTIPART_OVERHEAD_BYTES
CLAIM_PHOTO_BODY_TOO_LARGE_DETAIL = "Claim photo request body is too large"
INVALID_CONTENT_LENGTH_DETAIL = "Invalid Content-Length header"

_DECIMAL = re.compile(rb"[0-9]+$")


class _InvalidContentLength(ValueError):
    """The request contains an invalid or ambiguous Content-Length value."""


class _BodyLimitExceeded(HTTPException):
    """Internal signal raised before an over-limit body reaches the app.

    FastAPI deliberately converts arbitrary exceptions raised while parsing a
    request into a generic 400.  Subclassing its normal HTTP exception type
    lets the signal pass through that parser unchanged; the middleware catches
    it and emits the precise 413 response.
    """

    def __init__(self, detail: str) -> None:
        super().__init__(status_code=413, detail=detail)


def is_claim_photo_upload(scope: Scope) -> bool:
    """Return whether ``scope`` is the authenticated claim-photo PUT route.

    The trailing slash is accepted here because Starlette may redirect it to
    the canonical route.  Matching it as well prevents a large body from
    reaching the redirect handling path without the same pre-parser guard.
    """

    if scope.get("type") != "http" or scope.get("method") != "PUT":
        return False
    path = scope.get("path", "")
    if not isinstance(path, str):
        return False
    path = path.rstrip("/")
    parts = path.split("/")
    return (
        len(parts) == 5
        and parts[1] == "api"
        and parts[2] == "visits"
        and bool(parts[3])
        and parts[4] == "photo"
    )


def _content_length(scope: Scope) -> int | None:
    """Parse a request's Content-Length, rejecting malformed ambiguity.

    HTTP allows intermediaries to preserve repeated headers.  Identical
    repeated values are harmless; differing values are ambiguous and must not
    be interpreted differently by the app and an upstream proxy.
    """

    values: list[int] = []
    for name, value in scope.get("headers", ()):
        if name.lower() != b"content-length":
            continue
        if not isinstance(value, (bytes, bytearray)):
            raise _InvalidContentLength
        raw = bytes(value).strip()
        if not _DECIMAL.fullmatch(raw):
            raise _InvalidContentLength
        try:
            values.append(int(raw))
        except (TypeError, ValueError, OverflowError) as exc:
            # A pathological all-digit header can exceed Python's integer
            # conversion limit.  Treating it as malformed is fail-closed and
            # avoids doing expensive work before the parser is reached.
            raise _InvalidContentLength from exc
    if not values:
        return None
    if any(value != values[0] for value in values[1:]):
        raise _InvalidContentLength
    return values[0]


class RequestBodyLimitMiddleware:
    """Apply a streaming byte cap to requests selected by ``should_limit``.

    ``should_limit`` receives the untouched ASGI HTTP scope.  The middleware
    never buffers the request: it forwards each body message immediately when
    the cumulative byte count remains within the limit.
    """

    def __init__(
        self,
        app: ASGIApp,
        *,
        max_body_bytes: int,
        should_limit: Callable[[Scope], bool],
        body_too_large_detail: str = "Request body is too large",
    ) -> None:
        if isinstance(max_body_bytes, bool) or max_body_bytes <= 0:
            raise ValueError("max_body_bytes must be a positive integer")
        self.app = app
        self.max_body_bytes = max_body_bytes
        self.should_limit = should_limit
        self.body_too_large_detail = body_too_large_detail

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if not self.should_limit(scope):
            await self.app(scope, receive, send)
            return

        try:
            declared_length = _content_length(scope)
        except _InvalidContentLength:
            await _send_json_error(
                scope,
                receive,
                send,
                status_code=400,
                detail=INVALID_CONTENT_LENGTH_DETAIL,
            )
            return

        if declared_length is not None and declared_length > self.max_body_bytes:
            await _send_json_error(
                scope,
                receive,
                send,
                status_code=413,
                detail=self.body_too_large_detail,
            )
            return

        received_bytes = 0
        response_started = False

        async def limited_receive() -> Message:
            nonlocal received_bytes
            message = await receive()
            if message.get("type") == "http.request":
                body = message.get("body", b"")
                received_bytes += len(body)
                if received_bytes > self.max_body_bytes:
                    raise _BodyLimitExceeded(self.body_too_large_detail)
            return message

        async def tracked_send(message: Message) -> None:
            nonlocal response_started
            if message.get("type") == "http.response.start":
                response_started = True
            await send(message)

        try:
            await self.app(scope, limited_receive, tracked_send)
        except _BodyLimitExceeded:
            # A normal parser reads the request before the endpoint can start
            # a response.  If an unusual streaming app has already started
            # one, ASGI cannot replace its status with 413; re-raise rather
            # than emitting a second response start.
            if response_started:
                raise
            await _send_json_error(
                scope,
                receive,
                send,
                status_code=413,
                detail=self.body_too_large_detail,
            )


class ClaimPhotoBodyLimitMiddleware(RequestBodyLimitMiddleware):
    """Pre-parser cap for ``PUT /api/visits/{place_id}/photo``."""

    def __init__(
        self,
        app: ASGIApp,
        *,
        max_body_bytes: int = MAX_CLAIM_PHOTO_BODY_BYTES,
    ) -> None:
        super().__init__(
            app,
            max_body_bytes=max_body_bytes,
            should_limit=is_claim_photo_upload,
            body_too_large_detail=CLAIM_PHOTO_BODY_TOO_LARGE_DETAIL,
        )


async def _send_json_error(
    scope: Scope,
    receive: Receive,
    send: Send,
    *,
    status_code: int,
    detail: str,
) -> None:
    await JSONResponse(
        {"detail": detail},
        status_code=status_code,
        headers={"Cache-Control": "no-store"},
    )(scope, receive, send)
