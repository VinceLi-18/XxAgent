"""Strict UTF-8 text splitting for bounded retrieval embeddings."""

from dataclasses import dataclass
from typing import Protocol, Sequence

MAX_PAYLOAD_BYTES = 10 * 1024 * 1024
MAX_CHUNK_BYTES = 8 * 1024
MAX_CHUNK_TOKENS = 512
CHUNK_OVERLAP_TOKENS = 64
MAX_OVERLAP_BYTES = MAX_CHUNK_BYTES * CHUNK_OVERLAP_TOKENS // MAX_CHUNK_TOKENS
SUPPORTED_CONTENT_TYPES = frozenset({"text/plain", "text/markdown", "text/csv", "application/json"})


class Tokenizer(Protocol):
    """BGE tokenizer operations used to measure candidate chunks."""

    def encode(self, text: str, *, add_special_tokens: bool = False) -> Sequence[int]:
        """Return token IDs for text without special tokens."""


class RetrievalInputError(ValueError):
    """A stable indexing input failure that contains no artifact text."""


@dataclass(frozen=True)
class TextChunk:
    """A bounded retrieval text segment and its source coordinates."""

    ordinal: int
    text: str
    line_start: int
    line_end: int
    token_count: int


def chunk_text(payload: bytes, content_type: str, tokenizer: Tokenizer) -> list[TextChunk]:
    """Decode and split supported text into deterministic BGE-bounded chunks.

    @param payload Raw artifact bytes, limited to 10 MiB before decoding.
    @param content_type Declared MIME type of the scanned artifact.
    @param tokenizer BGE-compatible tokenizer used for the fixed token limits.
    @returns Ordered chunks with logical source line numbers.
    @raises RetrievalInputError If MIME, UTF-8, or payload size validation fails.
    """
    if len(payload) > MAX_PAYLOAD_BYTES:
        raise RetrievalInputError("index-too-large")
    normalized_content_type = content_type.split(";", 1)[0].strip().lower()
    if normalized_content_type not in SUPPORTED_CONTENT_TYPES:
        raise RetrievalInputError("unsupported-content")
    try:
        text = payload.decode("utf-8", errors="strict")
    except UnicodeDecodeError as error:
        raise RetrievalInputError("invalid-utf8") from error
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    if not text.strip():
        return []

    chunks: list[TextChunk] = []
    start = _skip_leading_whitespace(text, 0)
    previous_end = 0
    while start < len(text):
        end = _select_end(text, start, tokenizer)
        if end <= previous_end:
            start = _advance_overlap_start(text, start, previous_end, tokenizer)
            end = _select_end(text, start, tokenizer)
        segment = text[start:end]
        token_count = _token_count(tokenizer, segment)
        chunks.append(
            TextChunk(
                ordinal=len(chunks),
                text=segment,
                line_start=_line_number(text, start),
                line_end=_line_number(text, max(start, end - 1)),
                token_count=token_count,
            )
        )
        if end == len(text):
            break
        previous_end = end
        start = _overlap_start(text, start, end, tokenizer)
    return chunks


def _select_end(text: str, start: int, tokenizer: Tokenizer) -> int:
    end = _largest_fitting(text, start, _paragraph_boundaries(text, start), tokenizer)
    if end is not None:
        return end
    end = _largest_fitting(text, start, _line_boundaries(text, start), tokenizer)
    if end is not None:
        return end
    return _largest_character_boundary(text, start, tokenizer)


def _paragraph_boundaries(text: str, start: int) -> list[int]:
    return [
        index
        for index in range(start, len(text))
        if text[index] == "\n" and index + 1 < len(text) and text[index + 1] == "\n"
    ] + [len(text)]


def _line_boundaries(text: str, start: int) -> list[int]:
    return [index for index in range(start, len(text)) if text[index] == "\n"] + [len(text)]


def _largest_fitting(text: str, start: int, candidates: list[int], tokenizer: Tokenizer) -> int | None:
    fitting = [end for end in candidates if end > start and _fits(text[start:end], tokenizer)]
    return max(fitting, default=None)


def _largest_character_boundary(text: str, start: int, tokenizer: Tokenizer) -> int:
    low = start + 1
    high = len(text)
    best = start
    while low <= high:
        middle = (low + high) // 2
        if _fits(text[start:middle], tokenizer):
            best = middle
            low = middle + 1
        else:
            high = middle - 1
    if best == start:
        raise RetrievalInputError("retrieval-unavailable")
    return best


def _fits(text: str, tokenizer: Tokenizer) -> bool:
    return len(text.encode("utf-8")) <= MAX_CHUNK_BYTES and _token_count(tokenizer, text) <= MAX_CHUNK_TOKENS


def _token_count(tokenizer: Tokenizer, text: str) -> int:
    return len(tokenizer.encode(text, add_special_tokens=False))


def _skip_leading_whitespace(text: str, start: int) -> int:
    while start < len(text) and text[start].isspace():
        start += 1
    return start


def _line_number(text: str, position: int) -> int:
    return text.count("\n", 0, position) + 1


def _overlap_start(text: str, start: int, end: int, tokenizer: Tokenizer) -> int:
    word_boundaries = [start] + [index + 1 for index in range(start, end) if text[index].isspace()]
    fitting = [
        position
        for position in word_boundaries
        if _fits_overlap(text[position:end], tokenizer)
    ]
    if fitting:
        return min(fitting)
    character_fitting = [
        position
        for position in range(start + 1, end)
        if _fits_overlap(text[position:end], tokenizer)
    ]
    return min(character_fitting, default=end)


def _fits_overlap(text: str, tokenizer: Tokenizer) -> bool:
    return len(text.encode("utf-8")) <= MAX_OVERLAP_BYTES and _token_count(tokenizer, text) <= CHUNK_OVERLAP_TOKENS


def _advance_overlap_start(text: str, start: int, previous_end: int, tokenizer: Tokenizer) -> int:
    candidate = start
    while candidate < previous_end:
        candidate = _skip_leading_whitespace(text, candidate + 1)
        if _select_end(text, candidate, tokenizer) > previous_end:
            return candidate
    return previous_end
