"""Bots that work tasks (`can_work`): assigned, claim, take parts, hand back,
hear about their work in the app. Plain bots stay propose-only."""

from __future__ import annotations

import pytest

from app.models import Notification

HANDBACK = "Summary: login works\nChecks run: pytest, 12 passed\nLeft: nothing\n"


def _import(client, h, *tasks):
    r = client.post("/tasks/import", headers=h, json={"tasks": list(tasks)})
    assert r.status_code == 200, r.text
    return [row["id"] for row in r.json()]


def _bot(client, admin_h, handle, *, can_work, scopes=None):
    body = {"name": handle, "email": f"{handle}@bots.example.com", "account_type": "bot",
            "handle": handle, "sides": ["fe", "be"]}
    created = client.post("/users", headers=admin_h, json=body)
    assert created.status_code == 201, created.text
    bot_id = created.json()["id"]
    if can_work:
        r = client.patch(f"/users/{bot_id}", headers=admin_h, json={"can_work": True})
        assert r.status_code == 200 and r.json()["can_work"] is True, r.text
    token_body = {"name": "cs", "expires_days": 30}
    if scopes is not None:
        token_body["scopes"] = scopes
    token = client.post(f"/users/{bot_id}/tokens", headers=admin_h, json=token_body)
    assert token.status_code == 201, token.text
    return {"id": bot_id, "scopes": token.json()["scopes"],
            "headers": {"Authorization": f"Bearer {token.json()['token']}", "X-Agent": handle}}


@pytest.fixture()
def worker(client, auth, leader):
    return _bot(client, auth(leader), "qader-claude", can_work=True)


@pytest.fixture()
def plain(client, auth, leader):
    return _bot(client, auth(leader), "scanner", can_work=False)


class TestSwitch:
    def test_only_admins_toggle_it_and_only_on_bots(self, client, auth, leader, alice, plain):
        r = client.patch(f"/users/{plain['id']}", headers=auth(alice), json={"can_work": True})
        assert r.status_code == 403
        r = client.patch(f"/users/{alice.id}", headers=auth(leader), json={"can_work": True})
        assert r.status_code == 422
        r = client.patch(f"/users/{plain['id']}", headers=auth(leader), json={"can_work": True})
        assert r.status_code == 200 and r.json()["can_work"] is True

    def test_a_working_bot_gets_member_scopes_and_a_plain_bot_does_not(self, client, auth, leader, worker, plain):
        assert {"claims", "tasks:write", "docs:write", "git:write", "tasks:propose"} <= set(worker["scopes"])
        r = client.post(f"/users/{plain['id']}/tokens", headers=auth(leader),
                        json={"name": "x", "scopes": ["tasks:read", "claims"]})
        assert r.status_code == 422

    def test_switching_off_trims_the_tokens(self, client, auth, leader, worker, db_session):
        r = client.patch(f"/users/{worker['id']}", headers=auth(leader), json={"can_work": False})
        assert r.status_code == 200 and r.json()["can_work"] is False
        tokens = client.get(f"/users/{worker['id']}/tokens", headers=auth(leader)).json()
        assert set(tokens[0]["scopes"]) <= {"tasks:read", "tasks:propose", "comments:write"}

    def test_it_still_cannot_log_in(self, client, worker):
        r = client.post("/auth/login", json={"email": "qader-claude@bots.example.com", "password": "anything-at-all"})
        assert r.status_code == 401


