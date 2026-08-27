import os
import subprocess
import sys
from datetime import UTC, datetime, timedelta
from pathlib import Path
from uuid import uuid4

import pytest
from argon2 import PasswordHasher
from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.auth import XAgentAccountCredential, XAgentAuthSession
from app.models.identity import Account
from app.models.workbench import XAgentAccountCapabilityGrant


def _run_cli(*args: str, input_text: str = "") -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, "-m", "app.cli", *args],
        cwd=Path(__file__).resolve().parents[1],
        env=os.environ.copy(),
        input=input_text,
        text=True,
        capture_output=True,
        check=False,
    )


@pytest.mark.anyio
async def test_account_create_normalizes_email_and_seeds_permission_revision(
    seeded_database,
) -> None:
    created = _run_cli(
        "account",
        "create",
        "--email",
        "  NEW.USER@example.test ",
        "--role",
        "specialist",
    )

    assert created.returncode == 0
    assert created.stdout.strip() == "账号已创建"
    assert created.stderr == ""
    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        account = await session.scalar(select(Account).where(Account.email == "new.user@example.test"))
        revision = await session.scalar(
            text("SELECT revision FROM xagent_permission_revisions WHERE account_id = :account_id"),
            {"account_id": account.id if account is not None else None},
        )
    assert account is not None and account.role.value == "specialist" and account.is_active
    assert revision == 1


@pytest.mark.anyio
async def test_account_create_rejects_duplicate_email_without_database_details(
    seeded_database,
) -> None:
    duplicate = _run_cli(
        "account",
        "create",
        "--email",
        "ALICE@example.test",
        "--role",
        "manager",
    )

    assert duplicate.returncode == 2
    assert duplicate.stdout == ""
    assert duplicate.stderr.strip() == "账号操作失败"
    assert "accounts" not in duplicate.stderr
    assert "unique" not in duplicate.stderr.lower()


@pytest.mark.anyio
async def test_set_password_reads_stdin_twice_and_revokes_existing_sessions(
    seeded_database,
    alice,
) -> None:
    now = datetime.now(UTC)
    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        async with session.begin():
            session.add(
                XAgentAuthSession(
                    id=uuid4(),
                    account_id=alice.id,
                    jti_hash="c" * 64,
                    created_at=now,
                    expires_at=now + timedelta(hours=8),
                )
            )

    updated = _run_cli(
        "account",
        "set-password",
        "--email",
        "alice@example.test",
        input_text="new-password-123\nnew-password-123\n",
    )

    assert updated.returncode == 0
    assert updated.stdout.strip() == "密码已更新，既有登录已撤销"
    assert updated.stderr == ""
    assert "new-password-123" not in updated.stdout + updated.stderr
    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        credential = await session.scalar(
            select(XAgentAccountCredential).where(XAgentAccountCredential.account_id == alice.id)
        )
        auth_session = await session.scalar(select(XAgentAuthSession))
    assert credential is not None
    assert credential.password_hash.startswith("$argon2id$")
    assert "new-password-123" not in credential.password_hash
    assert PasswordHasher().verify(credential.password_hash, "new-password-123")
    assert auth_session is not None and auth_session.revoked_at is not None


@pytest.mark.anyio
async def test_set_password_rejects_mismatched_confirmation_without_writing(
    seeded_database,
    alice,
) -> None:
    rejected = _run_cli(
        "account",
        "set-password",
        "--email",
        "alice@example.test",
        input_text="first-password\nsecond-password\n",
    )

    assert rejected.returncode == 2
    assert rejected.stdout == ""
    assert rejected.stderr.strip() == "两次输入的密码不一致"
    assert "first-password" not in rejected.stderr
    assert "second-password" not in rejected.stderr
    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        assert await session.scalar(select(XAgentAccountCredential)) is None


