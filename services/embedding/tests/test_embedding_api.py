import asyncio
import logging
from math import isfinite, sqrt
from threading import Event, Lock
from time import sleep

import httpx
import pytest

from app.main import MAX_TOKEN_COUNT_BODY_BYTES, create_app
from app.model import (
    EMBEDDING_DIMENSION,
    MAX_TEXT_BYTES,
    MODEL_ID,
    MODEL_REVISION,
    EmbeddingModel,
    TokenizerCounter,
)


class DeterministicBackend:
    def token_count(self, text: str) -> int:
        return len(text.split())

    def encode(self, texts: list[str]) -> list[list[float]]:
        vectors: list[list[float]] = []
        for text in texts:
            vector = [0.0] * EMBEDDING_DIMENSION
            vector[sum(map(ord, text)) % EMBEDDING_DIMENSION] = 1.0
            vectors.append(vector)
        return vectors


class ColdStartBackend(DeterministicBackend):
    def __init__(self) -> None:
        self.active_encodes = 0
        self.max_active_encodes = 0
        self._lock = Lock()

    def encode(self, texts: list[str]) -> list[list[float]]:
        with self._lock:
            self.active_encodes += 1
            self.max_active_encodes = max(self.max_active_encodes, self.active_encodes)
        sleep(0.02)
        try:
            return super().encode(texts)
        finally:
            with self._lock:
                self.active_encodes -= 1


class DeterministicTokenizer:
    def encode(self, text: str, *, add_special_tokens: bool) -> list[int]:
        assert add_special_tokens is False
        return list(range(len(text.split())))


class BlockingTokenizer(DeterministicTokenizer):
    def __init__(self) -> None:
        self.started = Event()
        self.release = Event()
        self.finished = Event()

    def encode(self, text: str, *, add_special_tokens: bool) -> list[int]:
        self.started.set()
        self.release.wait(timeout=2)
        try:
            return super().encode(text, add_special_tokens=add_special_tokens)
        finally:
            self.finished.set()


class FailingTokenizer(DeterministicTokenizer):
    def encode(self, text: str, *, add_special_tokens: bool) -> list[int]:
        raise RuntimeError(f"tokenizer failed for secret text: {text}")


@pytest.mark.anyio
async def test_embed_returns_pinned_normalized_bilingual_vectors() -> None:
    app = create_app(EmbeddingModel(DeterministicBackend()))
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://embedding") as client:
        response = await client.post("/embed", json={"texts": ["English retrieval", "中文检索"]})

    assert response.status_code == 200
    assert response.json()["model"] == MODEL_ID
    assert response.json()["revision"] == MODEL_REVISION
    assert response.json()["dimension"] == EMBEDDING_DIMENSION
    vectors = response.json()["vectors"]
    assert len(vectors) == 2
    assert all(len(vector) == EMBEDDING_DIMENSION for vector in vectors)
    assert all(all(isfinite(value) for value in vector) for vector in vectors)
    assert all(sqrt(sum(value * value for value in vector)) == 1.0 for vector in vectors)


@pytest.mark.anyio
async def test_embed_rejects_batch_byte_and_token_limits_without_logging_body(caplog: pytest.LogCaptureFixture) -> None:
    app = create_app(EmbeddingModel(DeterministicBackend()))
    transport = httpx.ASGITransport(app=app)
    caplog.set_level(logging.INFO)
    async with httpx.AsyncClient(transport=transport, base_url="http://embedding") as client:
        batch = await client.post("/embed", json={"texts": ["x"] * 65})
        oversized = await client.post("/embed", json={"texts": ["secret-" * 2_000]})
        over_tokens = await client.post("/embed", json={"texts": ["word " * 513]})

    assert batch.status_code == 422
    assert oversized.status_code == 422
    assert over_tokens.status_code == 422
    assert "secret-" not in caplog.text


@pytest.mark.anyio
async def test_health_identifies_the_pinned_model_without_loading_it() -> None:
    app = create_app(EmbeddingModel(DeterministicBackend()))
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://embedding") as client:
        response = await client.get("/health")

    assert response.json() == {
        "status": "ok",
        "model": MODEL_ID,
        "revision": MODEL_REVISION,
        "dimension": EMBEDDING_DIMENSION,
    }


