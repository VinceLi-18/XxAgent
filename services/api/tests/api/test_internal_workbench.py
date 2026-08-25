from uuid import uuid4

import pytest
from argon2 import PasswordHasher
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

PASSWORD = "correct horse battery staple"
SERVICE_TOKEN = "xagent-test-service-token-00000001"


async def _login(client, engine, account, email: str) -> str:
    async with AsyncSession(engine, expire_on_commit=False) as session:
        async with session.begin():
            await session.execute(
                text(
                    "INSERT INTO xagent_account_credentials "
                    "(account_id, password_hash, password_changed_at) "
                    "VALUES (:account_id, :password_hash, CURRENT_TIMESTAMP)"
                ),
                {
                    "account_id": account.id,
                    "password_hash": PasswordHasher().hash(PASSWORD),
                },
            )
    response = await client.post(
        "/api/v1/auth/login",
        json={"email": email, "password": PASSWORD},
    )
    assert response.status_code == 200
    return response.json()["access_token"]


def _headers(token: str) -> dict[str, str]:
    return {
        "Authorization": f"Bearer {token}",
        "X-XAgent-Service-Token": SERVICE_TOKEN,
    }


@pytest.mark.anyio
async def test_bootstrap_returns_account_projects_context_and_session_summary(
    client,
    seeded_database,
    alice,
    alice_project,
    bob_project,
) -> None:
    token = await _login(client, seeded_database, alice, "alice@example.test")

    response = await client.post(
        "/internal/xagent/workbench/bootstrap",
        headers=_headers(token),
        json={"schema_version": 1},
    )

    assert response.status_code == 200
    assert response.json() == {
        "schema_version": 1,
        "account": {
            "id": str(alice.id),
            "email": "alice@example.test",
            "role": "specialist",
            "permission_revision": 1,
        },
        "capabilities": [],
        "context": {"kind": "workbench", "project_id": None},
        "projects": [
            {
                "id": str(alice_project.id),
                "name": "Alice project",
                "created_at": alice_project.created_at.isoformat(),
            }
        ],
        "session_summary": {
            "private_count": 0,
            "project_counts": {str(alice_project.id): 0},
        },
    }


@pytest.mark.anyio
async def test_context_selection_persists_an_authorized_project(
    client,
    seeded_database,
    alice,
    alice_project,
) -> None:
    token = await _login(client, seeded_database, alice, "alice@example.test")

    selected = await client.post(
        "/internal/xagent/workbench/context",
        headers=_headers(token),
        json={
            "schema_version": 1,
            "kind": "project",
            "project_id": str(alice_project.id),
        },
    )
    restored = await client.post(
        "/internal/xagent/workbench/bootstrap",
        headers=_headers(token),
        json={"schema_version": 1},
    )

    expected_context = {
        "kind": "project",
        "project_id": str(alice_project.id),
    }
    assert selected.status_code == 200
    assert selected.json() == {
        "schema_version": 1,
        "account_id": str(alice.id),
        "context": expected_context,
    }
    assert restored.json()["context"] == expected_context


@pytest.mark.anyio
async def test_context_selection_hides_inaccessible_and_missing_projects(
    client,
    seeded_database,
    alice,
    bob_project,
) -> None:
    token = await _login(client, seeded_database, alice, "alice@example.test")

    hidden = await client.post(
        "/internal/xagent/workbench/context",
        headers=_headers(token),
        json={
            "schema_version": 1,
            "kind": "project",
            "project_id": str(bob_project.id),
        },
    )
    missing = await client.post(
        "/internal/xagent/workbench/context",
        headers=_headers(token),
        json={
            "schema_version": 1,
            "kind": "project",
            "project_id": "00000000-0000-0000-0000-000000009999",
        },
    )

    assert hidden.status_code == 404
    assert hidden.json() == {"detail": {"code": "not-found"}}
    assert missing.status_code == 404
    assert missing.json() == {"detail": {"code": "not-found"}}


