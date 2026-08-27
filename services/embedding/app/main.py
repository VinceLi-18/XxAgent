"""HTTP interface for the internal CPU embedding service."""

from typing import Annotated

import anyio
from fastapi import FastAPI, HTTPException, Request
from pydantic import BaseModel, Field

from app.model import (
    EMBEDDING_DIMENSION,
    MAX_TEXTS,
    MODEL_ID,
    MODEL_REVISION,
    EmbeddingInputError,
    EmbeddingModel,
    EmbeddingProtocolError,
)


class EmbedRequest(BaseModel):
    """Bounded body accepted by the internal embedding endpoint."""

    texts: Annotated[list[str], Field(min_length=1, max_length=MAX_TEXTS)]


def create_app(model: EmbeddingModel | None = None) -> FastAPI:
    """Create an embedding API that uses model only after a request arrives.

    @param model Optional model adapter used by tests or the production application.
    @returns The internal FastAPI application.
    """
    embedding_model = model or EmbeddingModel()
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

    return app


app = create_app()