@pytest.mark.anyio
async def test_deactivate_revokes_sessions_and_advances_permission_revision(
    seeded_database,
    alice,
) -> None:
    now = datetime.now(UTC)
    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        async with session.begin():
            session.add(
                XAgentAuthSession(
                    id=uuid4(),
                    account_id=alice.id,
                    jti_hash="d" * 64,
                    created_at=now,
                    expires_at=now + timedelta(hours=8),
                )
            )

    deactivated = _run_cli("account", "deactivate", "--email", "alice@example.test")

    assert deactivated.returncode == 0
    assert deactivated.stdout.strip() == "账号已停用，既有登录已撤销"
    assert deactivated.stderr == ""
    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        account = await session.scalar(select(Account).where(Account.id == alice.id))
        auth_session = await session.scalar(select(XAgentAuthSession))
        revision = await session.scalar(
            text("SELECT revision FROM xagent_permission_revisions WHERE account_id = :account_id"),
            {"account_id": alice.id},
        )
    assert account is not None and not account.is_active
    assert auth_session is not None and auth_session.revoked_at is not None
    assert revision == 2


@pytest.mark.anyio
async def test_capability_grant_advances_revision_and_revokes_existing_sessions(
    seeded_database,
    alice,
) -> None:
    now = datetime.now(UTC)
    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        async with session.begin():
            session.add(
                XAgentAuthSession(
                    id=uuid4(),
                    account_id=alice.id,
                    jti_hash="e" * 64,
                    created_at=now,
                    expires_at=now + timedelta(hours=8),
                )
            )

    granted = _run_cli(
        "account",
        "capability",
        "grant",
        "--email",
        "alice@example.test",
        "--capability",
        "project.create",
        "--granted-by",
        "manager@example.test",
    )

    assert granted.returncode == 0
    assert granted.stdout.strip() == "能力已授予：project.create"
    assert granted.stderr == ""
    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        grant = await session.get(
            XAgentAccountCapabilityGrant,
            (alice.id, "project.create"),
        )
        auth_session = await session.scalar(select(XAgentAuthSession))
        revision = await session.scalar(
            text(
                "SELECT revision FROM xagent_permission_revisions "
                "WHERE account_id = :account_id"
            ),
            {"account_id": alice.id},
        )

    assert grant is not None
    assert auth_session is not None and auth_session.revoked_at is not None
    assert revision == 2


@pytest.mark.anyio
async def test_capability_revoke_advances_revision_and_revokes_new_sessions(
    seeded_database,
    alice,
) -> None:
    granted = _run_cli(
        "account",
        "capability",
        "grant",
        "--email",
        "alice@example.test",
        "--capability",
        "project.create",
        "--granted-by",
        "manager@example.test",
    )
    assert granted.returncode == 0

    now = datetime.now(UTC)
    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        async with session.begin():
            session.add(
                XAgentAuthSession(
                    id=uuid4(),
                    account_id=alice.id,
                    jti_hash="f" * 64,
                    created_at=now,
                    expires_at=now + timedelta(hours=8),
                )
            )

    revoked = _run_cli(
        "account",
        "capability",
        "revoke",
        "--email",
        "alice@example.test",
        "--capability",
        "project.create",
    )

    assert revoked.returncode == 0
    assert revoked.stdout.strip() == "能力已撤销：project.create"
    assert revoked.stderr == ""
    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        grant = await session.get(
            XAgentAccountCapabilityGrant,
            (alice.id, "project.create"),
        )
        auth_session = await session.scalar(select(XAgentAuthSession))
        revision = await session.scalar(
            text(
                "SELECT revision FROM xagent_permission_revisions "
                "WHERE account_id = :account_id"
            ),
            {"account_id": alice.id},
        )

    assert grant is None
    assert auth_session is not None and auth_session.revoked_at is not None
    assert revision == 3


