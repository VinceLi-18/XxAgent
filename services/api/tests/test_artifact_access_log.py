import asyncio
import logging
import socket
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

import pytest
import uvicorn
from httpx import AsyncClient

from app.api.routes import internal_artifacts
from app.core.db import get_admin_session
from app.main import app


VERSION_ID = "00000000-0000-0000-0000-000000000401"
ALLOWED_SIGNATURE = "a" * 64
DENIED_SIGNATURE = "b" * 64


class _AccessLogHandler(logging.Handler):
    def __init__(self) -> None:
        super().__init__()
        self.messages: list[str] = []

    def emit(self, record: logging.LogRecord) -> None:
        self.messages.append(record.getMessage())


def _assert_no_signed_bearer(text: str) -> None:
    if "signature=" in text or "expires=" in text:
        raise AssertionError("资料正文访问日志包含 signed-bearer query")


@asynccontextmanager
async def _running_uvicorn() -> AsyncIterator[str]:
    listener = socket.socket()
    listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    listener.bind(("127.0.0.1", 0))
    listener.listen(128)
    listener.setblocking(False)
    port = listener.getsockname()[1]
    server = uvicorn.Server(
        uvicorn.Config(app, log_config=None, access_log=True, lifespan="off")
    )
    task = asyncio.create_task(server.serve(sockets=[listener]))
    try:
        for _ in range(100):
            if server.started:
                break
            await asyncio.sleep(0.01)
        if not server.started:
            raise RuntimeError("Uvicorn 未在限定时间内启动")
        yield f"http://127.0.0.1:{port}"
    finally:
        server.should_exit = True
        await asyncio.wait_for(task, timeout=5)
        listener.close()


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


@pytest.mark.anyio
async def test_artifact_content_query_is_absent_from_real_uvicorn_access_log(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def session_override() -> AsyncIterator[object]:
        yield object()

    async def resolve_content(
        _session: object,
        *,
        signature: str,
        **_kwargs: object,
    ) -> tuple[str, str, str]:
        if signature == DENIED_SIGNATURE:
            raise internal_artifacts.artifacts.ArtifactForbidden
        return "private/object", "text/plain", 'inline; filename="safe.txt"'

    def stream_content(_key: str):
        yield b"content"

    app.dependency_overrides[get_admin_session] = session_override
    monkeypatch.setattr(internal_artifacts.artifacts, "resolve_read_content", resolve_content)
    monkeypatch.setattr(internal_artifacts.artifacts, "stream_read_content", stream_content)
    logger = logging.getLogger("uvicorn.access")
    handler = _AccessLogHandler()
    previous_handlers = logger.handlers[:]
    previous_level = logger.level
    previous_propagate = logger.propagate
    logger.handlers = [handler]
    logger.setLevel(logging.INFO)
    logger.propagate = False
    try:
        async with _running_uvicorn() as origin, AsyncClient(base_url=origin) as client:
            allowed = await client.get(
                f"/api/v1/xagent/artifact-content/{VERSION_ID}",
                params={"expires": "2000000000", "mode": "inline", "signature": ALLOWED_SIGNATURE},
            )
            denied = await client.get(
                f"/api/v1/xagent/artifact-content/{VERSION_ID}",
                params={"expires": "2000000001", "mode": "inline", "signature": DENIED_SIGNATURE},
            )
            health = await client.get("/api/v1/health", params={"probe": "visible"})
        assert allowed.status_code == 200
        assert denied.status_code == 403
        assert health.status_code == 200
        access_logs = "\n".join(handler.messages)
        _assert_no_signed_bearer(access_logs)
        assert access_logs.count(f"/api/v1/xagent/artifact-content/{VERSION_ID}") == 2
        assert "/api/v1/health?probe=visible" in access_logs
    finally:
        app.dependency_overrides.pop(get_admin_session, None)
        logger.handlers = previous_handlers
        logger.setLevel(previous_level)
        logger.propagate = previous_propagate
