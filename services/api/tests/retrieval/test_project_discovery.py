from uuid import UUID

import pytest
from sqlalchemy import select

from app.core.db_context import set_actor_context
from app.core.security import Actor
from app.models.identity import Role
from app.models.project import Project
from app.models.xagent_session import XAgentSession

from app.services.retrieval import (
    RetrievalError,
    list_accessible_projects,
    normalize_retrieval_scope,
    resolve_scope,
)


PROJECT_A = UUID("00000000-0000-0000-0000-000000000401")
PROJECT_B = UUID("00000000-0000-0000-0000-000000000402")


def test_project_session_uses_only_its_fixed_project() -> None:
    scope = normalize_retrieval_scope(
        visibility="project",
        fixed_project_id=PROJECT_A,
        project_ids=None,
        include_private=False,
    )

    assert scope.project_ids == (PROJECT_A,)
    assert scope.include_private is False


@pytest.mark.parametrize(
    ("project_ids", "include_private"),
    [([PROJECT_A], False), (None, True)],
)
def test_project_session_rejects_caller_selected_scope(project_ids, include_private) -> None:
    with pytest.raises(RetrievalError, match="invalid-retrieval-scope"):
        normalize_retrieval_scope(
            visibility="project",
            fixed_project_id=PROJECT_A,
            project_ids=project_ids,
            include_private=include_private,
        )


def test_private_session_requires_explicit_bounded_scope_and_deduplicates() -> None:
    scope = normalize_retrieval_scope(
        visibility="private",
        fixed_project_id=None,
        project_ids=[PROJECT_B, PROJECT_A, PROJECT_B],
        include_private=True,
    )

    assert scope.project_ids == (PROJECT_A, PROJECT_B)
    assert scope.include_private is True

    with pytest.raises(RetrievalError, match="invalid-retrieval-scope"):
        normalize_retrieval_scope(
            visibility="private",
            fixed_project_id=None,
            project_ids=[],
            include_private=False,
        )


@pytest.mark.anyio
async def test_project_discovery_is_rls_visible_query_bounded_and_limited_to_twenty(
    actor_session,
    seeded_database,
    alice,
    bob,
) -> None:
    async with seeded_database.begin() as connection:
        for value in range(30):
            await connection.execute(
                Project.__table__.insert().values(
                    id=UUID(int=1000 + value),
                    name=f"Budget {value:02d}",
                    owner_id=alice.id if value < 25 else bob.id,
                )
            )
    await set_actor_context(actor_session, Actor(id=alice.id, role=Role.SPECIALIST))

    projects = await list_accessible_projects(actor_session, query="Budget")

    assert len(projects) == 20
    assert [item["name"] for item in projects] == [f"Budget {value:02d}" for value in range(20)]


@pytest.mark.anyio
async def test_private_scope_authorizes_every_project_before_retrieval(
    actor_session,
    alice,
    alice_private_xagent_session,
    alice_project,
    bob_project,
) -> None:
    await set_actor_context(actor_session, Actor(id=alice.id, role=Role.SPECIALIST))
    item = await actor_session.scalar(
        select(XAgentSession).where(XAgentSession.id == alice_private_xagent_session.id)
    )

    with pytest.raises(RetrievalError, match="session-not-found"):
        await resolve_scope(
            actor_session,
            actor_id=alice.id,
            session_item=item,
            project_ids=[alice_project.id, bob_project.id],
            include_private=False,
        )
    with pytest.raises(RetrievalError, match="invalid-retrieval-scope"):
        normalize_retrieval_scope(
            visibility="private",
            fixed_project_id=None,
            project_ids=[UUID(int=value) for value in range(1, 22)],
            include_private=False,
        )
