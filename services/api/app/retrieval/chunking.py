"""Strict UTF-8 text splitting for bounded retrieval embeddings."""

from bisect import bisect_left, bisect_right
from collections.abc import Callable
from dataclasses import dataclass
from typing import Protocol, Sequence

MAX_PAYLOAD_BYTES = 10 * 1024 * 1024
MAX_CHUNK_BYTES = 8 * 1024
MAX_CHUNK_TOKENS = 512
CHUNK_OVERLAP_TOKENS = 64
SUPPORTED_CONTENT_TYPES = frozenset({"text/plain", "text/markdown", "text/csv", "application/json"})


class Tokenizer(Protocol):
    """BGE tokenizer operation used to index bounded source spans."""

    def count_tokens(self, text: str) -> int:
        """Return the authoritative token count for an independently encoded string."""

    def encode_with_offsets(self, text: str) -> Sequence[tuple[int, int]]:
        """Return monotonic exclusive character offsets, which may overlap."""

    def normalize(self, text: str) -> str:
        """Return the tokenizer-normalized text used to validate uncovered input."""


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

    token_counts: dict[str, int] = {}

    def count_tokens(value: str) -> int:
        count = token_counts.get(value)
        if count is None:
            count = tokenizer.count_tokens(value)
            token_counts[value] = count
        return count

    spans = _token_spans(text, tokenizer)
    if not spans:
        raise RetrievalInputError("retrieval-unavailable")
    newline_positions = tuple(index for index, character in enumerate(text) if character == "\n")
    token_ends = tuple(span.end for span in spans)
    chunks: list[TextChunk] = []
    start_token = 0
    minimum_end: int | None = None
    minimum_token: int | None = None
    while start_token < len(spans):
        start = _chunk_start(spans, start_token)
        end, end_token, token_count = _chunk_end(
            text,
            spans,
            token_ends,
            start_token,
            count_tokens,
            minimum_end=minimum_end,
            minimum_token=minimum_token,
        )
        chunks.append(
            TextChunk(
                ordinal=len(chunks),
                text=text[start:end],
                line_start=_line_number(newline_positions, start),
                line_end=_line_number(newline_positions, max(start, end - 1)),
                token_count=token_count,
            )
        )
        if end_token == len(spans):
            break
        start_token = _next_start_token(
            text,
            spans,
            token_ends,
            start_token,
            end,
            end_token,
            count_tokens,
        )
        minimum_end = end
        minimum_token = end_token
    return chunks


def _token_spans(
    text: str,
    tokenizer: Tokenizer,
) -> tuple[_TokenSpan, ...]:
    spans: list[_TokenSpan] = []
    normalization_gaps: dict[str, bool] = {}
    previous_start = -1
    previous_end = 0

    def is_normalization_gap(value: str) -> bool:
        allowed = normalization_gaps.get(value)
        if allowed is None:
            allowed = not tokenizer.normalize(value).strip()
            normalization_gaps[value] = allowed
        return allowed

    for start, end in tokenizer.encode_with_offsets(text):
        if (
            isinstance(start, bool)
            or isinstance(end, bool)
            or not isinstance(start, int)
            or not isinstance(end, int)
        ):
            raise RetrievalInputError("retrieval-unavailable")
        if (
            start < previous_start
            or end < previous_end
            or start < 0
            or end <= start
            or end > len(text)
        ):
            raise RetrievalInputError("retrieval-unavailable")
        if start > previous_end and not is_normalization_gap(text[previous_end:start]):
            raise RetrievalInputError("retrieval-unavailable")
        spans.extend(_bounded_spans(text, start, end))
        previous_start = start
        previous_end = end
    if previous_end < len(text) and not is_normalization_gap(text[previous_end:]):
        raise RetrievalInputError("retrieval-unavailable")
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
    count_tokens: Callable[[str], int],
    minimum_end: int | None = None,
    minimum_token: int | None = None,
) -> tuple[int, int, int]:
    start = _chunk_start(spans, start_token)
    maximum_token = min(start_token + MAX_CHUNK_TOKENS, len(spans))
    token_end = spans[maximum_token - 1].end
    byte_end = _byte_end(text, start)
    upper_end = min(token_end, byte_end)
    end_token = bisect_right(token_ends, upper_end, lo=start_token, hi=maximum_token)
    end_token = _aligned_end_token(spans, start_token, end_token)
    if end_token <= start_token:
        raise RetrievalInputError("retrieval-unavailable")
    if end_token == len(spans) and byte_end == len(text):
        return _fit_chunk_end(
            text,
            spans,
            start_token,
            start,
            len(text),
            end_token,
            count_tokens,
        )
    preferred_end = _preferred_boundary(text, start, upper_end)
    if preferred_end is not None and (minimum_end is None or preferred_end > minimum_end):
        preferred_tokens = bisect_right(token_ends, preferred_end, lo=start_token, hi=end_token)
        preferred_tokens = _aligned_end_token(spans, start_token, preferred_tokens)
        if preferred_tokens > start_token and (
            minimum_token is None or preferred_tokens > minimum_token
        ):
            return _fit_chunk_end(
                text,
                spans,
                start_token,
                start,
                preferred_end,
                preferred_tokens,
                count_tokens,
            )
    return _fit_chunk_end(
        text,
        spans,
        start_token,
        start,
        spans[end_token - 1].end,
        end_token,
        count_tokens,
    )


