"""Digest-only receipt issuance for Fact proposal Session admission."""

import hashlib
import secrets
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Literal
from uuid import UUID

from sqlalchemy.ext.asyncio import AsyncSession

from app.models.facts import FACT_RECEIPT_TTL_SECONDS, FactProposalReceipt


class FactReceiptError(RuntimeError):
    """A Fact receipt is expired or differs from its admission claims."""

    def __init__(
        self,
        code: Literal["fact-receipt-invalid", "fact-receipt-expired"],
    ) -> None:
        self.code = code
        super().__init__(code)


@dataclass(frozen=True)
class FactReceiptClaims:
    """Immutable identities bound to one Fact proposal admission receipt."""

    proposal_id: UUID
    project_id: UUID
    actor_id: UUID
    session_id: UUID
    tool_call_id: str
    permission_revision: int
    source_event_sequence: int
    payload_sha256: str
    issued_at: datetime
    expires_at: datetime


def issue_receipt_secret() -> str:
    """Return a fresh opaque bearer secret with at least 256 bits of entropy."""
    return secrets.token_urlsafe(32)


def receipt_digest_id(secret: str) -> UUID:
    """Derive the persisted 128-bit lookup digest from an opaque receipt."""
    return UUID(bytes=hashlib.sha256(secret.encode()).digest()[:16])


def new_receipt_times(now: datetime | None = None) -> tuple[datetime, datetime]:
    """Return the exact five-minute Fact admission window."""
    issued_at = now or datetime.now(UTC)
    return issued_at, issued_at + timedelta(seconds=FACT_RECEIPT_TTL_SECONDS)


def verify_receipt(
    secret: str,
    stored_digest_id: UUID,
    stored: FactReceiptClaims,
    expected: FactReceiptClaims,
    *,
    now: datetime | None = None,
) -> None:
    """Verify receipt digest, expiry, and every immutable admission claim."""
    if not secrets.compare_digest(receipt_digest_id(secret).bytes, stored_digest_id.bytes):
        raise FactReceiptError("fact-receipt-invalid")
    if stored != expected:
        raise FactReceiptError("fact-receipt-invalid")
    current_time = now or datetime.now(UTC)
    if stored.expires_at <= current_time:
        raise FactReceiptError("fact-receipt-expired")


async def persist_receipt(session: AsyncSession, claims: FactReceiptClaims) -> str:
    """Persist only a receipt digest and its immutable admission claims."""
    secret = issue_receipt_secret()
    session.add(
        FactProposalReceipt(
            receipt_digest_id=receipt_digest_id(secret),
            proposal_id=claims.proposal_id,
            project_id=claims.project_id,
            actor_id=claims.actor_id,
            session_id=claims.session_id,
            tool_call_id=claims.tool_call_id,
            permission_revision=claims.permission_revision,
            source_event_sequence=claims.source_event_sequence,
            payload_sha256=claims.payload_sha256,
            issued_at=claims.issued_at,
            expires_at=claims.expires_at,
        )
    )
    await session.flush()
    return secret