@pytest.mark.anyio
async def test_capability_show_reports_effective_manager_and_specialist_capabilities(
    seeded_database,
) -> None:
    specialist_before = _run_cli(
        "account",
        "capability",
        "show",
        "--email",
        "alice@example.test",
    )
    manager = _run_cli(
        "account",
        "capability",
        "show",
        "--email",
        "manager@example.test",
    )

    assert specialist_before.returncode == 0
    assert specialist_before.stdout.strip() == "有效能力：无"
    assert specialist_before.stderr == ""
    assert manager.returncode == 0
    assert manager.stdout.strip() == "有效能力：project.create"
    assert manager.stderr == ""

    granted = _run_cli(
        "account",
        "capability",
        "grant",
        "--email",
        "alice@example.test",
        "--capability",
        "project.create",
        "--granted-by",
        "manager@example.test",
    )
    specialist_after = _run_cli(
        "account",
        "capability",
        "show",
        "--email",
        "alice@example.test",
    )

    assert granted.returncode == 0
    assert specialist_after.returncode == 0
    assert specialist_after.stdout.strip() == "有效能力：project.create"
    assert specialist_after.stderr == ""


@pytest.mark.anyio
async def test_capability_grant_and_revoke_are_idempotent(
    seeded_database,
) -> None:
    grant_args = (
        "account",
        "capability",
        "grant",
        "--email",
        "alice@example.test",
        "--capability",
        "project.create",
        "--granted-by",
        "manager@example.test",
    )
    first_grant = _run_cli(*grant_args)
    duplicate_grant = _run_cli(*grant_args)

    assert first_grant.stdout.strip() == "能力已授予：project.create"
    assert duplicate_grant.returncode == 0
    assert duplicate_grant.stdout.strip() == "能力已存在：project.create"
    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        revision_after_grants = await session.scalar(
            text(
                "SELECT revision FROM xagent_permission_revisions "
                "WHERE account_id = (SELECT id FROM accounts WHERE email = 'alice@example.test')"
            )
        )
    assert revision_after_grants == 2

    revoke_args = (
        "account",
        "capability",
        "revoke",
        "--email",
        "alice@example.test",
        "--capability",
        "project.create",
    )
    first_revoke = _run_cli(*revoke_args)
    duplicate_revoke = _run_cli(*revoke_args)

    assert first_revoke.stdout.strip() == "能力已撤销：project.create"
    assert duplicate_revoke.returncode == 0
    assert duplicate_revoke.stdout.strip() == "能力不存在：project.create"
    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        revision_after_revokes = await session.scalar(
            text(
                "SELECT revision FROM xagent_permission_revisions "
                "WHERE account_id = (SELECT id FROM accounts WHERE email = 'alice@example.test')"
            )
        )
    assert revision_after_revokes == 3


@pytest.mark.anyio
async def test_capability_grant_requires_an_active_manager(
    seeded_database,
    manager,
) -> None:
    specialist_grantor = _run_cli(
        "account",
        "capability",
        "grant",
        "--email",
        "alice@example.test",
        "--capability",
        "project.create",
        "--granted-by",
        "bob@example.test",
    )
    assert specialist_grantor.returncode == 2
    assert specialist_grantor.stdout == ""
    assert specialist_grantor.stderr.strip() == "账号操作失败"

    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        async with session.begin():
            await session.execute(
                text("UPDATE accounts SET is_active = false WHERE id = :account_id"),
                {"account_id": manager.id},
            )
    inactive_manager = _run_cli(
        "account",
        "capability",
        "grant",
        "--email",
        "alice@example.test",
        "--capability",
        "project.create",
        "--granted-by",
        "manager@example.test",
    )

    assert inactive_manager.returncode == 2
    assert inactive_manager.stdout == ""
    assert inactive_manager.stderr.strip() == "账号操作失败"
    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        grant_count = await session.scalar(
            select(func.count()).select_from(XAgentAccountCapabilityGrant)
        )
    assert grant_count == 0


@pytest.mark.anyio
async def test_capability_cli_rejects_unknown_capability_without_writing(
    seeded_database,
) -> None:
    rejected = _run_cli(
        "account",
        "capability",
        "grant",
        "--email",
        "alice@example.test",
        "--capability",
        "project.delete",
        "--granted-by",
        "manager@example.test",
    )

    assert rejected.returncode == 2
    assert rejected.stdout == ""
    assert "project.delete" in rejected.stderr
    assert "xagent_account_capability_grants" not in rejected.stderr
    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        grant_count = await session.scalar(
            select(func.count()).select_from(XAgentAccountCapabilityGrant)
        )
    assert grant_count == 0