class TestWork:
    def test_assignable_listed_and_told_in_the_app_only(self, client, auth, leader, worker, db_session):
        r = client.post("/tasks", headers=auth(leader),
                        json={"title": "Fix login", "status": "to_do", "assignee_1_id": worker["id"]})
        assert r.status_code == 201, r.text
        rows = db_session.query(Notification).filter_by(user_id=worker["id"]).all()
        assert [(n.kind.value, n.email_state) for n in rows] == [("assigned", "skipped")]
        members = client.get("/auth/users?role=member", headers=auth(leader)).json()
        mine = next(u for u in members if u["id"] == worker["id"])
        assert mine["account_type"] == "bot" and mine["can_work"] is True

    def test_claims_moves_comments_and_hands_back(self, client, auth, leader, worker):
        [tid] = _import(client, auth(leader), {"external_key": "QX-1", "title": "Imported", "side": "be"})
        r = client.post(f"/tasks/{tid}/claim", headers=worker["headers"], json={})
        assert r.status_code == 200, r.text
        assert r.json()["claimed_by"] == worker["id"] and r.json()["status"] == "in_progress"
        r = client.post(f"/tasks/{tid}/comments", headers=worker["headers"], json={"body": "Started on the view"})
        assert r.status_code == 201, r.text
        r = client.post(f"/tasks/{tid}/comments", headers=worker["headers"], json={"kind": "handback", "body": HANDBACK})
        assert r.status_code == 201, r.text
        r = client.post(f"/tasks/{tid}/docs", headers=worker["headers"], json={"title": "Notes", "body": "a"})
        assert r.status_code == 201, r.text
        r = client.patch(f"/tasks/{tid}/status", headers=worker["headers"], json={"status": "in_review"})
        assert r.status_code == 200, r.text

    def test_takes_a_part_and_files_subtasks_only_under_its_work(self, client, auth, leader, worker):
        [tid] = _import(client, auth(leader), {"external_key": "QX-2", "title": "Two parts", "side": "be",
                                               "criteria": ["Part one", "Part two"]})
        r = client.post(f"/tasks/{tid}/criteria/1/take", headers=worker["headers"], json={})
        assert r.status_code == 201, r.text
        sub = r.json()
        assert sub["claimed_by"] == worker["id"] and sub["parent_id"] == tid
        # A new top-level task is still a proposal.
        r = client.post("/tasks", headers=worker["headers"], json={"title": "Idea", "status": "to_do"})
        assert r.status_code == 201 and r.json()["status"] == "proposed"

    def test_comments_elsewhere_keep_the_bot_limits(self, client, worker, make_task):
        other = make_task(title="someone else's")
        r = client.post(f"/tasks/{other.id}/comments", headers=worker["headers"], json={"body": "hi"})
        assert r.status_code == 403


class TestPlainBotUnchanged:
    def test_not_assignable_and_cannot_claim_or_take(self, client, auth, leader, plain, db_session):
        r = client.post("/tasks", headers=auth(leader), json={"title": "x", "assignee_1_id": plain["id"]})
        assert r.status_code == 422
        [tid] = _import(client, auth(leader), {"external_key": "QX-3", "title": "Pool", "side": "be",
                                               "criteria": ["Part one"]})
        assert client.post(f"/tasks/{tid}/claim", headers=plain["headers"], json={}).status_code == 403
        assert client.post(f"/tasks/{tid}/criteria/1/take", headers=plain["headers"], json={}).status_code == 403
        members = client.get("/auth/users?role=member", headers=auth(leader)).json()
        assert plain["id"] not in [u["id"] for u in members]


def test_subtasks_only_under_work_it_holds(client, auth, leader, worker, make_task):
    [tid] = _import(client, auth(leader), {"external_key": "QX-4", "title": "Parent", "side": "be"})
    r = client.post("/tasks", headers=worker["headers"], json={"title": "Child", "parent_id": tid})
    assert r.status_code == 403  # not its work yet
    assert client.post(f"/tasks/{tid}/claim", headers=worker["headers"], json={}).status_code == 200
    r = client.post("/tasks", headers=worker["headers"], json={"title": "Child", "parent_id": tid})
    assert r.status_code == 201, r.text
    assert r.json()["status"] == "backlog" and r.json()["parent_id"] == tid


def test_can_work_on_create_is_for_bots_only(client, auth, leader):
    r = client.post("/users", headers=auth(leader), json={
        "name": "p", "email": "p@example.com", "password": "long-enough", "can_work": True})
    assert r.status_code == 422
    r = client.post("/users", headers=auth(leader), json={
        "name": "b", "email": "b@bots.example.com", "account_type": "bot", "can_work": True})
    assert r.status_code == 201 and r.json()["can_work"] is True