def _chunk_start(spans: tuple[_TokenSpan, ...], start_token: int) -> int:
    if start_token == 0:
        return 0
    return spans[start_token - 1].end


def _aligned_end_token(
    spans: tuple[_TokenSpan, ...],
    start_token: int,
    end_token: int,
) -> int:
    while (
        end_token > start_token
        and end_token < len(spans)
        and spans[end_token].start < spans[end_token - 1].end
    ):
        end_token -= 1
    return end_token


def _fit_chunk_end(
    text: str,
    spans: tuple[_TokenSpan, ...],
    start_token: int,
    start: int,
    end: int,
    end_token: int,
    count_tokens: Callable[[str], int],
) -> tuple[int, int, int]:
    first_attempt = True
    while end_token > start_token:
        token_count = count_tokens(text[start:end])
        if 0 < token_count <= MAX_CHUNK_TOKENS:
            return end, end_token, token_count
        if token_count <= 0:
            raise RetrievalInputError("retrieval-unavailable")
        available = end_token - start_token
        next_available = max(1, available * MAX_CHUNK_TOKENS // token_count)
        if not first_attempt:
            next_available = min(next_available, max(1, available // 2))
        next_end_token = _aligned_end_token(
            spans,
            start_token,
            start_token + next_available,
        )
        if next_end_token >= end_token:
            raise RetrievalInputError("retrieval-unavailable")
        end_token = next_end_token
        if end_token > start_token:
            end = spans[end_token - 1].end
        first_attempt = False
    raise RetrievalInputError("retrieval-unavailable")


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
    count_tokens: Callable[[str], int],
) -> int:
    candidate = max(start_token, end_token - CHUNK_OVERLAP_TOKENS)
    candidate = _aligned_start_token(spans, candidate)
    while candidate < end_token:
        next_end, _, _ = _chunk_end(
            text,
            spans,
            token_ends,
            candidate,
            count_tokens,
            minimum_end=previous_end,
            minimum_token=end_token,
        )
        if next_end > previous_end:
            return candidate
        requested = candidate + 1
        candidate = _aligned_start_token(spans, requested)
        if candidate < requested:
            candidate = requested
            while (
                candidate < len(spans)
                and spans[candidate].start < spans[candidate - 1].end
            ):
                candidate += 1
    return end_token


def _aligned_start_token(spans: tuple[_TokenSpan, ...], start_token: int) -> int:
    while start_token > 0 and spans[start_token].start < spans[start_token - 1].end:
        start_token -= 1
    return start_token


def _line_number(newline_positions: tuple[int, ...], position: int) -> int:
    return bisect_left(newline_positions, position) + 1
