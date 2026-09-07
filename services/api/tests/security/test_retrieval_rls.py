import asyncio
from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession

from app.core.db_context import set_actor_context
from app.core.security import Actor
from app.models.identity import Role


async def _seed_chunk(engine: AsyncEngine, account_id: UUID) -> tuple[UUID, UUID]:
    artifact_id = uuid4()
    version_id = uuid4()
    index_id = uuid4()
    chunk_id = uuid4()
    embedding = "[0" + ",0" * 1023 + "]"
    async with engine.begin() as connection:
        await connection.execute(
            text(
                "INSERT INTO artifacts (id, filename, owner_id, created_by_id) "
                "VALUES (:artifact_id, 'visible.txt', :account_id, :account_id)"
            ),
            {"artifact_id": artifact_id, "account_id": account_id},
        )
        await connection.execute(
            text(
                "INSERT INTO artifact_versions "
                "(id, artifact_id, owner_id, version_number, original_filename, uploaded_by_id, "
                "declared_size, actual_size, detected_content_type, scan_status, object_key, size, "
                "content_type, sha256) "
                "VALUES (:version_id, :artifact_id, :account_id, 1, 'visible.txt', :account_id, "
                "1, 1, 'text/plain', 'clean', :object_key, 1, 'text/plain', :sha256)"
            ),
            {
                "artifact_id": artifact_id,
                "version_id": version_id,
                "account_id": account_id,
                "object_key": f"artifacts/{artifact_id}/{version_id}",
                "sha256": "0" * 64,
            },
        )
        await connection.execute(
            text(
                "INSERT INTO artifact_text_indexes "
                "(id, artifact_id, version_id, generation, content_sha256, parser_revision, "
                "embedding_model, embedding_revision, vector_dimensions, configuration_fingerprint, status) "
                "VALUES (:index_id, :artifact_id, :version_id, 1, :sha256, 'parser-1', 'bge-m3', "
                "'revision-1', 1024, :fingerprint, 'building')"
            ),
            {
                "index_id": index_id,
                "artifact_id": artifact_id,
                "version_id": version_id,
                "sha256": "1" * 64,
                "fingerprint": "2" * 64,
            },
        )
        await connection.execute(
            text(
                "INSERT INTO artifact_text_chunks "
                "(id, index_id, ordinal, line_start, line_end, text, token_count, text_sha256, embedding) "
                "VALUES (:chunk_id, :index_id, 0, 1, 1, 'retrieval text', 1, :sha256, "
                "CAST(:embedding AS vector))"
            ),
            {"chunk_id": chunk_id, "index_id": index_id, "sha256": "3" * 64, "embedding": embedding},
        )
    return artifact_id, chunk_id


@pytest.mark.anyio
async def test_retrieval_rls_hides_chunks_of_another_accounts_private_artifacts(
    seeded_database: AsyncEngine,
    actor_session: AsyncSession,
    alice,
    bob,
) -> None:
    _, alice_chunk_id = await _seed_chunk(seeded_database, alice.id)
    _, bob_chunk_id = await _seed_chunk(seeded_database, bob.id)

    await set_actor_context(actor_session, Actor(id=alice.id, role=Role.SPECIALIST))
    chunk_ids = set(
        await actor_session.scalars(
            text("SELECT id FROM artifact_text_chunks WHERE id IN (:alice_id, :bob_id)").bindparams(
                alice_id=alice_chunk_id,
                bob_id=bob_chunk_id,
            )
        )
    )

    assert chunk_ids == {alice_chunk_id}


