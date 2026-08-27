"""Strict UTF-8 text splitting for bounded retrieval embeddings."""

from bisect import bisect_left, bisect_right
from dataclasses import dataclass
from typing import Protocol, Sequence

MAX_PAYLOAD_BYTES = 10 * 1024 * 1024
MAX_CHUNK_BYTES = 8 * 1024
MAX_CHUNK_TOKENS = 512
CHUNK_OVERLAP_TOKENS = 64
SUPPORTED_CONTENT_TYPES = frozenset({"text/plain", "text/markdown", "text/csv", "application/json"})


class Tokenizer(Protocol):
    """BGE tokenizer operation used to index bounded source spans."""

    def encode_with_offsets(self, text: str) -> Sequence[tuple[int, int]]:
        """Return sorted exclusive character offsets for BGE tokens in text."""


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


@dataclass(frozen=True)
class _TokenSpan:
    start: int
    end: int


def chunk_text(payload: bytes, content_type: str, tokenizer: Tokenizer) -> list[TextChunk]:
    """Decode and split supported text into deterministic BGE-bounded chunks.

    @param payload Raw artifact bytes, limited to 10 MiB before decoding.
    @param content_type Declared MIME type of the scanned artifact.
    @param tokenizer BGE-compatible tokenizer that exposes token character offsets.
    @returns Ordered chunks with logical source line numbers.
    @raises RetrievalInputError If MIME, UTF-8, payload size, or token offsets are invalid.
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

    spans = _token_spans(text, tokenizer)
    if not spans:
        raise RetrievalInputError("retrieval-unavailable")
    newline_positions = tuple(index for index, character in enumerate(text) if character == "\n")
    token_ends = tuple(span.end for span in spans)
    chunks: list[TextChunk] = []
    start_token = 0
    minimum_end: int | None = None
    while start_token < len(spans):
        start = spans[start_token].start
        end, end_token = _chunk_end(text, spans, token_ends, start_token, minimum_end=minimum_end)
        chunks.append(
            TextChunk(
                ordinal=len(chunks),
                text=text[start:end],
                line_start=_line_number(newline_positions, start),
                line_end=_line_number(newline_positions, max(start, end - 1)),
                token_count=end_token - start_token,
            )
        )
        if end_token == len(spans):
            break
        start_token = _next_start_token(text, spans, token_ends, start_token, end, end_token)
        minimum_end = end
    return chunks


def _token_spans(text: str, tokenizer: Tokenizer) -> tuple[_TokenSpan, ...]:
    spans: list[_TokenSpan] = []
    previous_end = 0
    for start, end in tokenizer.encode_with_offsets(text):
        if isinstance(start, bool) or isinstance(end, bool) or not isinstance(start, int) or not isinstance(end, int):
            raise RetrievalInputError("retrieval-unavailable")
        if start < previous_end or end <= start or end > len(text):
            raise RetrievalInputError("retrieval-unavailable")
        spans.extend(_bounded_spans(text, start, end))
        previous_end = end
    return tuple(spans)


def _bounded_spans(text: str, start: int, end: int) -> list[_TokenSpan]:
    if len(text[start:end].encode("utf-8")) <= MAX_CHUNK_BYTES:
        return [_TokenSpan(start, end)]
    spans: list[_TokenSpan] = []
    position = start
    while position < end:
        bounded_end = _byte_end(text, position)
        spans.append(_TokenSpan(position, min(end, bounded_end)))
        position = bounded_end
    return spans


def _chunk_end(
    text: str,
    spans: tuple[_TokenSpan, ...],
    token_ends: tuple[int, ...],
    start_token: int,
    minimum_end: int | None = None,
) -> tuple[int, int]:
    maximum_token = min(start_token + MAX_CHUNK_TOKENS, len(spans))
    token_end = spans[maximum_token - 1].end
    byte_end = _byte_end(text, spans[start_token].start)
    upper_end = min(token_end, byte_end)
    end_token = bisect_right(token_ends, upper_end, lo=start_token, hi=maximum_token)
    if end_token == start_token:
        raise RetrievalInputError("retrieval-unavailable")
    if end_token == len(spans) and upper_end == len(text):
        return len(text), end_token
    preferred_end = _preferred_boundary(text, spans[start_token].start, upper_end)
    if preferred_end is not None and (minimum_end is None or preferred_end > minimum_end):
        preferred_tokens = bisect_right(token_ends, preferred_end, lo=start_token, hi=end_token)
        if preferred_tokens > start_token:
            return preferred_end, preferred_tokens
    return spans[end_token - 1].end, end_token


def _byte_end(text: str, start: int) -> int:
    total = 0
    for index in range(start, len(text)):
        total += len(text[index].encode("utf-8"))
        if total > MAX_CHUNK_BYTES:
            return index
    return len(text)


def _preferred_boundary(text: str, start: int, upper_end: int) -> int | None:
    if upper_end <= start:
        return None
    paragraph = text.rfind("\n\n", start, upper_end)
    if paragraph > start:
        return paragraph
    line = text.rfind("\n", start, upper_end)
    if line > start:
        return line
    return None


def _next_start_token(
    text: str,
    spans: tuple[_TokenSpan, ...],
    token_ends: tuple[int, ...],
    start_token: int,
    previous_end: int,
    end_token: int,
) -> int:
    candidate = max(start_token, end_token - CHUNK_OVERLAP_TOKENS)
    while candidate < end_token:
        next_end, _ = _chunk_end(text, spans, token_ends, candidate, minimum_end=previous_end)
        if next_end > previous_end:
            return candidate
        candidate += 1
    return end_token


def _line_number(newline_positions: tuple[int, ...], position: int) -> int:
    return bisect_left(newline_positions, position) + 1
