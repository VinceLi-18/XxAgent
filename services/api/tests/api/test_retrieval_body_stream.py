import pytest

from app.api.routes.internal_retrieval import MAX_RETRIEVAL_BODY_BYTES
from app.main import app


class _HugeFrame:
    """Expose a size without allowing the route to copy the frame."""

    def __len__(self) -> int:
        return MAX_RETRIEVAL_BODY_BYTES + 1

    def __bool__(self) -> bool:
        return True

    def __iter__(self):
        raise AssertionError("oversized frame was copied")


async def _post_body(
    chunks: list[object], *, headers: list[tuple[bytes, bytes]] | None = None
) -> tuple[int, bytes]:
    messages = iter([
        {"type": "http.request", "body": chunk, "more_body": index + 1 < len(chunks)}
        for index, chunk in enumerate(chunks)
    ])
    sent: list[dict[str, object]] = []

    async def receive() -> dict[str, object]:
        return next(messages)

    async def send(message: dict[str, object]) -> None:
        sent.append(message)

    await app(
        {
            "type": "http",
            "asgi": {"version": "3.0"},
            "http_version": "1.1",
            "method": "POST",
            "scheme": "http",
            "path": "/internal/xagent/retrieval/projects",
            "raw_path": b"/internal/xagent/retrieval/projects",
            "query_string": b"",
            "headers": headers or [],
            "client": ("127.0.0.1", 1),
            "server": ("test", 80),
        },
        receive,
        send,
    )
    status_code = next(int(item["status"]) for item in sent if item["type"] == "http.response.start")
    body = b"".join(
        item.get("body", b"") for item in sent if item["type"] == "http.response.body"
    )
    return status_code, body


@pytest.mark.anyio
async def test_body_cap_accepts_exact_bytes_and_rejects_one_more_for_all_length_modes() -> None:
    exact = b"{}" + (b" " * (MAX_RETRIEVAL_BODY_BYTES - 2))
    one_over = exact + b"x"

    exact_status, _ = await _post_body(
        [exact[:100], exact[100:]],
        headers=[(b"content-length", str(MAX_RETRIEVAL_BODY_BYTES).encode())],
    )
    absent_status, absent_body = await _post_body([one_over[:100], one_over[100:]])
    misleading_status, misleading_body = await _post_body(
        [one_over], headers=[(b"content-length", b"2")]
    )
    chunked_status, chunked_body = await _post_body(
        [one_over[:32768], one_over[32768:]],
        headers=[(b"transfer-encoding", b"chunked")],
    )

    assert exact_status == 403
    assert absent_status == misleading_status == chunked_status == 503
    assert absent_body == misleading_body == chunked_body == b'{"detail":{"code":"service-unavailable"}}'


@pytest.mark.anyio
async def test_body_cap_rejects_a_single_huge_frame_without_copying_it() -> None:
    status_code, body = await _post_body([_HugeFrame()])

    assert status_code == 503
    assert body == b'{"detail":{"code":"service-unavailable"}}'


@pytest.mark.anyio
async def test_body_cap_counts_multibyte_payload_bytes() -> None:
    exact = b'"' + ("中" * ((MAX_RETRIEVAL_BODY_BYTES - 2) // 3)).encode() + b'"'
    exact += b" " * (MAX_RETRIEVAL_BODY_BYTES - len(exact))

    exact_status, _ = await _post_body([exact])
    over_status, _ = await _post_body([exact + "中".encode()])

    assert exact_status == 403
    assert over_status == 503
