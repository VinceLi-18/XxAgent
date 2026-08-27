"""Fail-closed client for the internal BGE-M3 embedding service."""

from math import isfinite
from typing import Any

import httpx
from pydantic import BaseModel, ConfigDict, StrictFloat, StrictInt, StrictStr

MODEL_ID = "BAAI/bge-m3"
MODEL_REVISION = "5617a9f61b028005a4858fdac845db406aefb181"
EMBEDDING_DIMENSION = 1024


class _EmbeddingResponse(BaseModel):
    """Strict JSON fields accepted from the internal embedding service."""

    model_config = ConfigDict(extra="forbid", strict=True)

    model: StrictStr
    revision: StrictStr
    dimension: StrictInt
    vectors: list[list[StrictFloat]]


class RetrievalUnavailableError(RuntimeError):
    """Embedding cannot safely produce vectors for the current retrieval operation."""

    code = "retrieval-unavailable"

    def __init__(self) -> None:
        super().__init__(self.code)


class EmbeddingClient:
    """Validate every embedding-service response before returning vectors."""

    def __init__(self, http_client: httpx.AsyncClient) -> None:
        self._http_client = http_client

    async def embed(self, texts: list[str]) -> list[list[float]]:
        """Embed texts or fail closed when the internal protocol is unavailable.

        @param texts Bounded text batch supplied by an index or retrieval operation.
        @returns A finite 1024-dimensional vector for each input text.
        @raises RetrievalUnavailableError If the request, response, model, or vectors are invalid.
        """
        try:
            response = await self._http_client.post("/embed", json={"texts": texts})
            response.raise_for_status()
            payload = response.json()
            return _validated_vectors(payload, len(texts))
        except (httpx.HTTPError, OverflowError, ValueError, TypeError, KeyError):
            raise RetrievalUnavailableError() from None


def _validated_vectors(payload: Any, expected_count: int) -> list[list[float]]:
    response = _EmbeddingResponse.model_validate(payload)
    if (
        response.model != MODEL_ID
        or response.revision != MODEL_REVISION
        or response.dimension != EMBEDDING_DIMENSION
    ):
        raise ValueError("embedding model metadata differs")
    if len(response.vectors) != expected_count:
        raise ValueError("embedding vector count differs")
    vectors = [[float(value) for value in vector] for vector in response.vectors]
    if any(len(vector) != EMBEDDING_DIMENSION or any(not isfinite(value) for value in vector) for vector in vectors):
        raise ValueError("embedding vector is invalid")
    return vectors
