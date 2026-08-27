from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError, ProgrammingError
from sqlalchemy.ext.asyncio import AsyncSession


async def _revision(engine, account_id) -> int | None:
    async with AsyncSession(engine, expire_on_commit=False) as session:
        return await session.scalar(
            text("SELECT revision FROM xagent_permission_revisions WHERE account_id = :account_id"),
            {"account_id": account_id},
        )


@pytest.mark.anyio
async def test_auth_schema_enforces_one_credential_and_unique_jti_per_account(
    seeded_database,
    alice,
) -> None:
    now = datetime.now(UTC)
    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        async with session.begin():
            await session.execute(
                text(
                    "INSERT INTO xagent_account_credentials "
                    "(account_id, password_hash, password_changed_at) "
                    "VALUES (:account_id, :password_hash, :changed_at)"
                ),
                {
                    "account_id": alice.id,
                    "password_hash": "$argon2id$v=19$fixture",
                    "changed_at": now,
                },
            )
            await session.execute(
                text(
                    "INSERT INTO xagent_auth_sessions "
                    "(id, account_id, jti_hash, created_at, expires_at) "
                    "VALUES (:id, :account_id, :jti_hash, :created_at, :expires_at)"
                ),
                {
                    "id": uuid4(),
                    "account_id": alice.id,
                    "jti_hash": "a" * 64,
                    "created_at": now,
                    "expires_at": now + timedelta(hours=8),
                },
            )

        with pytest.raises(IntegrityError):
            async with session.begin():
                await session.execute(
                    text(
                        "INSERT INTO xagent_account_credentials "
                        "(account_id, password_hash, password_changed_at) "
                        "VALUES (:account_id, :password_hash, :changed_at)"
                    ),
                    {
                        "account_id": alice.id,
                        "password_hash": "$argon2id$v=19$duplicate",
                        "changed_at": now,
                    },
                )

        with pytest.raises(IntegrityError):
            async with session.begin():
                await session.execute(
                    text(
                        "INSERT INTO xagent_auth_sessions "
                        "(id, account_id, jti_hash, created_at, expires_at) "
                        "VALUES (:id, :account_id, :jti_hash, :created_at, :expires_at)"
                    ),
                    {
                        "id": uuid4(),
                        "account_id": alice.id,
                        "jti_hash": "a" * 64,
                        "created_at": now,
                        "expires_at": now + timedelta(hours=8),
                    },
                )


@pytest.mark.anyio
async def test_auth_session_rejects_non_future_expiry(seeded_database, alice) -> None:
    now = datetime.now(UTC)
    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        with pytest.raises(IntegrityError):
            async with session.begin():
                await session.execute(
                    text(
                        "INSERT INTO xagent_auth_sessions "
                        "(id, account_id, jti_hash, created_at, expires_at) "
                        "VALUES (:id, :account_id, :jti_hash, :created_at, :expires_at)"
                    ),
                    {
                        "id": uuid4(),
                        "account_id": alice.id,
                        "jti_hash": "b" * 64,
                        "created_at": now,
                        "expires_at": now,
                    },
                )


@pytest.mark.anyio
async def test_account_email_is_unique_without_case_distinction(seeded_database) -> None:
    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        with pytest.raises(IntegrityError):
            async with session.begin():
                await session.execute(
                    text(
                        "INSERT INTO accounts (id, email, role, is_active) "
                        "VALUES (:id, 'ALICE@example.test', 'specialist', true)"
                    ),
                    {"id": uuid4()},
                )


@pytest.mark.anyio
async def test_permission_revision_tracks_account_role_and_status_changes(
    seeded_database,
    alice,
) -> None:
    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        assert await _revision(seeded_database, alice.id) == 1

        async with session.begin():
            await session.execute(
                text("UPDATE accounts SET role = 'manager' WHERE id = :account_id"),
                {"account_id": alice.id},
            )
        assert await _revision(seeded_database, alice.id) == 2

        async with session.begin():
            await session.execute(
                text("UPDATE accounts SET is_active = false WHERE id = :account_id"),
                {"account_id": alice.id},
            )
        assert await _revision(seeded_database, alice.id) == 3


@pytest.mark.anyio
async def test_permission_revision_tracks_membership_and_temporary_grant_changes(
    seeded_database,
    alice,
    bob,
    bob_project,
) -> None:
    membership_id = uuid4()
    grant_id = uuid4()
    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        async with session.begin():
            await session.execute(
                text(
                    "INSERT INTO project_memberships (id, project_id, account_id) "
                    "VALUES (:id, :project_id, :account_id)"
                ),
                {"id": membership_id, "project_id": bob_project.id, "account_id": alice.id},
            )
        assert await _revision(seeded_database, alice.id) == 2

        async with session.begin():
            await session.execute(
                text("DELETE FROM project_memberships WHERE id = :id"),
                {"id": membership_id},
            )
            await session.execute(
                text(
                    "INSERT INTO temporary_project_grants "
                    "(id, project_id, account_id, action, granted_by_id, expires_at) "
                    "VALUES (:id, :project_id, :account_id, 'read', :granted_by_id, :expires_at)"
                ),
                {
                    "id": grant_id,
                    "project_id": bob_project.id,
                    "account_id": alice.id,
                    "granted_by_id": bob.id,
                    "expires_at": datetime.now(UTC) + timedelta(hours=1),
                },
            )
        assert await _revision(seeded_database, alice.id) == 4

        async with session.begin():
            await session.execute(
                text("DELETE FROM temporary_project_grants WHERE id = :id"),
                {"id": grant_id},
            )
        assert await _revision(seeded_database, alice.id) == 5


@pytest.mark.anyio
async def test_auth_rows_prevent_hard_deleting_the_source_account(
    seeded_database,
    alice,
) -> None:
    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        with pytest.raises(IntegrityError):
            async with session.begin():
                await session.execute(
                    text("DELETE FROM accounts WHERE id = :account_id"),
                    {"account_id": alice.id},
                )


@pytest.mark.anyio
async def test_application_role_cannot_read_password_hashes(
    actor_session,
) -> None:
    with pytest.raises(ProgrammingError) as rejected:
        async with actor_session.begin_nested():
            await actor_session.execute(text("SELECT password_hash FROM xagent_account_credentials"))

    assert rejected.value.orig.sqlstate == "42501"
