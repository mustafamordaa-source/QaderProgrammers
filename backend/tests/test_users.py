"""Leader-only user management, and the guards that keep the system usable."""

from __future__ import annotations

import pytest

from app.models import Role, TaskStatus, User
from tests.conftest import PASSWORD, make_user


def _create(client, headers, **overrides):
    payload = {
        "name": "New Person",
        "email": "new@example.com",
        "password": "a-good-password",
        "role": "programmer",
    }
    payload.update(overrides)
    return client.post("/users", headers=headers, json=payload)


class TestAccess:
    def test_programmers_cannot_reach_any_user_route(self, client, auth, alice, bob):
        headers = auth(alice)
        responses = {
            "list": client.get("/users", headers=headers),
            "create": client.post("/users", headers=headers, json={}),
            "update": client.patch(f"/users/{bob.id}", headers=headers, json={"name": "x"}),
            "password": client.post(
                f"/users/{bob.id}/password", headers=headers, json={"password": "another-one"}
            ),
        }
        for name, response in responses.items():
            assert response.status_code == 403, f"{name} returned {response.status_code}"

    def test_unauthenticated_requests_are_rejected(self, client):
        assert client.get("/users").status_code == 401


class TestListing:
    def test_leader_sees_everyone_including_deactivated(
        self, client, auth, leader, alice, db_session
    ):
        alice.is_active = False
        db_session.commit()
        rows = client.get("/users", headers=auth(leader)).json()
        assert {row["email"] for row in rows} == {leader.email, alice.email}
        assert {row["email"]: row["is_active"] for row in rows}[alice.email] is False

    def test_inactive_can_be_filtered_out(self, client, auth, leader, alice, db_session):
        alice.is_active = False
        db_session.commit()
        rows = client.get("/users?include_inactive=false", headers=auth(leader)).json()
        assert [row["email"] for row in rows] == [leader.email]

    def test_open_task_count_is_reported(self, client, auth, leader, alice, bob, make_task):
        make_task(assignee_1=alice)
        make_task(assignee_1=alice, assignee_2=bob)
        make_task(assignee_1=alice, status=TaskStatus.done)
        rows = {row["email"]: row["open_task_count"] for row in client.get("/users", headers=auth(leader)).json()}
        # A shared task counts for both people; the completed one counts for nobody.
        assert rows[alice.email] == 2
        assert rows[bob.email] == 1

    def test_no_password_hash_is_ever_returned(self, client, auth, leader):
        rows = client.get("/users", headers=auth(leader)).json()
        assert all("password_hash" not in row for row in rows)


class TestCreate:
    def test_leader_creates_a_programmer_who_can_log_in(self, client, auth, leader):
        response = _create(client, auth(leader))
        assert response.status_code == 201
        assert response.json()["is_active"] is True
        assert response.json()["role"] == "programmer"

        login = client.post(
            "/auth/login", json={"email": "new@example.com", "password": "a-good-password"}
        )
        assert login.status_code == 200

    def test_email_is_normalised_to_lowercase(self, client, auth, leader):
        response = _create(client, auth(leader), email="MiXeD@Example.COM")
        assert response.json()["email"] == "mixed@example.com"
        assert (
            client.post(
                "/auth/login", json={"email": "mixed@example.com", "password": "a-good-password"}
            ).status_code
            == 200
        )

    def test_duplicate_email_is_a_conflict(self, client, auth, leader, alice):
        response = _create(client, auth(leader), email=alice.email)
        assert response.status_code == 409

    def test_duplicate_email_is_caught_regardless_of_case(self, client, auth, leader, alice):
        response = _create(client, auth(leader), email=alice.email.upper())
        assert response.status_code == 409

    def test_a_leader_can_be_created(self, client, auth, leader):
        response = _create(client, auth(leader), email="lead2@example.com", role="leader")
        assert response.status_code == 201
        assert response.json()["role"] == "leader"

    @pytest.mark.parametrize(
        "override",
        [
            {"password": "short"},
            {"email": "not-an-email"},
            {"name": "   "},
            {"role": "wizard"},
        ],
    )
    def test_invalid_input_is_rejected(self, client, auth, leader, override):
        assert _create(client, auth(leader), **override).status_code == 422


class TestUpdate:
    def test_leader_edits_name_and_email(self, client, auth, leader, alice):
        response = client.patch(
            f"/users/{alice.id}",
            headers=auth(leader),
            json={"name": "Alice Renamed", "email": "alice.new@example.com"},
        )
        assert response.status_code == 200
        assert response.json()["name"] == "Alice Renamed"
        assert response.json()["email"] == "alice.new@example.com"

    def test_taking_someone_elses_email_is_a_conflict(self, client, auth, leader, alice, bob):
        response = client.patch(
            f"/users/{alice.id}", headers=auth(leader), json={"email": bob.email}
        )
        assert response.status_code == 409

    def test_keeping_your_own_email_is_not_a_conflict(self, client, auth, leader, alice):
        response = client.patch(
            f"/users/{alice.id}", headers=auth(leader), json={"email": alice.email}
        )
        assert response.status_code == 200

    def test_a_programmer_can_be_promoted(self, client, auth, leader, alice):
        response = client.patch(f"/users/{alice.id}", headers=auth(leader), json={"role": "leader"})
        assert response.json()["role"] == "leader"

    def test_missing_user_is_404(self, client, auth, leader):
        assert client.patch("/users/4242", headers=auth(leader), json={"name": "x"}).status_code == 404


