import re

import pytest

from app.retrieval.chunking import RetrievalInputError, chunk_text


class WhitespaceTokenizer:
    def encode(self, text: str, *, add_special_tokens: bool = False) -> list[int]:
        return list(range(len(re.findall(r"\w+|[^\w\s]", text, flags=re.UNICODE))))


TOKENIZER = WhitespaceTokenizer()


def test_chunk_text_normalizes_crlf_without_changing_logical_line_numbers() -> None:
    chunks = chunk_text(b"first line\r\nsecond line\r\n\r\nthird line", "text/plain", TOKENIZER)

    assert [(chunk.ordinal, chunk.text, chunk.line_start, chunk.line_end, chunk.token_count) for chunk in chunks] == [
        (0, "first line\nsecond line\n\nthird line", 1, 4, 6)
    ]


def test_chunk_text_returns_no_chunks_for_blank_content() -> None:
    assert chunk_text(b" \r\n\t", "text/plain", TOKENIZER) == []


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
