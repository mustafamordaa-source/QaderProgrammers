"""One identity per agent on a shared worker bot (`ApiToken.agent_name`), the
right to post on work a bot did, the restricted marker in the brief and
oldest-first notifications."""

from __future__ import annotations

import pytest

from app.models import Notification

HANDBACK = "Summary: fixed\nChecks run: pytest, 3 passed\nLeft: nothing\n"


def _import(client, h, *tasks):
    r = client.post("/tasks/import", headers=h, json={"tasks": list(tasks)})
    assert r.status_code == 200, r.text
    return [row["id"] for row in r.json()]


@pytest.fixture()
def bot(client, auth, leader):
    """A worker bot with one token per agent and one old token without an agent name."""
    admin_h = auth(leader)
    created = client.post("/users", headers=admin_h, json={
        "name": "qader-claude", "email": "qc@bots.example.com", "account_type": "bot",
        "handle": "qader-claude", "sides": ["fe", "be"]})
    assert created.status_code == 201, created.text
    bot_id = created.json()["id"]
    assert client.patch(f"/users/{bot_id}", headers=admin_h, json={"can_work": True}).status_code == 200
    headers = {}
    for agent in ("cs-agent-a", "cs-agent-b", "cs-agent-d"):
        r = client.post(f"/users/{bot_id}/tokens", headers=admin_h,
                        json={"name": agent, "agent_name": agent, "expires_days": 30})
        assert r.status_code == 201, r.text
        assert r.json()["agent_name"] == agent
        headers[agent] = {"Authorization": f"Bearer {r.json()['token']}"}
    r = client.post(f"/users/{bot_id}/tokens", headers=admin_h, json={"name": "shared", "expires_days": 30})
    assert r.status_code == 201 and r.json()["agent_name"] is None
    headers["old"] = {"Authorization": f"Bearer {r.json()['token']}", "X-Agent": "qa-replier"}
    return {"id": bot_id, "h": headers}


def _claim(client, h, tid):
    return client.post(f"/tasks/{tid}/claim", headers=h, json={})


class TestTokens:
    def test_whoami_shows_the_fixed_agent_and_can_work(self, client, bot):
        me = client.get("/auth/whoami", headers=bot["h"]["cs-agent-a"]).json()
        assert me["agent"] == "cs-agent-a" and me["token"]["agent_name"] == "cs-agent-a"
        assert me["can_work"] is True

    def test_a_write_without_x_agent_uses_the_fixed_name(self, client, auth, leader, bot):
        [tid] = _import(client, auth(leader), {"external_key": "A-1", "title": "t", "side": "be"})
        r = _claim(client, bot["h"]["cs-agent-a"], tid)
        assert r.status_code == 200, r.text
        assert r.json()["claim_agent"] == "cs-agent-a"

    def test_a_different_x_agent_on_a_write_is_refused(self, client, auth, leader, bot):
        [tid] = _import(client, auth(leader), {"external_key": "A-2", "title": "t", "side": "be"})
        h = {**bot["h"]["cs-agent-a"], "X-Agent": "cs-agent-b"}
        r = _claim(client, h, tid)
        assert r.status_code == 400 and "belongs to agent 'cs-agent-a'" in r.json()["detail"]
        same = {**bot["h"]["cs-agent-a"], "X-Agent": "cs-agent-a"}
        assert _claim(client, same, tid).status_code == 200

    def test_people_cannot_bind_their_own_tokens(self, client, auth, alice):
        r = client.post("/auth/tokens", headers=auth(alice), json={"name": "x", "agent_name": "laptop"})
        assert r.status_code == 422

    def test_the_old_unbound_token_keeps_working(self, client, auth, leader, bot):
        [tid] = _import(client, auth(leader), {"external_key": "A-3", "title": "t", "side": "be"})
        r = _claim(client, bot["h"]["old"], tid)
        assert r.status_code == 200 and r.json()["claim_agent"] == "qa-replier"
        mine = client.get("/tasks?mine=true", headers=bot["h"]["old"]).json()
        assert [t["id"] for t in mine] == [tid]


