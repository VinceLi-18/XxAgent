from datetime import UTC, datetime
from uuid import UUID

from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.auth import XAgentAuthSession, XAgentPermissionRevision
from app.models.identity import Account, Role
from app.models.workbench import XAgentAccountCapabilityGrant, XAgentCapability


class CapabilityOperationRejected(Exception):
    pass


async def _lock_accounts_by_email(
    session: AsyncSession,
    *emails: str,
) -> dict[str, Account]:
    normalized_emails = {email.strip().casefold() for email in emails}
    accounts = await session.scalars(
        select(Account)
        .where(func.lower(Account.email).in_(normalized_emails))
        .order_by(Account.id)
        .with_for_update()
    )
    return {account.email.casefold(): account for account in accounts}


async def effective_capabilities(
    session: AsyncSession,
    account: Account,
) -> frozenset[XAgentCapability]:
    if not account.is_active:
        return frozenset()
    if account.role is Role.MANAGER:
        return frozenset({XAgentCapability.PROJECT_CREATE})

    values = await session.scalars(
        select(XAgentAccountCapabilityGrant.capability).where(
            XAgentAccountCapabilityGrant.account_id == account.id
        )
    )
    return frozenset(XAgentCapability(value) for value in values)


async def effective_capabilities_for_email(
    session: AsyncSession,
    email: str,
) -> frozenset[XAgentCapability]:
    normalized_email = email.strip().casefold()
    account = await session.scalar(
        select(Account).where(func.lower(Account.email) == normalized_email)
    )
    if account is None:
        raise CapabilityOperationRejected
    return await effective_capabilities(session, account)


async def _advance_revision_and_revoke_sessions(
    session: AsyncSession,
    account_id: UUID,
) -> None:
    now = datetime.now(UTC)
    revision = await session.get(
        XAgentPermissionRevision,
        account_id,
        with_for_update=True,
    )
    if revision is None:
        raise CapabilityOperationRejected
    revision.revision += 1
    revision.updated_at = now
    await session.execute(
        update(XAgentAuthSession)
        .where(
            XAgentAuthSession.account_id == account_id,
            XAgentAuthSession.revoked_at.is_(None),
        )
        .values(revoked_at=now)
    )


async def grant_capability(
    session: AsyncSession,
    *,
    email: str,
    capability: XAgentCapability,
    granted_by: str,
) -> bool:
    target_email = email.strip().casefold()
    grantor_email = granted_by.strip().casefold()
    accounts = await _lock_accounts_by_email(session, target_email, grantor_email)
    target = accounts.get(target_email)
    grantor = accounts.get(grantor_email)
    if (
        target is None
        or grantor is None
        or not grantor.is_active
        or grantor.role is not Role.MANAGER
    ):
        raise CapabilityOperationRejected
    if target.role is Role.MANAGER:
        return False

    existing = await session.get(
        XAgentAccountCapabilityGrant,
        (target.id, capability.value),
    )
    if existing is not None:
        return False
    session.add(
        XAgentAccountCapabilityGrant(
            account_id=target.id,
            capability=capability.value,
            granted_by_id=grantor.id,
        )
    )
    await session.flush()
    await _advance_revision_and_revoke_sessions(session, target.id)
    return True


async def revoke_capability(
    session: AsyncSession,
    *,
    email: str,
    capability: XAgentCapability,
) -> bool:
    target_email = email.strip().casefold()
    target = await session.scalar(
        select(Account)
        .where(func.lower(Account.email) == target_email)
        .with_for_update()
    )
    if target is None:
        raise CapabilityOperationRejected

    existing = await session.get(
        XAgentAccountCapabilityGrant,
        (target.id, capability.value),
        with_for_update=True,
    )
    if existing is None:
        return False
    await session.delete(existing)
    await session.flush()
    await _advance_revision_and_revoke_sessions(session, target.id)
    return True
