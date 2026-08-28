"""Authenticated bounded relay for the service-only retrieval tokenizer."""

import json
from collections.abc import AsyncIterator

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request, status

from app.api.routes.internal_auth import require_service_identity
from app.core.config import settings
from app.retrieval.embedding_client import MODEL_ID, MODEL_REVISION


MAX_TOKEN_COUNT_TEXT_BYTES = 8 * 1024
# JSON may escape every one-byte control scalar as six ASCII bytes.
MAX_TOKEN_COUNT_BODY_BYTES = MAX_TOKEN_COUNT_TEXT_BYTES * 6 + len(b'{"text":""}')
MAX_TOKEN_COUNT_RESPONSE_BYTES = 512

router = APIRouter(prefix="/internal/xagent/retrieval", tags=["internal-retrieval"])


async def get_tokenizer_http_client() -> AsyncIterator[httpx.AsyncClient]:
    """Yield the private embedding client used only by the token-count relay."""
    async with httpx.AsyncClient(
        base_url=settings.EMBEDDING_URL,
        timeout=settings.EMBEDDING_TIMEOUT,
        follow_redirects=False,
    ) as client:
        yield client


def _rejected(status_code: int = status.HTTP_422_UNPROCESSABLE_CONTENT) -> HTTPException:
    return HTTPException(status_code=status_code, detail={"code": "service-unavailable"})


async def _bounded_token_count_body(request: Request) -> bytes:
    """Validate a closed JSON body before forwarding the original bounded bytes."""
    if request.headers.get("content-type") != "application/json":
        raise _rejected()
    declared = request.headers.get("content-length")
    if declared is not None:
        try:
            declared_size = int(declared)
        except ValueError:
            raise _rejected() from None
        if declared_size < 0 or declared_size > MAX_TOKEN_COUNT_BODY_BYTES:
            raise _rejected()
    body = bytearray()
    try:
        async for chunk in request.stream():
            if len(body) + len(chunk) > MAX_TOKEN_COUNT_BODY_BYTES:
                raise _rejected()
            body.extend(chunk)
    except HTTPException:
        raise
    except Exception as error:
        raise _rejected() from error
    try:
        payload = json.loads(body.decode("utf-8", errors="strict"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise _rejected() from error
    if not isinstance(payload, dict) or set(payload) != {"text"} or not isinstance(payload["text"], str):
        raise _rejected()
    try:
        text_bytes = payload["text"].encode("utf-8", errors="strict")
    except UnicodeEncodeError as error:
        raise _rejected() from error
    if len(text_bytes) > MAX_TOKEN_COUNT_TEXT_BYTES:
        raise _rejected()
    return bytes(body)


async def _bounded_response(response: httpx.Response) -> object:
    if response.status_code != status.HTTP_200_OK:
        raise _rejected(status.HTTP_503_SERVICE_UNAVAILABLE)
    if response.headers.get("content-type") != "application/json":
        raise _rejected(status.HTTP_503_SERVICE_UNAVAILABLE)
    body = bytearray()
    async for chunk in response.aiter_bytes():
        if len(body) + len(chunk) > MAX_TOKEN_COUNT_RESPONSE_BYTES:
            raise _rejected(status.HTTP_503_SERVICE_UNAVAILABLE)
        body.extend(chunk)
    try:
        return json.loads(body.decode("utf-8", errors="strict"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise _rejected(status.HTTP_503_SERVICE_UNAVAILABLE) from error


def _validated_response(payload: object) -> dict[str, str | int]:
    if not isinstance(payload, dict) or set(payload) != {"model", "revision", "token_count"}:
        raise _rejected(status.HTTP_503_SERVICE_UNAVAILABLE)
    count = payload["token_count"]
    if (
        payload["model"] != MODEL_ID
        or payload["revision"] != MODEL_REVISION
        or isinstance(count, bool)
        or not isinstance(count, int)
        or count < 0
    ):
        raise _rejected(status.HTTP_503_SERVICE_UNAVAILABLE)
    return {"model": MODEL_ID, "revision": MODEL_REVISION, "token_count": count}


@router.post("/token-count")
async def token_count_relay(
    request: Request,
    _: None = Depends(require_service_identity),
    client: httpx.AsyncClient = Depends(get_tokenizer_http_client),
) -> dict[str, str | int]:
    """Forward one bounded query to the exact private tokenizer without user identity or audit."""
    body = await _bounded_token_count_body(request)
    try:
        async with client.stream(
            "POST",
            "/token-count",
            content=body,
            headers={"content-type": "application/json"},
        ) as response:
            payload = await _bounded_response(response)
        return _validated_response(payload)
    except HTTPException:
        raise
    except httpx.HTTPError:
        raise _rejected(status.HTTP_503_SERVICE_UNAVAILABLE) from None
    except Exception:
        raise _rejected(status.HTTP_503_SERVICE_UNAVAILABLE) from None
