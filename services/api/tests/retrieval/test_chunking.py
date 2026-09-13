import re

import pytest

from app.retrieval.chunking import RetrievalInputError, chunk_text


class WhitespaceTokenizer:
    def __init__(self) -> None:
        self.encode_calls = 0
        self.normalize_calls = 0
        self.offset_calls = 0

    def count_tokens(self, text: str) -> int:
        self.encode_calls += 1
        return len(re.findall(r"\w+|[^\w\s]", text, flags=re.UNICODE))

    def encode_with_offsets(self, text: str) -> list[tuple[int, int]]:
        self.offset_calls += 1
        return [
            (match.start(), match.end())
            for match in re.finditer(r"\w+|[^\w\s]", text, flags=re.UNICODE)
        ]

    def normalize(self, text: str) -> str:
        self.normalize_calls += 1
        return text


TOKENIZER = WhitespaceTokenizer()


class OverlappingTokenizer:
    def count_tokens(self, text: str) -> int:
        assert text == "客户交付条款"
        return 4

    def encode_with_offsets(self, text: str) -> list[tuple[int, int]]:
        assert text == "客户交付条款"
        return [(0, 1), (0, 2), (2, 4), (4, 6)]

    def normalize(self, text: str) -> str:
        return text


class FixedOffsetTokenizer:
    def __init__(
        self,
        offsets: list[tuple[int, int]],
        *,
        normalizations: dict[str, str] | None = None,
    ) -> None:
        self.offsets = offsets
        self.normalizations = normalizations or {}

    def count_tokens(self, text: str) -> int:
        return len(text)

    def encode_with_offsets(self, text: str) -> list[tuple[int, int]]:
        return self.offsets

    def normalize(self, text: str) -> str:
        return self.normalizations.get(text, text)


class BoundaryExpandingTokenizer:
    def count_tokens(self, text: str) -> int:
        return len(text) + (0 if text.startswith("A") else 1)

    def encode_with_offsets(self, text: str) -> list[tuple[int, int]]:
        return [(index, index + 1) for index in range(len(text))]

    def normalize(self, text: str) -> str:
        return text


class MultiplyingTokenizer(BoundaryExpandingTokenizer):
    def count_tokens(self, text: str) -> int:
        return len(text) * 2


def test_chunk_text_normalizes_crlf_without_changing_logical_line_numbers() -> None:
    chunks = chunk_text(b"first line\r\nsecond line\r\n\r\nthird line", "text/plain", TOKENIZER)

    assert [(chunk.ordinal, chunk.text, chunk.line_start, chunk.line_end, chunk.token_count) for chunk in chunks] == [
        (0, "first line\nsecond line\n\nthird line", 1, 4, 6)
    ]


def test_chunk_text_returns_no_chunks_for_blank_content() -> None:
    assert chunk_text(b" \r\n\t", "text/plain", TOKENIZER) == []


def test_chunk_text_accepts_monotonic_overlapping_offsets_from_bge_m3() -> None:
    chunks = chunk_text("客户交付条款".encode(), "text/plain", OverlappingTokenizer())

    assert [(chunk.text, chunk.token_count) for chunk in chunks] == [("客户交付条款", 4)]


def test_chunk_text_reencodes_each_emitted_substring_before_accepting_its_token_count() -> None:
    text = "A" + "x" * 1_099
    tokenizer = BoundaryExpandingTokenizer()

    chunks = chunk_text(text.encode(), "text/plain", tokenizer)

    assert len(chunks) >= 3
    assert all(
        chunk.token_count == tokenizer.count_tokens(chunk.text) <= 512
        for chunk in chunks
    )
    assert chunks[1].token_count == 512
    assert chunks[1].text == text[448:959]


def test_chunk_text_proportionally_reduces_a_large_independent_encoding_expansion() -> None:
    tokenizer = MultiplyingTokenizer()

    chunks = chunk_text(("A" * 600).encode(), "text/plain", tokenizer)

    assert chunks[0].text == "A" * 256
    assert all(chunk.token_count == tokenizer.count_tokens(chunk.text) <= 512 for chunk in chunks)


def test_chunk_text_does_not_cut_through_an_overlapping_offset_group() -> None:
    text = "A" * 511 + "BC" + "D" * 100
    offsets = [
        *((index, index + 1) for index in range(511)),
        (511, 512),
        (511, 513),
        *((index, index + 1) for index in range(513, len(text))),
    ]
    tokenizer = FixedOffsetTokenizer(offsets)

    chunks = chunk_text(text.encode(), "text/plain", tokenizer)

    assert chunks[0].text == "A" * 511
    assert chunks[1].text.startswith("A" * 64 + "BC")
    assert all(chunk.token_count <= 512 for chunk in chunks)


@pytest.mark.parametrize(
    "offsets",
    [
        [(1, 2), (0, 3)],
        [(0, 3), (1, 2)],
        [(-1, 1)],
        [(0, 0)],
        [(0, 7)],
    ],
)
def test_chunk_text_rejects_nonmonotonic_or_invalid_offsets(offsets: list[tuple[int, int]]) -> None:
    with pytest.raises(RetrievalInputError, match="retrieval-unavailable"):
        chunk_text(b"abcdef", "text/plain", FixedOffsetTokenizer(offsets))