class TestClaimsPerAgent:
    def test_another_agent_cannot_take_release_or_move_the_claim(self, client, auth, leader, bot):
        [tid] = _import(client, auth(leader), {"external_key": "B-1", "title": "t", "side": "be"})
        a, b = bot["h"]["cs-agent-a"], bot["h"]["cs-agent-b"]
        assert _claim(client, a, tid).status_code == 200
        r = _claim(client, b, tid)
        assert r.status_code == 409 and "cs-agent-a" in r.json()["detail"]
        r = client.post(f"/tasks/{tid}/release", headers=b)
        assert r.status_code == 403 and "cs-agent-a" in r.json()["detail"]
        r = client.patch(f"/tasks/{tid}/status", headers=b, json={"status": "blocked", "comment": "x"})
        assert r.status_code in (403, 409)
        r = client.patch(f"/tasks/{tid}", headers=b, json={"tags": ["x"]})
        assert r.status_code == 403
        # The holder still can.
        assert client.patch(f"/tasks/{tid}", headers=a, json={"tags": ["x"]}).status_code == 200
        assert client.post(f"/tasks/{tid}/release", headers=a).status_code == 200

    def test_mine_and_the_lock_column_follow_the_agent(self, client, auth, leader, bot):
        [t1, t2] = _import(client, auth(leader), {"external_key": "B-2", "title": "one", "side": "be"},
                           {"external_key": "B-3", "title": "two", "side": "be"})
        a, b = bot["h"]["cs-agent-a"], bot["h"]["cs-agent-b"]
        assert _claim(client, a, t1).status_code == 200
        assert _claim(client, b, t2).status_code == 200
        assert [t["id"] for t in client.get("/tasks?mine=true", headers=a).json()] == [t1]
        assert [t["id"] for t in client.get("/tasks?mine=true", headers=b).json()] == [t2]
        # The old shared token still sees both.
        assert sorted(t["id"] for t in client.get("/tasks?mine=true", headers=bot["h"]["old"]).json()) == [t1, t2]
        row = next(t for t in client.get("/tasks", headers=b).json() if t["id"] == t1)
        assert row["claim_block"] == "claimed" and "cs-agent-a" in row["claim_block_text"]
        brief = client.get(f"/tasks/{t1}/brief", headers=a).json()
        assert brief["claim_block"] is None and brief["claimable"] is False
        brief = client.get(f"/tasks/{t1}/brief", headers=b).json()
        assert brief["claim_block"] == "claimed"

    def test_assigned_work_shows_in_mine_until_another_agent_holds_it(self, client, auth, leader, bot):
        r = client.post("/tasks", headers=auth(leader),
                        json={"title": "queue", "status": "to_do", "side": "be", "assignee_1_id": bot["id"]})
        tid = r.json()["id"]
        a, b = bot["h"]["cs-agent-a"], bot["h"]["cs-agent-b"]
        assert tid in [t["id"] for t in client.get("/tasks?mine=true", headers=b).json()]
        assert _claim(client, a, tid).status_code == 200
        assert tid not in [t["id"] for t in client.get("/tasks?mine=true", headers=b).json()]
        assert tid in [t["id"] for t in client.get("/tasks?mine=true", headers=a).json()]