@pytest.mark.anyio
async def test_retrieval_rls_allows_project_members_to_read_shared_chunks(
    seeded_database: AsyncEngine,
    actor_session: AsyncSession,
    alice,
    bob,
    alice_project,
) -> None:
    artifact_id = uuid4()
    version_id = uuid4()
    index_id = uuid4()
    chunk_id = uuid4()
    embedding = "[0" + ",0" * 1023 + "]"
    async with seeded_database.begin() as connection:
        await connection.execute(
            text(
                "INSERT INTO project_memberships (id, project_id, account_id) "
                "VALUES (:id, :project_id, :account_id)"
            ),
            {"id": uuid4(), "project_id": alice_project.id, "account_id": bob.id},
        )
        await connection.execute(
            text(
                "INSERT INTO artifacts (id, filename, project_id, created_by_id) "
                "VALUES (:artifact_id, 'project.txt', :project_id, :account_id)"
            ),
            {"artifact_id": artifact_id, "project_id": alice_project.id, "account_id": alice.id},
        )
        await connection.execute(
            text(
                "INSERT INTO artifact_versions "
                "(id, artifact_id, project_id, version_number, original_filename, uploaded_by_id, "
                "declared_size, actual_size, detected_content_type, scan_status, object_key, size, "
                "content_type, sha256) "
                "VALUES (:version_id, :artifact_id, :project_id, 1, 'project.txt', :account_id, "
                "1, 1, 'text/plain', 'clean', :object_key, 1, 'text/plain', :sha256)"
            ),
            {
                "artifact_id": artifact_id,
                "version_id": version_id,
                "project_id": alice_project.id,
                "account_id": alice.id,
                "object_key": f"artifacts/{artifact_id}/{version_id}",
                "sha256": "0" * 64,
            },
        )
        await connection.execute(
            text(
                "INSERT INTO artifact_text_indexes "
                "(id, artifact_id, version_id, generation, content_sha256, parser_revision, "
                "embedding_model, embedding_revision, vector_dimensions, configuration_fingerprint, status) "
                "VALUES (:index_id, :artifact_id, :version_id, 1, :sha256, 'parser-1', 'bge-m3', "
                "'revision-1', 1024, :fingerprint, 'building')"
            ),
            {
                "index_id": index_id,
                "artifact_id": artifact_id,
                "version_id": version_id,
                "sha256": "1" * 64,
                "fingerprint": "2" * 64,
            },
        )
        await connection.execute(
            text(
                "INSERT INTO artifact_text_chunks "
                "(id, index_id, ordinal, line_start, line_end, text, token_count, text_sha256, embedding) "
                "VALUES (:chunk_id, :index_id, 0, 1, 1, 'project retrieval text', 1, :sha256, "
                "CAST(:embedding AS vector))"
            ),
            {"chunk_id": chunk_id, "index_id": index_id, "sha256": "3" * 64, "embedding": embedding},
        )

    await set_actor_context(actor_session, Actor(id=bob.id, role=Role.SPECIALIST))
    assert await actor_session.scalar(
        text("SELECT id FROM artifact_text_chunks WHERE id = :chunk_id"), {"chunk_id": chunk_id}
    ) == chunk_id


@pytest.mark.anyio
async def test_read_only_grant_can_reserve_ordinals_without_session_update_privilege(
    seeded_database: AsyncEngine, actor_session: AsyncSession, alice, bob, alice_project
) -> None:
    session_id = uuid4()
    async with seeded_database.begin() as connection:
        await connection.execute(
            text(
                "INSERT INTO temporary_project_grants "
                "(id, project_id, account_id, action, granted_by_id, expires_at) "
                "VALUES (:id, :project, :account, 'read', :grantor, :expires)"
            ),
            {
                "id": uuid4(), "project": alice_project.id, "account": bob.id,
                "grantor": alice.id, "expires": datetime.now(UTC) + timedelta(hours=1),
            },
        )
        await connection.execute(
            text(
                "INSERT INTO xagent_sessions "
                "(id, owner_id, project_id, visibility, permission_revision_created, title, "
                "archived, last_event_sequence, next_citation_ordinal, version) "
                "VALUES (:id, :owner, :project, 'project', 1, 'read-only', false, -1, 1, 1)"
            ),
            {"id": session_id, "owner": alice.id, "project": alice_project.id},
        )

    await set_actor_context(actor_session, Actor(id=bob.id, role=Role.SPECIALIST))
    assert await actor_session.scalar(
        text("SELECT public.xagent_reserve_citation_ordinals(:id, 2)"), {"id": session_id}
    ) == 1
    result = await actor_session.execute(
        text("UPDATE xagent_sessions SET next_citation_ordinal = 99 WHERE id = :id"),
        {"id": session_id},
    )
    assert result.rowcount == 0


