"""Opaque retrieval receipt issuance and claim verification."""

import hashlib
import secrets
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any, Literal
from uuid import UUID

from sqlalchemy.ext.asyncio import AsyncSession

from app.models.retrieval import XAgentRetrievalReceipt

ReceiptKind = Literal["project_discovery", "artifact_search"]


class RetrievalReceiptError(RuntimeError):
    """A retrieval receipt is expired or differs from its bound operation."""

    def __init__(self, code: Literal["evidence-expired", "evidence-conflict"]) -> None:
        self.code = code
        super().__init__(code)


@dataclass(frozen=True)
class ReceiptClaims:
    kind: ReceiptKind
    actor_id: UUID
    session_id: UUID
    tool_call_id: str
    query_sha256: str
    scope: dict[str, Any]
    permission_revision: int
    project_ids: tuple[UUID, ...]
    index_generations: tuple[dict[str, Any], ...]
    chunk_ids: tuple[UUID, ...]
    payload_sha256: str
    issued_at: datetime
    expires_at: datetime
    citation_ordinal_start: int | None
    citation_ordinal_end: int | None


def issue_receipt_secret() -> str:
    """Return a fresh opaque bearer secret with at least 256 bits of entropy."""
    return secrets.token_urlsafe(32)


def receipt_digest_id(secret: str) -> UUID:
    """Derive the persisted 128-bit receipt lookup digest from an opaque secret."""
    return UUID(bytes=hashlib.sha256(secret.encode()).digest()[:16])


def verify_receipt(
    secret: str,
    stored_digest_id: UUID,
    stored: ReceiptClaims,
    expected: ReceiptClaims,
    *,
    now: datetime | None = None,
) -> None:
    """Verify digest, expiry, and every operation claim without exposing the secret."""
    if not secrets.compare_digest(receipt_digest_id(secret).bytes, stored_digest_id.bytes):
        raise RetrievalReceiptError("evidence-conflict")
    current_time = now or datetime.now(UTC)
    if stored.expires_at <= current_time:
        raise RetrievalReceiptError("evidence-expired")
    if stored != expected:
        raise RetrievalReceiptError("evidence-conflict")


async def persist_receipt(session: AsyncSession, claims: ReceiptClaims) -> str:
    """Persist only a digest identifier and immutable claims, then return the secret."""
    secret = issue_receipt_secret()
    session.add(
        XAgentRetrievalReceipt(
            id=receipt_digest_id(secret),
            kind=claims.kind,
            actor_id=claims.actor_id,
            session_id=claims.session_id,
            tool_call_id=claims.tool_call_id,
            query_sha256=claims.query_sha256,
            scope=claims.scope,
            permission_revision=claims.permission_revision,
            project_ids=[str(value) for value in claims.project_ids],
            index_generations=list(claims.index_generations),
            chunk_ids=[str(value) for value in claims.chunk_ids],
            payload_sha256=claims.payload_sha256,
            issued_at=claims.issued_at,
            expires_at=claims.expires_at,
            citation_ordinal_start=claims.citation_ordinal_start,
            citation_ordinal_end=claims.citation_ordinal_end,
        )
    )
    await session.flush()
    return secret


def new_receipt_times(now: datetime | None = None) -> tuple[datetime, datetime]:
    issued_at = now or datetime.now(UTC)
    return issued_at, issued_at + timedelta(minutes=5)