class TestDeactivation:
    def test_deactivating_blocks_login(self, client, auth, leader, alice):
        client.patch(f"/users/{alice.id}", headers=auth(leader), json={"is_active": False})
        response = client.post("/auth/login", json={"email": alice.email, "password": PASSWORD})
        assert response.status_code == 401

    def test_deactivating_revokes_a_token_already_issued(
        self, client, auth, leader, alice
    ):
        """Blocking future logins is not enough — the session they hold must die."""
        alice_headers = auth(alice)
        assert client.get("/auth/me", headers=alice_headers).status_code == 200

        client.patch(f"/users/{alice.id}", headers=auth(leader), json={"is_active": False})

        assert client.get("/auth/me", headers=alice_headers).status_code == 403
        assert client.get("/tasks", headers=alice_headers).status_code == 403

    def test_deactivating_someone_with_open_tasks_is_allowed(
        self, client, auth, leader, alice, make_task
    ):
        make_task(assignee_1=alice)
        response = client.patch(
            f"/users/{alice.id}", headers=auth(leader), json={"is_active": False}
        )
        assert response.status_code == 200
        assert response.json()["open_task_count"] == 1

    def test_their_tasks_keep_the_assignee_so_history_survives(
        self, client, auth, leader, alice, make_task
    ):
        task = make_task(assignee_1=alice)
        client.patch(f"/users/{alice.id}", headers=auth(leader), json={"is_active": False})
        detail = client.get(f"/tasks/{task.id}", headers=auth(leader)).json()
        assert detail["assignee_1_id"] == alice.id

    def test_reactivating_restores_access(self, client, auth, leader, alice):
        client.patch(f"/users/{alice.id}", headers=auth(leader), json={"is_active": False})
        client.patch(f"/users/{alice.id}", headers=auth(leader), json={"is_active": True})
        assert (
            client.post("/auth/login", json={"email": alice.email, "password": PASSWORD}).status_code
            == 200
        )

    def test_deactivated_people_leave_the_assignment_directory(
        self, client, auth, leader, alice, bob
    ):
        client.patch(f"/users/{alice.id}", headers=auth(leader), json={"is_active": False})
        directory = client.get("/auth/users?role=programmer", headers=auth(leader)).json()
        assert [person["email"] for person in directory] == [bob.email]

    def test_tasks_cannot_be_assigned_to_a_deactivated_person(
        self, client, auth, leader, alice, make_task
    ):
        client.patch(f"/users/{alice.id}", headers=auth(leader), json={"is_active": False})
        created = client.post(
            "/tasks", headers=auth(leader), json={"title": "x", "assignee_1_id": alice.id}
        )
        assert created.status_code == 422

        task = make_task()
        reassigned = client.patch(
            f"/tasks/{task.id}/assign", headers=auth(leader), json={"assignee_1_id": alice.id}
        )
        assert reassigned.status_code == 422


class TestLastLeaderGuard:
    """Nothing may leave the system with no active leader — there would be no
    way to approve work or restore access."""

    def test_the_only_leader_cannot_be_deactivated(self, client, auth, leader):
        response = client.patch(
            f"/users/{leader.id}", headers=auth(leader), json={"is_active": False}
        )
        assert response.status_code == 409
        assert "only active leader" in response.json()["detail"]

    def test_the_only_leader_cannot_be_demoted(self, client, auth, leader):
        response = client.patch(
            f"/users/{leader.id}", headers=auth(leader), json={"role": "programmer"}
        )
        assert response.status_code == 409

    def test_handover_works_once_a_second_leader_exists(self, client, auth, leader, alice):
        client.patch(f"/users/{alice.id}", headers=auth(leader), json={"role": "leader"})
        response = client.patch(
            f"/users/{leader.id}", headers=auth(leader), json={"role": "programmer"}
        )
        assert response.status_code == 200
        assert response.json()["role"] == "programmer"

    def test_a_deactivated_leader_does_not_count_as_cover(
        self, client, auth, leader, alice, db_session
    ):
        second = make_user(db_session, "Second", "second@example.com", Role.leader)
        client.patch(f"/users/{second.id}", headers=auth(leader), json={"is_active": False})
        response = client.patch(
            f"/users/{leader.id}", headers=auth(leader), json={"is_active": False}
        )
        assert response.status_code == 409

    def test_demoting_a_non_last_leader_is_fine(self, client, auth, leader, db_session):
        second = make_user(db_session, "Second", "second@example.com", Role.leader)
        response = client.patch(
            f"/users/{second.id}", headers=auth(leader), json={"role": "programmer"}
        )
        assert response.status_code == 200

    def test_a_programmer_edit_is_never_blocked_by_the_guard(self, client, auth, leader, alice):
        response = client.patch(
            f"/users/{alice.id}", headers=auth(leader), json={"is_active": False}
        )
        assert response.status_code == 200


class TestPasswordReset:
    def test_reset_replaces_the_password(self, client, auth, leader, alice):
        response = client.post(
            f"/users/{alice.id}/password", headers=auth(leader), json={"password": "brand-new-pass"}
        )
        assert response.status_code == 200

        assert (
            client.post("/auth/login", json={"email": alice.email, "password": PASSWORD}).status_code
            == 401
        )
        assert (
            client.post(
                "/auth/login", json={"email": alice.email, "password": "brand-new-pass"}
            ).status_code
            == 200
        )

    def test_short_passwords_are_rejected(self, client, auth, leader, alice):
        response = client.post(
            f"/users/{alice.id}/password", headers=auth(leader), json={"password": "short"}
        )
        assert response.status_code == 422

    def test_resetting_a_missing_user_is_404(self, client, auth, leader):
        response = client.post(
            "/users/4242/password", headers=auth(leader), json={"password": "long-enough-pass"}
        )
        assert response.status_code == 404
