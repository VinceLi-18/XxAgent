"""Pinned CPU model adapter and embedding response validation."""

from collections.abc import Callable, Sequence
from math import isfinite, sqrt
from threading import Lock
from typing import Protocol

MODEL_ID = "BAAI/bge-m3"
MODEL_REVISION = "5617a9f61b028005a4858fdac845db406aefb181"
EMBEDDING_DIMENSION = 1024
MAX_TEXTS = 64
MAX_TEXT_BYTES = 8 * 1024
MAX_TOKENS = 512


class EmbeddingInputError(ValueError):
    """Raised when an embedding request exceeds a fixed resource limit."""


class EmbeddingProtocolError(RuntimeError):
    """Raised when the configured model does not produce the required vectors."""


class EmbeddingBackend(Protocol):
    """Model operations required to enforce input bounds and create dense vectors."""

    def token_count(self, text: str) -> int:
        """Return the BGE token count for text without adding special tokens."""

    def encode(self, texts: list[str]) -> list[list[float]]:
        """Return one dense vector for each input text."""


class TokenizerBackend(Protocol):
    """Tokenizer-only operation used by the internal token-count endpoint."""

    def encode(self, text: str, *, add_special_tokens: bool) -> Sequence[int]:
        """Return token identifiers for exact input text."""


class AutoTokenizerBackend:
    """Tokenizer-only BGE-M3 asset fixed to the reviewed Hugging Face commit."""

    def __init__(self) -> None:
        from transformers import AutoTokenizer

        self._tokenizer = AutoTokenizer.from_pretrained(
            MODEL_ID,
            revision=MODEL_REVISION,
            use_fast=True,
        )

    def encode(self, text: str, *, add_special_tokens: bool) -> Sequence[int]:
        """Return token identifiers without loading the inference model."""
        return self._tokenizer.encode(text, add_special_tokens=add_special_tokens)


class SentenceTransformerBackend:
    """CPU-only BGE-M3 backend fixed to the reviewed Hugging Face commit."""

    def __init__(self) -> None:
        from sentence_transformers import SentenceTransformer

        self._model = SentenceTransformer(
            MODEL_ID,
            revision=MODEL_REVISION,
            device="cpu",
        )

    def token_count(self, text: str) -> int:
        """Return the BGE tokenizer count for text without special tokens."""
        return len(self._model.tokenizer.encode(text, add_special_tokens=False))

    def encode(self, texts: list[str]) -> list[list[float]]:
        """Encode texts as normalized CPU vectors."""
        vectors = self._model.encode(texts, normalize_embeddings=True, convert_to_numpy=True)
        return vectors.tolist()


class EmbeddingModel:
    """Validate requests and normalize vectors from a pinned model backend."""

    def __init__(
        self,
        backend: EmbeddingBackend | None = None,
        backend_factory: Callable[[], EmbeddingBackend] = SentenceTransformerBackend,
    ) -> None:
        self._backend = backend
        self._backend_factory = backend_factory
        self._inference_lock = Lock()

    def embed(self, texts: list[str]) -> list[list[float]]:
        """Return fixed-size, finite unit vectors for bounded UTF-8 texts.

        @param texts Input texts whose size and BGE token count are checked before encoding.
        @returns One normalized 1024-dimensional vector per text.
        @raises EmbeddingInputError If a text exceeds the byte or token limit.
        @raises EmbeddingProtocolError If the backend returns an invalid vector.
        """
        for text in texts:
            if len(text.encode("utf-8")) > MAX_TEXT_BYTES:
                raise EmbeddingInputError("text exceeds the 8 KiB limit")
        with self._inference_lock:
            backend = self._backend_or_load()
            for text in texts:
                if backend.token_count(text) > MAX_TOKENS:
                    raise EmbeddingInputError("text exceeds the 512 token limit")
            vectors = backend.encode(texts)
            if len(vectors) != len(texts):
                raise EmbeddingProtocolError("backend returned an incomplete vector response")
            return [_normalize_vector(vector) for vector in vectors]

    def _backend_or_load(self) -> EmbeddingBackend:
        if self._backend is None:
            self._backend = self._backend_factory()
        return self._backend


class TokenizerCounter:
    """Serialize exact counts through a tokenizer-only lazy owner."""

    def __init__(
        self,
        backend: TokenizerBackend | None = None,
        backend_factory: Callable[[], TokenizerBackend] = AutoTokenizerBackend,
    ) -> None:
        self._backend = backend
        self._backend_factory = backend_factory
        self._tokenizer_lock = Lock()

    def count(self, text: str) -> int:
        """Return a bounded exact count without special tokens.

        @param text Query text whose UTF-8 size is bounded before tokenization.
        @returns The non-negative BGE-M3 token count.
        @raises EmbeddingInputError If text exceeds the fixed byte limit.
        @raises EmbeddingProtocolError If the tokenizer returns an invalid count.
        """
        if len(text.encode("utf-8")) > MAX_TEXT_BYTES:
            raise EmbeddingInputError("text exceeds the 8 KiB limit")
        try:
            with self._tokenizer_lock:
                count = len(self._backend_or_load().encode(text, add_special_tokens=False))
        except (EmbeddingInputError, EmbeddingProtocolError):
            raise
        except Exception as error:
            raise EmbeddingProtocolError("tokenizer unavailable") from error
        if isinstance(count, bool) or not isinstance(count, int) or count < 0:
            raise EmbeddingProtocolError("tokenizer returned an invalid count")
        return count

    def _backend_or_load(self) -> TokenizerBackend:
        if self._backend is None:
            self._backend = self._backend_factory()
        return self._backend


def _normalize_vector(vector: Sequence[float]) -> list[float]:
    if len(vector) != EMBEDDING_DIMENSION:
        raise EmbeddingProtocolError("backend returned an unexpected vector dimension")
    if any(not isinstance(value, (int, float)) or isinstance(value, bool) or not isfinite(value) for value in vector):
        raise EmbeddingProtocolError("backend returned a non-finite vector")
    norm = sqrt(sum(value * value for value in vector))
    if not isfinite(norm) or norm == 0:
        raise EmbeddingProtocolError("backend returned a zero vector")
    return [float(value / norm) for value in vector]
