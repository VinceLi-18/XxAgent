from datetime import datetime

import pytest


@pytest.mark.anyio
async def test_specialist_lists_only_accessible_projects(
    api_client, alice_token, alice_project, bob_project
):
    response = await api_client.get(
        "/api/v1/projects", headers={"Authorization": f"Bearer {alice_token}"}
    )

    assert response.status_code == 200
    project = response.json()[0]
    assert set(project) == {"id", "name", "created_at"}
    assert project["id"] == str(alice_project.id)
    assert project["name"] == "Alice project"
    assert datetime.fromisoformat(project["created_at"].replace("Z", "+00:00")) == alice_project.created_at


@pytest.mark.anyio
async def test_manager_lists_the_project_shared_domain(
    api_client, manager_token, alice_project, bob_project
):
    response = await api_client.get(
        "/api/v1/projects", headers={"Authorization": f"Bearer {manager_token}"}
    )

    assert response.status_code == 200
    assert [item["id"] for item in response.json()] == [
        str(alice_project.id),
        str(bob_project.id),
    ]


@pytest.mark.anyio
async def test_hidden_project_detail_is_not_found(api_client, alice_token, bob_project):
    response = await api_client.get(
        f"/api/v1/projects/{bob_project.id}",
        headers={"Authorization": f"Bearer {alice_token}"},
    )

    assert response.status_code == 404
    assert response.json() == {"detail": "Not found"}


@pytest.mark.anyio
async def test_create_project_assigns_the_authenticated_actor_as_owner(api_client, alice_token):
    response = await api_client.post(
        "/api/v1/projects",
        headers={"Authorization": f"Bearer {alice_token}"},
        json={"name": "  New project  "},
    )

    assert response.status_code == 201
    assert response.json()["name"] == "New project"

    detail = await api_client.get(
        f"/api/v1/projects/{response.json()['id']}",
        headers={"Authorization": f"Bearer {alice_token}"},
    )
    assert detail.status_code == 200


@pytest.mark.anyio
async def test_create_project_rejects_blank_name(api_client, alice_token):
    response = await api_client.post(
        "/api/v1/projects",
        headers={"Authorization": f"Bearer {alice_token}"},
        json={"name": "   "},
    )

    assert response.status_code == 422


@pytest.mark.anyio
async def test_create_project_rejects_client_supplied_owner(api_client, alice_token, bob):
    response = await api_client.post(
        "/api/v1/projects",
        headers={"Authorization": f"Bearer {alice_token}"},
        json={"name": "Wrong owner", "owner_id": str(bob.id)},
    )

    assert response.status_code == 422