@pytest.mark.anyio
async def test_token_count_uses_the_pinned_backend_without_embedding() -> None:
    def fail_model_load() -> DeterministicBackend:
        raise AssertionError("token counting loaded the inference model")

    app = create_app(
        EmbeddingModel(backend_factory=fail_model_load),
        TokenizerCounter(DeterministicTokenizer()),
    )
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://embedding") as client:
        response = await client.post("/token-count", json={"text": "Latin 中文 whitespace"})

    assert response.json() == {
        "model": MODEL_ID,
        "revision": MODEL_REVISION,
        "token_count": 3,
    }


@pytest.mark.anyio
async def test_token_count_rejects_unbounded_or_open_bodies_without_logging_text(
    caplog: pytest.LogCaptureFixture,
) -> None:
    app = create_app(EmbeddingModel(DeterministicBackend()), TokenizerCounter(DeterministicTokenizer()))
    transport = httpx.ASGITransport(app=app)
    caplog.set_level(logging.INFO)
    secret = "private-tokenizer-text"
    async with httpx.AsyncClient(transport=transport, base_url="http://embedding") as client:
        responses = [
            await client.post("/token-count", json={"text": secret, "extra": True}),
            await client.post("/token-count", json={"text": [secret]}),
            await client.post("/token-count", content=b"{", headers={"content-type": "application/json"}),
            await client.post(
                "/token-count",
                content=b'{"text":"' + b"x" * (MAX_TEXT_BYTES + 1) + b'"}',
                headers={"content-type": "application/json"},
            ),
            await client.post(
                "/token-count",
                content=b" " * (MAX_TOKEN_COUNT_BODY_BYTES + 1),
                headers={"content-type": "application/json"},
            ),
            await client.post(
                "/token-count",
                content=b'{"text":"\xff"}',
                headers={"content-type": "application/json"},
            ),
        ]

    assert all(response.status_code == 422 for response in responses)
    assert all(response.json() == {"detail": "tokenizer request rejected"} for response in responses)
    assert secret not in caplog.text


@pytest.mark.anyio
async def test_tokenizer_failures_return_a_stable_error_without_logging_text(
    caplog: pytest.LogCaptureFixture,
) -> None:
    app = create_app(EmbeddingModel(DeterministicBackend()), TokenizerCounter(FailingTokenizer()))
    transport = httpx.ASGITransport(app=app)
    caplog.set_level(logging.INFO)
    async with httpx.AsyncClient(transport=transport, base_url="http://embedding") as client:
        response = await client.post("/token-count", json={"text": "private-tokenizer-text"})

    assert response.status_code == 503
    assert response.json() == {"detail": "tokenizer unavailable"}
    assert "private-tokenizer-text" not in caplog.text


@pytest.mark.anyio
async def test_tokenizer_lock_is_separate_from_inference() -> None:
    tokenizer = BlockingTokenizer()
    app = create_app(EmbeddingModel(DeterministicBackend()), TokenizerCounter(tokenizer))
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://embedding") as client:
        counting = asyncio.create_task(client.post("/token-count", json={"text": "blocked tokenizer"}))
        await asyncio.to_thread(tokenizer.started.wait, 1)
        embedded = await client.post("/embed", json={"texts": ["still available"]})
        tokenizer.release.set()
        counted = await counting

    assert embedded.status_code == counted.status_code == 200


@pytest.mark.anyio
async def test_cancelled_token_count_waits_for_its_finite_thread_owner() -> None:
    tokenizer = BlockingTokenizer()
    app = create_app(EmbeddingModel(DeterministicBackend()), TokenizerCounter(tokenizer))
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://embedding") as client:
        counting = asyncio.create_task(client.post("/token-count", json={"text": "cancelled tokenizer"}))
        await asyncio.to_thread(tokenizer.started.wait, 1)
        counting.cancel()
        await asyncio.sleep(0)
        assert not tokenizer.finished.is_set()
        assert not counting.done()
        tokenizer.release.set()
        with pytest.raises(asyncio.CancelledError):
            await counting

    assert tokenizer.finished.is_set()


@pytest.mark.anyio
async def test_concurrent_cold_requests_load_once_and_serialize_inference() -> None:
    backend = ColdStartBackend()
    factory_calls = 0

    def factory() -> ColdStartBackend:
        nonlocal factory_calls
        factory_calls += 1
        sleep(0.02)
        return backend

    app = create_app(EmbeddingModel(backend_factory=factory))
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://embedding") as client:
        first, second = await __import__("asyncio").gather(
            client.post("/embed", json={"texts": ["first"]}),
            client.post("/embed", json={"texts": ["second"]}),
        )

    assert first.status_code == second.status_code == 200
    assert factory_calls == 1
    assert backend.max_active_encodes == 1
