import json
import os
from pathlib import Path

import pytest

from app.model import AutoTokenizerBackend, TokenizerCounter


pytestmark = pytest.mark.skipif(
    os.getenv("XAGENT_PINNED_TOKENIZER_TEST") != "1",
    reason="set XAGENT_PINNED_TOKENIZER_TEST=1 to load the pinned tokenizer assets",
)


def test_real_pinned_tokenizer_vectors() -> None:
    counter = TokenizerCounter(backend_factory=AutoTokenizerBackend)
    fixture = Path(__file__).resolve().parents[3] / "packages/xagent/retrieval/tests/bge-m3-token-vectors.json"
    specs = json.loads(fixture.read_text(encoding="utf-8"))
    vectors = [
        (
            spec.get("query") or spec["separator"].join([spec["unit"]] * spec["repeat"]),
            spec["tokens"],
        )
        for spec in specs
    ]

    assert [(counter.count(text), expected) for text, expected in vectors] == [
        (expected, expected) for _, expected in vectors
    ]