@pytest.mark.anyio
async def test_project_create_is_atomic_selects_context_and_replays_same_key(
    client,
    seeded_database,
    manager,
) -> None:
    token = await _login(client, seeded_database, manager, "manager@example.test")
    payload = {
        "schema_version": 1,
        "name": "New managed project",
        "idempotency_key": "manager-project-1",
    }

    created = await client.post(
        "/internal/xagent/projects",
        headers=_headers(token),
        json=payload,
    )
    switched_away = await client.post(
        "/internal/xagent/workbench/context",
        headers=_headers(token),
        json={"schema_version": 1, "kind": "workbench", "project_id": None},
    )
    replayed = await client.post(
        "/internal/xagent/projects",
        headers=_headers(token),
        json=payload,
    )

    assert created.status_code == 201
    assert switched_away.status_code == 200
    assert replayed.status_code == 200
    assert replayed.json() == created.json()
    body = created.json()
    assert body["schema_version"] == 1
    assert body["account_id"] == str(manager.id)
    assert body["project"]["name"] == "New managed project"
    assert body["context"] == {
        "kind": "project",
        "project_id": body["project"]["id"],
    }
    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        owner_id = await session.scalar(
            text("SELECT owner_id FROM projects WHERE id = :project_id"),
            {"project_id": body["project"]["id"]},
        )
    assert owner_id == manager.id

    bootstrap = await client.post(
        "/internal/xagent/workbench/bootstrap",
        headers=_headers(token),
        json={"schema_version": 1},
    )
    assert bootstrap.json()["context"] == body["context"]
    assert [project["id"] for project in bootstrap.json()["projects"]] == [
        body["project"]["id"]
    ]


@pytest.mark.anyio
async def test_project_detail_returns_only_visible_safe_fields(
    client,
    seeded_database,
    alice,
    alice_project,
    bob_project,
) -> None:
    token = await _login(client, seeded_database, alice, "alice@example.test")

    visible = await client.post(
        f"/internal/xagent/projects/{alice_project.id}",
        headers=_headers(token),
        json={"schema_version": 1},
    )
    hidden = await client.post(
        f"/internal/xagent/projects/{bob_project.id}",
        headers=_headers(token),
        json={"schema_version": 1},
    )

    assert visible.status_code == 200
    assert visible.json() == {
        "schema_version": 1,
        "account_id": str(alice.id),
        "project": {
            "id": str(alice_project.id),
            "name": "Alice project",
            "created_at": alice_project.created_at.isoformat(),
        },
        "access": {"can_edit": True},
        "session_summary": {"session_count": 0},
    }
    assert hidden.status_code == 404
    assert hidden.json() == {"detail": {"code": "not-found"}}
    assert "owner" not in visible.text
    assert "member" not in visible.text


@pytest.mark.anyio
async def test_bootstrap_repairs_a_project_preference_after_access_is_revoked(
    client,
    seeded_database,
    alice,
    bob_project,
) -> None:
    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        async with session.begin():
            await session.execute(
                text(
                    "INSERT INTO project_memberships "
                    "(id, project_id, account_id) VALUES (:id, :project_id, :account_id)"
                ),
                {"id": uuid4(), "project_id": bob_project.id, "account_id": alice.id},
            )
    token = await _login(client, seeded_database, alice, "alice@example.test")
    selected = await client.post(
        "/internal/xagent/workbench/context",
        headers=_headers(token),
        json={
            "schema_version": 1,
            "kind": "project",
            "project_id": str(bob_project.id),
        },
    )
    assert selected.status_code == 200

    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        async with session.begin():
            await session.execute(
                text(
                    "DELETE FROM project_memberships "
                    "WHERE project_id = :project_id AND account_id = :account_id"
                ),
                {"project_id": bob_project.id, "account_id": alice.id},
            )
    relogin = await client.post(
        "/api/v1/auth/login",
        json={"email": "alice@example.test", "password": PASSWORD},
    )
    repaired = await client.post(
        "/internal/xagent/workbench/bootstrap",
        headers=_headers(relogin.json()["access_token"]),
        json={"schema_version": 1},
    )

    assert relogin.status_code == 200
    assert repaired.status_code == 200
    assert repaired.json()["context"] == {"kind": "workbench", "project_id": None}
    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        stored = await session.execute(
            text(
                "SELECT context_kind, project_id FROM xagent_workbench_preferences "
                "WHERE account_id = :account_id"
            ),
            {"account_id": alice.id},
        )
    assert stored.one() == ("workbench", None)


