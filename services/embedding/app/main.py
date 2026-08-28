"""HTTP interface for the internal CPU embedding service."""

import asyncio
import json
from typing import Annotated

import anyio
from fastapi import FastAPI, HTTPException, Request
from pydantic import BaseModel, Field

from app.model import (
    EMBEDDING_DIMENSION,
    MAX_TEXTS,
    MAX_TEXT_BYTES,
    MODEL_ID,
    MODEL_REVISION,
    EmbeddingInputError,
    EmbeddingModel,
    EmbeddingProtocolError,
    TokenizerCounter,
)


class EmbedRequest(BaseModel):
    """Bounded body accepted by the internal embedding endpoint."""

    texts: Annotated[list[str], Field(min_length=1, max_length=MAX_TEXTS)]


MAX_TOKEN_COUNT_BODY_BYTES = MAX_TEXT_BYTES + 64


async def _token_count_text(request: Request) -> str:
    """Read one closed JSON field under fixed transport and text byte limits."""
    if request.headers.get("content-type") != "application/json":
        raise HTTPException(status_code=422, detail="tokenizer request rejected")
    body = bytearray()
    try:
        async for chunk in request.stream():
            if len(body) + len(chunk) > MAX_TOKEN_COUNT_BODY_BYTES:
                raise HTTPException(status_code=422, detail="tokenizer request rejected")
            body.extend(chunk)
    except HTTPException:
        raise
    except Exception as error:
        raise HTTPException(status_code=422, detail="tokenizer request rejected") from error
    try:
        payload = json.loads(body.decode("utf-8", errors="strict"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise HTTPException(status_code=422, detail="tokenizer request rejected") from error
    if not isinstance(payload, dict) or set(payload) != {"text"} or not isinstance(payload["text"], str):
        raise HTTPException(status_code=422, detail="tokenizer request rejected")
    text = payload["text"]
    if len(text.encode("utf-8")) > MAX_TEXT_BYTES:
        raise HTTPException(status_code=422, detail="tokenizer request rejected")
    return text


async def _run_token_count(counter: TokenizerCounter, text: str) -> int:
    """Keep ownership of the finite tokenizer thread through caller cancellation."""
    owner = asyncio.create_task(anyio.to_thread.run_sync(counter.count, text, abandon_on_cancel=False))
    try:
        return await asyncio.shield(owner)
    except asyncio.CancelledError:
        await owner
        raise


def create_app(model: EmbeddingModel | None = None, tokenizer: TokenizerCounter | None = None) -> FastAPI:
    """Create an embedding API that uses model only after a request arrives.

    @param model Optional model adapter used by tests or the production application.
    @param tokenizer Optional tokenizer-only counter used by tests or production.
    @returns The internal FastAPI application.
    """
    embedding_model = model or EmbeddingModel()
    tokenizer_counter = tokenizer or TokenizerCounter()
    app = FastAPI(title="XAgent Embedding", docs_url=None, redoc_url=None, openapi_url=None)

    @app.get("/health")
    async def health() -> dict[str, str | int]:
        """Identify the exact model served without loading it."""
        return {
            "status": "ok",
            "model": MODEL_ID,
            "revision": MODEL_REVISION,
            "dimension": EMBEDDING_DIMENSION,
        }

    @app.post("/embed")
    async def embed(payload: EmbedRequest, request: Request) -> dict[str, str | int | list[list[float]]]:
        """Encode a bounded batch without including request text in diagnostics."""
        if await request.is_disconnected():
            raise HTTPException(status_code=499, detail="request disconnected")
        try:
            vectors = await anyio.to_thread.run_sync(embedding_model.embed, payload.texts, abandon_on_cancel=True)
        except EmbeddingInputError as error:
            raise HTTPException(status_code=422, detail="embedding request exceeds a fixed limit") from error
        except EmbeddingProtocolError as error:
            raise HTTPException(status_code=503, detail="embedding unavailable") from error
        if await request.is_disconnected():
            raise HTTPException(status_code=499, detail="request disconnected")
        return {
            "model": MODEL_ID,
            "revision": MODEL_REVISION,
            "dimension": EMBEDDING_DIMENSION,
            "vectors": vectors,
        }

    @app.post("/token-count")
    async def token_count(request: Request) -> dict[str, str | int]:
        """Count exact BGE-M3 query tokens without exposing request text."""
        text = await _token_count_text(request)
        if await request.is_disconnected():
            raise HTTPException(status_code=499, detail="request disconnected")
        try:
            count = await _run_token_count(tokenizer_counter, text)
        except EmbeddingInputError as error:
            raise HTTPException(status_code=422, detail="tokenizer request rejected") from error
        except EmbeddingProtocolError as error:
            raise HTTPException(status_code=503, detail="tokenizer unavailable") from error
        if await request.is_disconnected():
            raise HTTPException(status_code=499, detail="request disconnected")
        return {"model": MODEL_ID, "revision": MODEL_REVISION, "token_count": count}

    return app


app = create_app()
