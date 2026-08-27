import logging
from math import nan

import anyio
import httpx
import pytest

from app.retrieval.embedding_client import EmbeddingClient, RetrievalUnavailableError


def _response(payload: object) -> httpx.MockTransport:
    return httpx.MockTransport(lambda request: httpx.Response(200, json=payload))


@pytest.mark.anyio
async def test_embedding_client_returns_only_valid_pinned_vectors() -> None:
    vector = [0.0] * 1_024
    vector[0] = 1.0
    async with httpx.AsyncClient(
        transport=_response(
            {
                "model": "BAAI/bge-m3",
                "revision": "5617a9f61b028005a4858fdac845db406aefb181",
                "dimension": 1024,
                "vectors": [vector],
            }
        ),
        base_url="http://embedding",
    ) as http_client:
        client = EmbeddingClient(http_client)

        assert await client.embed(["English and 中文"]) == [vector]


@pytest.mark.anyio
@pytest.mark.parametrize(
    "payload",
    [
        {"model": "other", "revision": "5617a9f61b028005a4858fdac845db406aefb181", "dimension": 1024, "vectors": [[0.0] * 1024]},
        {"model": "BAAI/bge-m3", "revision": "other", "dimension": 1024, "vectors": [[0.0] * 1024]},
        {"model": "BAAI/bge-m3", "revision": "5617a9f61b028005a4858fdac845db406aefb181", "dimension": 768, "vectors": [[0.0] * 1024]},
        {"model": "BAAI/bge-m3", "revision": "5617a9f61b028005a4858fdac845db406aefb181", "dimension": 1024, "vectors": [[0.0] * 1023]},
        {"model": "BAAI/bge-m3", "revision": "5617a9f61b028005a4858fdac845db406aefb181", "dimension": 1024, "vectors": [[nan] + [0.0] * 1023]},
        {"model": "BAAI/bge-m3", "revision": "5617a9f61b028005a4858fdac845db406aefb181", "dimension": 1024, "vectors": []},
    ],
)
async def test_embedding_client_fails_closed_on_protocol_drift_or_partial_response(payload: object) -> None:
    async with httpx.AsyncClient(transport=_response(payload), base_url="http://embedding") as http_client:
        client = EmbeddingClient(http_client)

        with pytest.raises(RetrievalUnavailableError, match="retrieval-unavailable"):
            await client.embed(["confidential text"])


@pytest.mark.anyio
async def test_embedding_client_translates_timeout_without_logging_text(caplog: pytest.LogCaptureFixture) -> None:
    def timeout(_request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("embedding timeout")

    caplog.set_level(logging.INFO)
    async with httpx.AsyncClient(transport=httpx.MockTransport(timeout), base_url="http://embedding") as http_client:
        client = EmbeddingClient(http_client)

        with pytest.raises(RetrievalUnavailableError, match="retrieval-unavailable"):
            await client.embed(["do not log this secret"])

    assert "do not log this secret" not in caplog.text


@pytest.mark.anyio
async def test_embedding_client_propagates_cancellation() -> None:
    cancelled = anyio.get_cancelled_exc_class()

    def disconnect(_request: httpx.Request) -> httpx.Response:
        raise cancelled()

    async with httpx.AsyncClient(transport=httpx.MockTransport(disconnect), base_url="http://embedding") as http_client:
        client = EmbeddingClient(http_client)

        with pytest.raises(cancelled):
            await client.embed(["cancelled request"])