@pytest.mark.anyio
async def test_bootstrap_keeps_two_accounts_projects_and_contexts_isolated(
    client,
    seeded_database,
    alice,
    bob,
    alice_project,
    bob_project,
) -> None:
    alice_token = await _login(client, seeded_database, alice, "alice@example.test")
    bob_token = await _login(client, seeded_database, bob, "bob@example.test")
    await client.post(
        "/internal/xagent/workbench/context",
        headers=_headers(alice_token),
        json={
            "schema_version": 1,
            "kind": "project",
            "project_id": str(alice_project.id),
        },
    )

    alice_bootstrap = await client.post(
        "/internal/xagent/workbench/bootstrap",
        headers=_headers(alice_token),
        json={"schema_version": 1},
    )
    bob_bootstrap = await client.post(
        "/internal/xagent/workbench/bootstrap",
        headers=_headers(bob_token),
        json={"schema_version": 1},
    )

    assert [project["id"] for project in alice_bootstrap.json()["projects"]] == [
        str(alice_project.id)
    ]
    assert alice_bootstrap.json()["context"]["project_id"] == str(alice_project.id)
    assert [project["id"] for project in bob_bootstrap.json()["projects"]] == [
        str(bob_project.id)
    ]
    assert bob_bootstrap.json()["context"] == {
        "kind": "workbench",
        "project_id": None,
    }


@pytest.mark.anyio
async def test_bootstrap_rejects_an_inactive_account(
    client,
    seeded_database,
    alice,
) -> None:
    token = await _login(client, seeded_database, alice, "alice@example.test")
    async with AsyncSession(seeded_database, expire_on_commit=False) as session:
        async with session.begin():
            await session.execute(
                text("UPDATE accounts SET is_active = false WHERE id = :account_id"),
                {"account_id": alice.id},
            )

    rejected = await client.post(
        "/internal/xagent/workbench/bootstrap",
        headers=_headers(token),
        json={"schema_version": 1},
    )

    assert rejected.status_code == 401
    assert rejected.json() == {"detail": {"code": "unauthenticated"}}


@pytest.mark.anyio
async def test_context_request_rejects_ambiguous_kind_and_project_combinations(
    client,
    seeded_database,
    alice,
    alice_project,
) -> None:
    token = await _login(client, seeded_database, alice, "alice@example.test")

    project_without_id = await client.post(
        "/internal/xagent/workbench/context",
        headers=_headers(token),
        json={"schema_version": 1, "kind": "project", "project_id": None},
    )
    workbench_with_id = await client.post(
        "/internal/xagent/workbench/context",
        headers=_headers(token),
        json={
            "schema_version": 1,
            "kind": "workbench",
            "project_id": str(alice_project.id),
        },
    )

    assert project_without_id.status_code == 422
    assert workbench_with_id.status_code == 422


@pytest.mark.anyio
async def test_workbench_routes_require_both_identities_and_supported_version(
    client,
    seeded_database,
    alice,
) -> None:
    token = await _login(client, seeded_database, alice, "alice@example.test")

    without_service = await client.post(
        "/internal/xagent/workbench/bootstrap",
        headers={"Authorization": f"Bearer {token}"},
        json={"schema_version": 1},
    )
    without_user = await client.post(
        "/internal/xagent/workbench/bootstrap",
        headers={"X-XAgent-Service-Token": SERVICE_TOKEN},
        json={"schema_version": 1},
    )
    unsupported = await client.post(
        "/internal/xagent/workbench/bootstrap",
        headers=_headers(token),
        json={"schema_version": 2},
    )

    assert without_service.status_code == 403
    assert without_user.status_code == 401
    assert unsupported.status_code == 400
    assert unsupported.json() == {"detail": {"code": "unsupported-version"}}
    assert token not in without_service.text + without_user.text + unsupported.text