class TestBotPostsOnItsWork:
    def _hand_back(self, client, h, tid):
        assert _claim(client, h, tid).status_code == 200
        r = client.post(f"/tasks/{tid}/comments", headers=h, json={"kind": "handback", "body": HANDBACK})
        assert r.status_code == 201, r.text
        r = client.patch(f"/tasks/{tid}/status", headers=h, json={"status": "in_review"})
        assert r.status_code == 200, r.text

    def test_comments_and_asks_after_in_review_cleared_the_claim(self, client, auth, leader, bot):
        [tid] = _import(client, auth(leader), {"external_key": "C-1", "title": "t", "side": "be"})
        a = bot["h"]["cs-agent-a"]
        self._hand_back(client, a, tid)
        assert client.get(f"/tasks/{tid}", headers=a).json()["claimed_by"] is None
        r = client.post(f"/tasks/{tid}/comments", headers=a, json={"body": "Pushed the review fix"})
        assert r.status_code == 201, r.text
        r = client.post(f"/tasks/{tid}/comments", headers=a,
                        json={"kind": "question", "to": str(leader.id), "body": "Merge as is?"})
        assert r.status_code == 201, r.text

    def test_a_reviewer_agent_of_the_same_bot_may_post(self, client, auth, leader, bot):
        [tid] = _import(client, auth(leader), {"external_key": "C-2", "title": "t", "side": "be"})
        self._hand_back(client, bot["h"]["cs-agent-a"], tid)
        r = client.post(f"/tasks/{tid}/comments", headers=bot["h"]["cs-agent-d"],
                        json={"kind": "review", "body": "Review (cs-agent-d): APPROVED"})
        assert r.status_code == 201, r.text

    def test_after_release_the_bot_still_posts_until_the_task_closes(self, client, auth, leader, bot):
        [tid] = _import(client, auth(leader), {"external_key": "C-3", "title": "t", "side": "be"})
        a = bot["h"]["cs-agent-a"]
        assert _claim(client, a, tid).status_code == 200
        assert client.post(f"/tasks/{tid}/release", headers=a).status_code == 200
        assert client.post(f"/tasks/{tid}/comments", headers=a, json={"body": "Released: needs a lead"}).status_code == 201
        r = client.patch(f"/tasks/{tid}/status", headers=auth(leader), json={"status": "dropped", "comment": "dup"})
        assert r.status_code == 200, r.text
        r = client.post(f"/tasks/{tid}/comments", headers=a, json={"body": "late"})
        assert r.status_code == 403

    def test_untouched_task_gets_a_403_that_says_why(self, client, auth, leader, bot):
        [tid] = _import(client, auth(leader), {"external_key": "C-4", "title": "t", "side": "be"})
        r = client.post(f"/tasks/{tid}/comments", headers=bot["h"]["cs-agent-a"], json={"body": "hi"})
        assert r.status_code == 403
        detail = r.json()["detail"]
        assert f"HUB-{tid}" in detail and "Claim it first" in detail and "tagged the bot" in detail