@pytest.mark.anyio
async def test_read_only_grant_can_lock_ordinal_base_without_session_update_privilege(
    seeded_database: AsyncEngine, actor_session: AsyncSession, alice, bob, alice_project
) -> None:
    session_id = uuid4()
    async with seeded_database.begin() as connection:
        await connection.execute(
            text(
                "INSERT INTO temporary_project_grants "
                "(id, project_id, account_id, action, granted_by_id, expires_at) "
                "VALUES (:id, :project, :account, 'read', :grantor, :expires)"
            ),
            {
                "id": uuid4(), "project": alice_project.id, "account": bob.id,
                "grantor": alice.id, "expires": datetime.now(UTC) + timedelta(hours=1),
            },
        )
        await connection.execute(
            text(
                "INSERT INTO xagent_sessions "
                "(id, owner_id, project_id, visibility, permission_revision_created, title, "
                "archived, last_event_sequence, next_citation_ordinal, version) "
                "VALUES (:id, :owner, :project, 'project', 1, 'read-only', false, -1, 7, 1)"
            ),
            {"id": session_id, "owner": alice.id, "project": alice_project.id},
        )

    await set_actor_context(actor_session, Actor(id=bob.id, role=Role.SPECIALIST))
    assert await actor_session.scalar(
        text("SELECT public.xagent_citation_ordinal_base(:id)"), {"id": session_id}
    ) == 7
    result = await actor_session.execute(
        text("UPDATE xagent_sessions SET next_citation_ordinal = 99 WHERE id = :id"),
        {"id": session_id},
    )
    assert result.rowcount == 0


@pytest.mark.anyio
async def test_retrieval_authorization_finalizer_validates_revision_and_every_project(
    actor_session: AsyncSession, alice, alice_project, bob_project, alice_private_xagent_session
) -> None:
    await set_actor_context(actor_session, Actor(id=alice.id, role=Role.SPECIALIST))

    assert await actor_session.scalar(
        text(
            "SELECT public.xagent_finalize_retrieval_authorization"
            "(:session_id, 1, CAST(:projects AS uuid[]))"
        ),
        {"session_id": alice_private_xagent_session.id, "projects": [alice_project.id]},
    ) is True
    assert await actor_session.scalar(
        text(
            "SELECT public.xagent_finalize_retrieval_authorization"
            "(:session_id, 2, CAST(:projects AS uuid[]))"
        ),
        {"session_id": alice_private_xagent_session.id, "projects": [alice_project.id]},
    ) is False
    assert await actor_session.scalar(
        text(
            "SELECT public.xagent_finalize_retrieval_authorization"
            "(:session_id, 1, CAST(:projects AS uuid[]))"
        ),
        {"session_id": alice_private_xagent_session.id, "projects": [alice_project.id, bob_project.id]},
    ) is False


@pytest.mark.anyio
async def test_concurrent_citation_reservations_are_unique(
    seeded_database: AsyncEngine, alice, alice_private_xagent_session, application_role
) -> None:
    async def reserve() -> int:
        async with AsyncSession(seeded_database, expire_on_commit=False) as session:
            async with session.begin():
                quoted_role = session.get_bind().dialect.identifier_preparer.quote(application_role)
                await session.execute(text(f"SET LOCAL ROLE {quoted_role}"))
                await set_actor_context(session, Actor(id=alice.id, role=Role.SPECIALIST))
                value = await session.scalar(
                    text("SELECT public.xagent_reserve_citation_ordinals(:id, 1)"),
                    {"id": alice_private_xagent_session.id},
                )
                assert isinstance(value, int)
                return value

    assert sorted(await asyncio.gather(reserve(), reserve())) == [1, 2]
