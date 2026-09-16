import asyncio

from fastapi import FastAPI, File, UploadFile

from backend.app.request_body_limit import (
    CLAIM_PHOTO_BODY_TOO_LARGE_DETAIL,
    ClaimPhotoBodyLimitMiddleware,
    RequestBodyLimitMiddleware,
    is_claim_photo_upload,
)


def run(coro):
    return asyncio.run(coro)


def scope(*, path="/api/visits/place-1/photo", method="PUT", headers=()):
    return {
        "type": "http",
        "method": method,
        "path": path,
        "headers": list(headers),
    }


def app_that_reads_all(messages_seen):
    async def app(_scope, receive, send):
        while True:
            message = await receive()
            messages_seen.append(message)
            if not message.get("more_body", False):
                break
        await send(
            {
                "type": "http.response.start",
                "status": 204,
                "headers": [],
            }
        )
        await send({"type": "http.response.body", "body": b""})

    return app


def receive_from(messages, calls):
    pending = iter(messages)

    async def receive():
        calls.append(True)
        return next(pending)

    return receive


def send_collector(sent):
    async def send(message):
        sent.append(message)

    return send


def test_claim_photo_matcher_is_route_and_method_scoped():
    assert is_claim_photo_upload(scope())
    assert is_claim_photo_upload(scope(path="/api/visits/place-1/photo/"))
    assert not is_claim_photo_upload(scope(method="POST"))
    assert not is_claim_photo_upload(scope(path="/api/visits/place-1"))
    assert not is_claim_photo_upload(scope(path="/api/visits//photo"))


def test_declared_over_limit_is_rejected_before_downstream_or_receive():
    called = []
    receive_calls = []
    sent = []

    async def downstream(*_args):
        called.append(True)

    middleware = RequestBodyLimitMiddleware(
        downstream,
        max_body_bytes=10,
        should_limit=is_claim_photo_upload,
    )
    run(
        middleware(
            scope(headers=[(b"content-length", b"11")]),
            receive_from([{"type": "http.request", "body": b"x" * 11}], receive_calls),
            send_collector(sent),
        )
    )

    assert called == []
    assert receive_calls == []
    assert [message["type"] for message in sent] == [
        "http.response.start",
        "http.response.body",
    ]
    assert sent[0]["status"] == 413
    assert b'"detail":"Request body is too large"' in sent[1]["body"]


def test_chunked_body_is_capped_across_messages_without_content_length():
    messages_seen = []
    receive_calls = []
    sent = []
    middleware = RequestBodyLimitMiddleware(
        app_that_reads_all(messages_seen),
        max_body_bytes=10,
        should_limit=is_claim_photo_upload,
    )

    run(
        middleware(
            scope(),
            receive_from(
                [
                    {"type": "http.request", "body": b"12345", "more_body": True},
                    {"type": "http.request", "body": b"67890", "more_body": True},
                    {"type": "http.request", "body": b"!", "more_body": False},
                ],
                receive_calls,
            ),
            send_collector(sent),
        )
    )

    assert messages_seen == [
        {"type": "http.request", "body": b"12345", "more_body": True},
        {"type": "http.request", "body": b"67890", "more_body": True},
    ]
    assert len(receive_calls) == 3
    assert [message["type"] for message in sent] == [
        "http.response.start",
        "http.response.body",
    ]
    assert sent[0]["status"] == 413
    assert b'"detail":"Request body is too large"' in sent[1]["body"]


def test_exact_limit_is_forwarded_without_buffering():
    messages_seen = []
    sent = []
    middleware = RequestBodyLimitMiddleware(
        app_that_reads_all(messages_seen),
        max_body_bytes=10,
        should_limit=is_claim_photo_upload,
    )

    run(
        middleware(
            scope(headers=[(b"content-length", b"10")]),
            receive_from(
                [
                    {"type": "http.request", "body": b"123", "more_body": True},
                    {"type": "http.request", "body": b"4567", "more_body": True},
                    {"type": "http.request", "body": b"890", "more_body": False},
                ],
                [],
            ),
            send_collector(sent),
        )
    )

    assert b"".join(message["body"] for message in messages_seen) == b"1234567890"
    assert sent[0]["status"] == 204


def test_non_matching_request_is_not_intercepted():
    called = []
    sent = []
    middleware = RequestBodyLimitMiddleware(
        app_that_reads_all(called),
        max_body_bytes=1,
        should_limit=is_claim_photo_upload,
    )
    messages = [{"type": "http.request", "body": b"not capped", "more_body": False}]

    run(
        middleware(
            scope(path="/api/places", method="POST"),
            receive_from(messages, []),
            send_collector(sent),
        )
    )

    assert called == messages
    assert sent[0]["status"] == 204


def test_claim_photo_middleware_uses_upload_specific_error_detail():
    sent = []
    middleware = ClaimPhotoBodyLimitMiddleware(
        app_that_reads_all([]),
        max_body_bytes=3,
    )

    run(
        middleware(
            scope(headers=[(b"content-length", b"4")]),
            receive_from([], []),
            send_collector(sent),
        )
    )

    assert sent[0]["status"] == 413
    assert CLAIM_PHOTO_BODY_TOO_LARGE_DETAIL.encode() in sent[1]["body"]


def test_over_limit_chunk_is_not_converted_to_fastapi_parser_400():
    app = FastAPI()
    endpoint_called = []

    @app.put("/api/visits/{place_id}/photo")
    async def upload(place_id: str, photo: UploadFile = File(...)):
        endpoint_called.append(True)
        return {"size": len(await photo.read())}

    app.add_middleware(
        RequestBodyLimitMiddleware,
        max_body_bytes=10,
        should_limit=is_claim_photo_upload,
    )
    sent = []

    run(
        app(
            scope(
                headers=[
                    (b"content-type", b"multipart/form-data; boundary=unused")
                ]
            ),
            receive_from(
                [{"type": "http.request", "body": b"x" * 11, "more_body": False}],
                [],
            ),
            send_collector(sent),
        )
    )

    assert endpoint_called == []
    assert sent[0]["status"] == 413
    assert b"There was an error parsing" not in sent[1]["body"]


def test_conflicting_content_lengths_are_rejected():
    sent = []
    middleware = RequestBodyLimitMiddleware(
        app_that_reads_all([]),
        max_body_bytes=10,
        should_limit=is_claim_photo_upload,
    )

    run(
        middleware(
            scope(headers=[(b"content-length", b"4"), (b"content-length", b"5")]),
            receive_from([], []),
            send_collector(sent),
        )
    )

    assert sent[0]["status"] == 400
    assert b"Invalid Content-Length" in sent[1]["body"]


def test_main_api_installs_claim_photo_body_limit():
    import backend.app.main as api

    assert any(
        middleware.cls is ClaimPhotoBodyLimitMiddleware
        for middleware in api.app.user_middleware
    )