@pytest.mark.parametrize(
    "offsets",
    [
        [(0, 1), (3, 6)],
        [(0, 3)],
    ],
)
def test_chunk_text_rejects_uncovered_offsets_that_still_encode_tokens(
    offsets: list[tuple[int, int]],
) -> None:
    with pytest.raises(RetrievalInputError, match="retrieval-unavailable"):
        chunk_text(b"abcdef", "text/plain", FixedOffsetTokenizer(offsets))


def test_chunk_text_preserves_whitespace_only_normalization_gaps() -> None:
    text = " \tA\u200bb"
    tokenizer = FixedOffsetTokenizer(
        [(2, 3), (4, 5)], normalizations={" \t": " ", "\u200b": " "}
    )

    chunks = chunk_text(text.encode(), "text/plain", tokenizer)

    assert [chunk.text for chunk in chunks] == [text]


@pytest.mark.parametrize("content_type", ["text/markdown", "text/csv", "application/json"])
def test_chunk_text_accepts_supported_non_plain_content_types(content_type: str) -> None:
    chunks = chunk_text(b'{"title":"retrieval"}', content_type, TOKENIZER)

    assert [chunk.text for chunk in chunks] == ['{"title":"retrieval"}']


def test_chunk_text_rejects_unsupported_content_type() -> None:
    with pytest.raises(RetrievalInputError, match="unsupported-content"):
        chunk_text(b"not a PDF", "application/pdf", TOKENIZER)


def test_chunk_text_rejects_invalid_utf8_and_payloads_over_ten_mebibytes() -> None:
    with pytest.raises(RetrievalInputError, match="invalid-utf8"):
        chunk_text(b"\xff", "text/plain", TOKENIZER)

    with pytest.raises(RetrievalInputError, match="index-too-large"):
        chunk_text(b"x" * (10 * 1024 * 1024 + 1), "text/plain", TOKENIZER)


def test_chunk_text_limits_chunks_to_512_tokens_with_64_token_overlap() -> None:
    words = [f"word{index}" for index in range(600)]
    chunks = chunk_text(" ".join(words).encode(), "text/plain", TOKENIZER)

    assert [chunk.ordinal for chunk in chunks] == [0, 1]
    assert [chunk.token_count for chunk in chunks] == [512, 152]
    assert chunks[1].text.split()[:64] == chunks[0].text.split()[-64:]


def test_chunk_text_splits_a_giant_multibyte_line_at_the_eight_kib_cap() -> None:
    chunks = chunk_text(("é" * 5_000).encode(), "text/plain", TOKENIZER)

    assert 1 < len(chunks) < 20
    assert [chunk.ordinal for chunk in chunks] == list(range(len(chunks)))
    assert all(len(chunk.text.encode()) <= 8 * 1024 for chunk in chunks)
    assert all(chunk.line_start == chunk.line_end == 1 for chunk in chunks)
    assert chunks == chunk_text(("é" * 5_000).encode(), "text/plain", TOKENIZER)


def test_chunk_text_uses_one_token_offset_scan_for_many_short_paragraphs() -> None:
    tokenizer = WhitespaceTokenizer()
    chunks = chunk_text(("paragraph\n\n" * 6_000).encode(), "text/plain", tokenizer)

    assert chunks
    assert tokenizer.offset_calls == 1
    assert tokenizer.encode_calls <= len(chunks) + 2
    assert tokenizer.normalize_calls == 1


def test_chunk_text_keeps_a_64_token_overlap_when_long_tokens_fit() -> None:
    tokenizer = WhitespaceTokenizer()
    words = [f"token{index:04d}" + "x" * 10 for index in range(600)]
    chunks = chunk_text(" ".join(words).encode(), "text/plain", tokenizer)

    assert chunks[1].text.split()[:64] == chunks[0].text.split()[-64:]


def test_chunk_text_keeps_overlap_after_a_paragraph_boundary_before_a_long_paragraph() -> None:
    tokenizer = WhitespaceTokenizer()
    prefix = [f"prefix{index}" for index in range(450)]
    following = [f"following{index}" for index in range(600)]
    chunks = chunk_text((" ".join(prefix) + "\n\n" + " ".join(following)).encode(), "text/plain", tokenizer)

    assert chunks[0].text.split() == prefix
    assert chunks[1].text.split()[:64] == prefix[-64:]
    assert chunks == chunk_text((" ".join(prefix) + "\n\n" + " ".join(following)).encode(), "text/plain", tokenizer)


def test_chunk_text_does_not_emit_an_overlap_only_chunk_before_a_long_paragraph() -> None:
    tokenizer = WhitespaceTokenizer()
    prefix = [f"prefix{index}" for index in range(512)]
    following = [f"following{index}" for index in range(600)]
    payload = (" ".join(prefix) + "   \n\n" + " ".join(following)).encode()
    chunks = chunk_text(payload, "text/plain", tokenizer)

    assert [chunk.token_count for chunk in chunks] == [512, 512, 216]
    assert chunks[1].text.split()[:64] == prefix[-64:]
    assert chunks == chunk_text(payload, "text/plain", tokenizer)