class TestNotificationsPerAgent:
    def _unread(self, client, h):
        return client.get("/notifications?unread=true", headers=h).json()

    def test_a_reviewer_comment_reaches_the_agent_that_worked_it(self, client, auth, leader, bot):
        [tid] = _import(client, auth(leader), {"external_key": "D-1", "title": "t", "side": "be"})
        a, b, d = bot["h"]["cs-agent-a"], bot["h"]["cs-agent-b"], bot["h"]["cs-agent-d"]
        assert _claim(client, a, tid).status_code == 200
        assert client.post(f"/tasks/{tid}/comments", headers=a,
                           json={"kind": "handback", "body": HANDBACK}).status_code == 201
        assert client.patch(f"/tasks/{tid}/status", headers=a, json={"status": "in_review"}).status_code == 200
        r = client.post(f"/tasks/{tid}/comments", headers=d,
                        json={"kind": "review", "body": "Review (cs-agent-d): CHANGES REQUESTED"})
        assert r.status_code == 201, r.text
        assert r.json()["notified"] == ["qader-claude/cs-agent-a"]
        rows = self._unread(client, a)
        assert [(n["task_id"], n["agent_name"], n["for_agent"]) for n in rows] == [(tid, "cs-agent-d", "cs-agent-a")]
        assert self._unread(client, b) == [] and self._unread(client, d) == []
        # A's own comments do not ping A.
        client.post(f"/tasks/{tid}/comments", headers=a, json={"body": "on it"})
        assert len(self._unread(client, a)) == 1

    def test_read_state_is_per_agent(self, client, auth, leader, bot, db_session):
        db_session.query(Notification).delete()
        [tid] = _import(client, auth(leader), {"external_key": "D-2", "title": "t", "side": "be"})
        a = bot["h"]["cs-agent-a"]
        assert _claim(client, a, tid).status_code == 200
        r = client.post(f"/tasks/{tid}/comments", headers=auth(leader), json={"body": "@qader-claude please check"})
        assert r.status_code == 201, r.text
        assert set(r.json()["notified"]) == {"qader-claude", "qader-claude/cs-agent-a"}
        assert len(self._unread(client, a)) == 1
        assert len(self._unread(client, bot["h"]["old"])) == 1
        assert self._unread(client, bot["h"]["cs-agent-b"]) == []
        assert client.post("/notifications/read", headers=a, json={"all": True}).json()["marked"] == 1
        assert client.get("/notifications/count", headers=a).json()["unread"] == 0
        assert client.get("/notifications/count", headers=bot["h"]["old"]).json()["unread"] == 1

    def test_rejection_reaches_the_agent_whose_hand_back_it_was(self, client, auth, leader, bot):
        [tid] = _import(client, auth(leader), {"external_key": "D-3", "title": "t", "side": "be"})
        a = bot["h"]["cs-agent-a"]
        assert _claim(client, a, tid).status_code == 200
        assert client.post(f"/tasks/{tid}/comments", headers=a,
                           json={"kind": "handback", "body": HANDBACK}).status_code == 201
        assert client.patch(f"/tasks/{tid}/status", headers=a, json={"status": "in_review"}).status_code == 200
        r = client.patch(f"/tasks/{tid}/status", headers=auth(leader),
                         json={"status": "in_progress", "comment": "missing a test"})
        assert r.status_code == 200, r.text
        kinds = [n["kind"] for n in self._unread(client, a)]
        assert "rejected" in kinds
        assert self._unread(client, bot["h"]["cs-agent-b"]) == []


def test_notifications_oldest_first(client, auth, leader, alice, make_task):
    task = make_task(title="t")
    for i in range(3):
        r = client.post(f"/tasks/{task.id}/comments", headers=auth(leader), json={"body": f"@alice note {i}"})
        assert r.status_code == 201, r.text
    h = auth(alice)
    newest = client.get("/notifications", headers=h).json()
    oldest = client.get("/notifications?order=asc", headers=h).json()
    assert [n["id"] for n in oldest] == sorted(n["id"] for n in newest)
    assert [n["id"] for n in newest] == sorted((n["id"] for n in newest), reverse=True)
    page = client.get("/notifications?order=asc&page=1&page_size=2", headers=h).json()
    assert [n["id"] for n in page] == [n["id"] for n in oldest][:2]
    assert client.get("/notifications?order=sideways", headers=h).status_code == 422


def test_brief_and_rows_mark_restricted_and_lead_assigns(client, auth, leader, alice, make_task, db_session):
    task = make_task(title="secret", assignee_1=alice)
    task.restricted = True
    task.assign_only = True
    db_session.commit()
    brief = client.get(f"/tasks/{task.id}/brief", headers=auth(alice)).json()
    assert brief["restricted"] is True and brief["assign_only"] is True
    row = next(t for t in client.get("/tasks", headers=auth(alice)).json() if t["id"] == task.id)
    assert row["restricted"] is True and row["assign_only"] is True


def test_idle_and_freed_claims_reach_the_holding_agent(client, auth, leader, bot, db_session):
    from datetime import timedelta

    from app.claims import sweep
    from app.models import utcnow

    [tid] = _import(client, auth(leader), {"external_key": "E-1", "title": "t", "side": "be"})
    assert _claim(client, bot["h"]["cs-agent-b"], tid).status_code == 200
    now = utcnow()
    assert sweep(db_session, now + timedelta(hours=25))["reminded"] == 1
    assert sweep(db_session, now + timedelta(hours=49))["freed"] == 1
    rows = db_session.query(Notification).filter_by(user_id=bot["id"]).all()
    assert sorted((n.kind.value, n.for_agent) for n in rows) == [
        ("claim_freed", "cs-agent-b"), ("claim_idle", "cs-agent-b")]
