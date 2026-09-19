"""Login, token handling and the role-guard dependency."""

from __future__ import annotations

from app.security import create_access_token
from tests.conftest import PASSWORD


def test_login_returns_token_and_user(client, alice):
    response = client.post("/auth/login", json={"email": alice.email, "password": PASSWORD})
    assert response.status_code == 200
    body = response.json()
    assert body["token_type"] == "bearer"
    assert body["user"]["email"] == alice.email
    assert body["user"]["role"] == "programmer"
    assert "password_hash" not in body["user"]


def test_login_rejects_wrong_password(client, alice):
    response = client.post("/auth/login", json={"email": alice.email, "password": "nope"})
    assert response.status_code == 401


def test_login_does_not_reveal_unknown_accounts(client, alice):
    unknown = client.post("/auth/login", json={"email": "ghost@example.com", "password": "nope"})
    wrong = client.post("/auth/login", json={"email": alice.email, "password": "nope"})
    assert unknown.status_code == wrong.status_code == 401
    assert unknown.json() == wrong.json()


def test_me_requires_a_token(client):
    assert client.get("/auth/me").status_code == 401


def test_me_rejects_a_garbage_token(client):
    response = client.get("/auth/me", headers={"Authorization": "Bearer not-a-jwt"})
    assert response.status_code == 401


def test_me_rejects_an_expired_token(client, alice):
    token = create_access_token(alice.id, expires_minutes=-1)
    response = client.get("/auth/me", headers={"Authorization": f"Bearer {token}"})
    assert response.status_code == 401


def test_me_rejects_a_token_for_a_deleted_user(client, db_session, alice):
    token = create_access_token(alice.id)
    db_session.delete(alice)
    db_session.commit()
    response = client.get("/auth/me", headers={"Authorization": f"Bearer {token}"})
    assert response.status_code == 401


def test_role_guard_blocks_programmers_from_leader_routes(client, auth, alice):
    """Regression: the guard must 403, never fall through to query-param parsing."""
    headers = auth(alice)
    responses = {
        "/kpi/team": client.get("/kpi/team", headers=headers),
        "/kpi/programmer/1": client.get("/kpi/programmer/1", headers=headers),
        "/tasks": client.post("/tasks", headers=headers, json={"title": "x"}),
    }
    for path, response in responses.items():
        assert response.status_code == 403, f"{path} returned {response.status_code}"
        assert response.json()["detail"] == "This action requires role: leader"


def test_role_guard_allows_leaders(client, auth, leader):
    assert client.get("/kpi/team", headers=auth(leader)).status_code == 200
