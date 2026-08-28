import asyncio
import json
import logging

import httpx
import pytest
from httpx import ASGITransport, AsyncClient

from app.api.routes.internal_tokenizer import MAX_TOKEN_COUNT_BODY_BYTES, get_tokenizer_http_client
from app.main import app
from app.retrieval.embedding_client import MODEL_ID, MODEL_REVISION


SERVICE_TOKEN = "xagent-test-service-token-00000001"
PATH = "/internal/xagent/retrieval/token-count"


def _embedding_transport(*, payload: object | None = None, status: int = 200) -> httpx.MockTransport:
    value = payload or {"model": MODEL_ID, "revision": MODEL_REVISION, "token_count": 17}
    return httpx.MockTransport(lambda request: httpx.Response(status, json=value))


@pytest.mark.anyio
async def test_tokenizer_relay_requires_only_exact_service_identity_and_forwards_to_embedding() -> None:
    requests: list[httpx.Request] = []

    def embedding(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(
            200,
            json={"model": MODEL_ID, "revision": MODEL_REVISION, "token_count": 17},
        )

    async with httpx.AsyncClient(
        transport=httpx.MockTransport(embedding), base_url="http://embedding.internal"
    ) as embedding_client:
        app.dependency_overrides[get_tokenizer_http_client] = lambda: embedding_client
        try:
            transport = ASGITransport(app=app)
            async with AsyncClient(transport=transport, base_url="http://api") as client:
                missing = await client.post(PATH, json={"text": "private query"})
                wrong = await client.post(
                    PATH,
                    json={"text": "private query"},
                    headers={"X-XAgent-Service-Token": "wrong"},
                )
                allowed = await client.post(
                    PATH,
                    json={"text": "private query"},
                    headers={"X-XAgent-Service-Token": SERVICE_TOKEN},
                )
        finally:
            app.dependency_overrides.clear()

    assert missing.status_code == wrong.status_code == 403
    assert allowed.status_code == 200
    assert allowed.json() == {"model": MODEL_ID, "revision": MODEL_REVISION, "token_count": 17}
    assert len(requests) == 1
    assert requests[0].url == "http://embedding.internal/token-count"
    assert requests[0].content == b'{"text":"private query"}'
    assert "authorization" not in requests[0].headers
    assert "x-xagent-service-token" not in requests[0].headers


@pytest.mark.anyio
async def test_tokenizer_relay_accepts_all_legal_raw_boundaries_and_rejects_malformed_scalars() -> None:
    async with httpx.AsyncClient(
        transport=_embedding_transport(), base_url="http://embedding.internal"
    ) as embedding_client:
        app.dependency_overrides[get_tokenizer_http_client] = lambda: embedding_client
        try:
            transport = ASGITransport(app=app, raise_app_exceptions=False)
            async with AsyncClient(transport=transport, base_url="http://api") as client:
                headers = {"X-XAgent-Service-Token": SERVICE_TOKEN, "content-type": "application/json"}
                legal = [
                    '"' * 8192,
                    "\\" * 8192,
                    "\u0000" * 8192,
                    "😀" * 2048,
                ]
                encoded = [
                    json.dumps({"text": value}, ensure_ascii=False, separators=(",", ":")).encode()
                    for value in legal
                ]
                assert max(map(len, encoded)) == MAX_TOKEN_COUNT_BODY_BYTES
                accepted = [
                    await client.post(
                        PATH,
                        content=body,
                        headers=headers,
                    )
                    for body in encoded
                ]
                malformed = [
                    await client.post(PATH, content=body, headers=headers)
                    for body in (b'{"text":"\\ud800"}', b'{"text":"\\udc00"}')
                ]
                over = await client.post(
                    PATH,
                    content=b'{"text":"' + b"x" * 8193 + b'"}',
                    headers=headers,
                )
                oversized_body = await client.post(
                    PATH,
                    content=b" " * (MAX_TOKEN_COUNT_BODY_BYTES + 1),
                    headers=headers,
                )
        finally:
            app.dependency_overrides.clear()

    assert all(response.status_code == 200 for response in accepted)
    assert all(response.status_code == 422 for response in malformed)
    assert over.status_code == oversized_body.status_code == 422


@pytest.mark.anyio
async def test_tokenizer_relay_closes_upstream_failures_without_query_logs(
    caplog: pytest.LogCaptureFixture,
) -> None:
    secret = "raw-private-query-never-log"
    caplog.set_level(logging.INFO)
    cases = [
        _embedding_transport(status=503),
        httpx.MockTransport(lambda request: httpx.Response(302, headers={"location": "http://elsewhere"})),
        httpx.MockTransport(lambda request: httpx.Response(
            200, content=b"x" * 513, headers={"content-type": "application/json"}
        )),
        httpx.MockTransport(lambda request: httpx.Response(
            200, content=b"{", headers={"content-type": "application/json"}
        )),
        httpx.MockTransport(lambda request: (_ for _ in ()).throw(httpx.ReadTimeout("secret timeout"))),
    ]
    for case in cases:
        async with httpx.AsyncClient(transport=case, base_url="http://embedding.internal") as embedding_client:
            app.dependency_overrides[get_tokenizer_http_client] = lambda: embedding_client
            try:
                transport = ASGITransport(app=app, raise_app_exceptions=False)
                async with AsyncClient(transport=transport, base_url="http://api") as client:
                    response = await client.post(
                        PATH,
                        json={"text": secret},
                        headers={"X-XAgent-Service-Token": SERVICE_TOKEN},
                    )
            finally:
                app.dependency_overrides.clear()
        assert response.status_code == 503
        assert response.json() == {"detail": {"code": "service-unavailable"}}
    assert secret not in caplog.text


@pytest.mark.anyio
async def test_tokenizer_relay_propagates_cancellation() -> None:
    started = asyncio.Event()

    async def blocked(_request: httpx.Request) -> httpx.Response:
        started.set()
        await asyncio.Future()

    async with httpx.AsyncClient(
        transport=httpx.MockTransport(blocked), base_url="http://embedding.internal"
    ) as embedding_client:
        app.dependency_overrides[get_tokenizer_http_client] = lambda: embedding_client
        try:
            transport = ASGITransport(app=app)
            async with AsyncClient(transport=transport, base_url="http://api") as client:
                operation = asyncio.create_task(client.post(
                    PATH,
                    json={"text": "cancelled private query"},
                    headers={"X-XAgent-Service-Token": SERVICE_TOKEN},
                ))
                await started.wait()
                operation.cancel()
                with pytest.raises(asyncio.CancelledError):
                    await operation
        finally:
            app.dependency_overrides.clear()
