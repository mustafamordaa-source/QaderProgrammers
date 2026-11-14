"""Paged lists, the bulk import and the "waiting on a decision" view."""

from __future__ import annotations

from datetime import datetime, timedelta

import pytest

from app.config import settings
from app.models import Comment, CommentKind, Notification, NotifyKind, Role, Task, TaskEvent, TaskStatus
from tests.conftest import make_user


@pytest.fixture()
def token(client, auth):
    def _token(user, *, scopes=None, agent="import-agent"):
        body = {"name": "import", "expires_days": 7}
        if scopes is not None:
            body["scopes"] = scopes
        response = client.post("/auth/tokens", headers=auth(user), json=body)
        assert response.status_code == 201, response.text
        return {"Authorization": f"Bearer {response.json()['token']}", "X-Agent": agent}

    return _token


@pytest.fixture()
def many(make_task):
    """45 to_do tasks; several share one creation time, so only the id orders them."""
    start = datetime(2026, 1, 1, 9, 0, 0)
    return [
        make_task(title=f"Task {n:02d}", created_at=start + timedelta(minutes=n // 5), points=1)
        for n in range(45)
    ]


# --- paging -------------------------------------------------------------------


class TestTaskPaging:
    def test_no_paging_params_keeps_the_old_answer(self, client, auth, leader, many):
        r = client.get("/tasks", headers=auth(leader))
        assert r.status_code == 200
        assert len(r.json()) == 45
        assert "x-total-count" not in r.headers
        assert len(client.get("/tasks?limit=7", headers=auth(leader)).json()) == 7

    def test_page_alone_uses_the_default_size_and_sets_headers(self, client, auth, leader, many):
        r = client.get("/tasks?page=1", headers=auth(leader))
        assert len(r.json()) == 20
        assert r.headers["x-total-count"] == "45"
        assert r.headers["x-page"] == "1"
        assert r.headers["x-page-size"] == "20"
        assert r.headers["x-total-pages"] == "3"
        assert r.headers["x-total-points"] == "45"

    def test_pages_cover_every_row_once(self, client, auth, leader, many):
        h = auth(leader)
        ids = []
        for page in (1, 2, 3, 4):
            ids += [t["id"] for t in client.get(f"/tasks?page={page}&page_size=20", headers=h).json()]
        assert len(ids) == 45 and len(set(ids)) == 45
        assert ids == [t["id"] for t in client.get("/tasks", headers=h).json()]

    def test_page_size_is_capped(self, client, auth, leader, many):
        h = auth(leader)
        assert client.get("/tasks?page_size=101", headers=h).status_code == 422
        assert client.get("/tasks?page=0", headers=h).status_code == 422
        r = client.get("/tasks?page_size=100", headers=h)
        assert len(r.json()) == 45 and r.headers["x-total-pages"] == "1"

    def test_count_follows_the_filters_and_visibility(self, client, auth, leader, alice, many, db_session):
        many[0].restricted = True
        many[1].status = TaskStatus.done
        many[2].status = TaskStatus.blocked
        many[3].status = TaskStatus.needs_confirm
        db_session.commit()
        r = client.get("/tasks?page_size=5&status_filter=to_do", headers=auth(alice))
        assert r.headers["x-total-count"] == "41"  # 45 less restricted, done, blocked, needs_confirm
        r = client.get("/tasks?page_size=5&statuses=blocked,needs_confirm", headers=auth(leader))
        assert r.headers["x-total-count"] == "2"
        assert client.get("/tasks?statuses=nope", headers=auth(leader)).status_code == 422

    def test_tag_filter_pages_and_counts(self, client, auth, leader, many, db_session):
        for n, task in enumerate(many):
            task.tags = ["phase-0", "type-fix"] if n % 2 == 0 else ["phase-1", "needs-approval"]
        db_session.commit()
        h = auth(leader)
        r = client.get("/tasks?tag=phase-0&page_size=10", headers=h)
        assert r.headers["x-total-count"] == "23" and len(r.json()) == 10
        assert all("phase-0" in t["tags"] for t in r.json())
        assert client.get("/tasks?tag=needs-approval&page=3&page_size=10", headers=h).headers["x-total-count"] == "22"
        assert len(client.get("/tasks?tag=type-fix&page=3&page_size=10", headers=h).json()) == 3
        # A tag is matched whole: "phase" is not "phase-0".
        assert client.get("/tasks?tag=phase&page=1", headers=h).json() == []

    def test_sort_by_updated(self, client, auth, leader, many, db_session):
        many[10].updated_at = datetime(2026, 6, 1)
        db_session.commit()
        r = client.get("/tasks?sort=updated&page_size=1", headers=auth(leader))
        assert r.json()[0]["id"] == many[10].id

    def test_cors_exposes_the_paging_headers(self, client):
        r = client.get("/health", headers={"Origin": settings.cors_origins[0]})
        exposed = r.headers["access-control-expose-headers"]
        for name in ("X-Total-Count", "X-Page", "X-Page-Size", "X-Total-Pages"):
            assert name in exposed


class TestOtherListsPage:
    def test_notifications(self, client, auth, leader, alice, many, db_session):
        for n in range(30):
            db_session.add(Notification(user_id=alice.id, task_id=many[0].id, kind=NotifyKind.mention,
                                        actor_id=leader.id, text=f"n{n}", email_state="skipped"))
        db_session.commit()
        h = auth(alice)
        assert len(client.get("/notifications", headers=h).json()) == 30
        assert "x-total-count" not in client.get("/notifications?limit=5", headers=h).headers
        r1 = client.get("/notifications?page=1", headers=h)
        r2 = client.get("/notifications?page=2", headers=h)
        assert r1.headers["x-total-count"] == "30" and r1.headers["x-total-pages"] == "2"
        ids = [n["id"] for n in r1.json() + r2.json()]
        assert len(ids) == 30 and ids == sorted(ids, reverse=True)

    def test_areas(self, client, auth, leader):
        h = auth(leader)
        for n in range(25):
            r = client.post("/areas", headers=h, json={"name": f"Zone {n:02d} q{n * 7919}", "slug": f"zone-{n:02d}", "confirm_new": True})
            assert r.status_code == 201, r.text
        assert len(client.get("/areas", headers=h).json()) == 25
        r = client.get("/areas?page=2&page_size=10", headers=h)
        assert [a["slug"] for a in r.json()] == [f"zone-{n:02d}" for n in range(10, 20)]
        assert r.headers["x-total-count"] == "25" and r.headers["x-total-pages"] == "3"

    def test_people_and_directory(self, client, auth, leader, db_session):
        for n in range(24):
            make_user(db_session, f"Person {n:02d}", f"p{n}@example.com", Role.programmer)
        h = auth(leader)
        assert len(client.get("/users", headers=h).json()) == 25
        r = client.get("/users?page=2&page_size=20", headers=h)
        assert len(r.json()) == 5 and r.headers["x-total-count"] == "25"
        r = client.get("/users?q=person 0&page=1", headers=h)
        assert r.headers["x-total-count"] == "10"
        r = client.get("/auth/users?page=1&page_size=10", headers=h)
        assert len(r.json()) == 10 and r.headers["x-total-count"] == "25"
        assert len(client.get("/auth/users", headers=h).json()) == 25

    def test_library(self, client, auth, leader, make_task):
        h = auth(leader)
        task = make_task(title="Docs home")
        for n in range(23):
            r = client.post(f"/tasks/{task.id}/docs", headers=h, json={"title": f"Doc {n:02d}", "body": "text"})
            assert r.status_code == 201, r.text
        assert len(client.get("/library", headers=h).json()) == 23
        r1 = client.get("/library?page=1", headers=h)
        r2 = client.get("/library?page=2", headers=h)
        assert r1.headers["x-total-count"] == "23"
        slugs = [d["slug"] for d in r1.json() + r2.json()]
        assert len(slugs) == 23 and len(set(slugs)) == 23

    def test_inbox(self, client, auth, leader, make_task):
        for n in range(22):
            make_task(title=f"Review {n}", status=TaskStatus.in_review)
        h = auth(leader)
        assert len(client.get("/tasks/inbox", headers=h).json()) == 22
        r = client.get("/tasks/inbox?page=2", headers=h)
        assert len(r.json()) == 2 and r.headers["x-total-count"] == "22"


# --- bulk import ----------------------------------------------------------------


def _task(key="QX-0001", **fields):
    return {"external_key": key, "title": f"Imported {key}", **fields}


class TestImport:
    def test_creates_tasks_with_every_field(self, client, auth, leader, db_session):
        h = auth(leader)
        client.post("/areas", headers=h, json={"name": "Payments"})
        r = client.post("/tasks/import", headers=h, json={"tasks": [
            _task("QX-0001", description="Fix the refund rounding", kind="bug", priority="urgent", side="be",
                  area="payments", tags=["phase-0", "type-fix"], criteria=["Refund totals match", "Test added"]),
            _task("QX-0002"),
        ]})
        assert r.status_code == 200, r.text
        rows = r.json()
        assert [(x["external_key"], x["action"]) for x in rows] == [("QX-0001", "created"), ("QX-0002", "created")]
        first = client.get(f"/tasks/{rows[0]['id']}", headers=h).json()
        assert first["fingerprint"] == "ext:QX-0001"
        assert (first["kind"], first["priority"], first["side"], first["status"]) == ("bug", "urgent", "be", "backlog")
        assert first["area"]["slug"] == "payments"
        assert first["tags"] == ["phase-0", "type-fix"]
        assert [c["text"] for c in first["criteria"]] == ["Refund totals match", "Test added"]
        # A bug needs no template headings here, and no starter criteria are added.
        second = client.get(f"/tasks/{rows[1]['id']}", headers=h).json()
        assert second["criteria"] == [] and second["status"] == "backlog"
        created = db_session.query(TaskEvent).filter_by(task_id=rows[0]["id"], event_type="created").one()
        assert created.data == {"import": True, "external_key": "QX-0001"}
        assert created.actor_kind.value == "human"

    def test_same_batch_again_changes_nothing(self, client, auth, leader, db_session):
        h = auth(leader)
        batch = {"tasks": [_task("QX-0001", tags=["phase-0"], criteria=["One"]), _task("QX-0002")]}
        first = client.post("/tasks/import", headers=h, json=batch).json()
        events = db_session.query(TaskEvent).count()
        again = client.post("/tasks/import", headers=h, json=batch).json()
        assert [x["action"] for x in again] == ["unchanged", "unchanged"]
        assert [x["id"] for x in again] == [x["id"] for x in first]
        assert db_session.query(Task).count() == 2
        assert db_session.query(TaskEvent).count() == events

    def test_update_changes_sent_fields_and_keeps_the_rest(self, client, auth, leader, alice, db_session):
        h = auth(leader)
        client.post("/areas", headers=h, json={"name": "Payments"})
        task_id = client.post("/tasks/import", headers=h, json={"tasks": [
            _task("QX-0001", side="be", tags=["phase-0"], priority="high")]}).json()[0]["id"]
        # The team moves it and assigns it; a later import must not undo that.
        client.patch(f"/tasks/{task_id}/status", headers=h, json={"status": "to_do"})
        client.patch(f"/tasks/{task_id}/assign", headers=h, json={"assignee_1_id": alice.id})
        r = client.post("/tasks/import", headers=h, json={"tasks": [{
            "external_key": "QX-0001", "title": "Imported, renamed", "description": "Now with a body",
            "kind": "feature", "area": "payments", "tags": ["phase-1"], "restricted": True,
            "criteria": ["Added later"], "status": "backlog",
        }]})
        assert r.json()[0] == {"external_key": "QX-0001", "action": "updated", "id": task_id, "error": None}
        task = client.get(f"/tasks/{task_id}", headers=h).json()
        assert task["title"] == "Imported, renamed" and task["description"] == "Now with a body"
        assert (task["kind"], task["tags"], task["restricted"]) == ("feature", ["phase-1"], True)
        assert task["area"]["slug"] == "payments"
        assert task["side"] == "be" and task["priority"] == "high"  # not sent, so kept
        assert task["status"] == "to_do" and task["assignee_1_id"] == alice.id
        assert [c["text"] for c in task["criteria"]] == ["Added later"]
        assert db_session.query(Task).count() == 1
        # Criteria are added only when the task has none.
        r = client.post("/tasks/import", headers=h, json={"tasks": [
            {"external_key": "QX-0001", "title": "Imported, renamed", "criteria": ["Another"]}]})
        assert r.json()[0]["action"] == "unchanged"

    def test_restricted_tasks_stay_hidden_from_members(self, client, auth, leader, alice):
        r = client.post("/tasks/import", headers=auth(leader), json={"tasks": [
            _task("QX-0001", restricted=True), _task("QX-0002")]})
        hidden, shown = [x["id"] for x in r.json()]
        assert [t["id"] for t in client.get("/tasks", headers=auth(alice)).json()] == [shown]
        assert client.get(f"/tasks/{hidden}", headers=auth(alice)).status_code == 404

    def test_question_parks_the_task_and_is_asked_once(self, client, auth, leader, alice, db_session):
        alice.handle = "alice"
        alice.role = Role.leader
        db_session.commit()
        h = auth(leader)
        batch = {"tasks": [_task("QX-0001", status="to_do", question="Keep or drop this one?", question_to="alice")]}
        task_id = client.post("/tasks/import", headers=h, json=batch).json()[0]["id"]
        task = client.get(f"/tasks/{task_id}", headers=h).json()
        assert task["status"] == "needs_confirm" and task["resume_status"] == "to_do"
        assert task["open_questions"] == 1
        question = task["comments"][0]
        assert (question["kind"], question["to_user"]["handle"]) == ("question", "alice")
        assert db_session.query(Notification).filter_by(user_id=alice.id, kind=NotifyKind.question).count() == 1

        assert client.post("/tasks/import", headers=h, json=batch).json()[0]["action"] == "unchanged"
        assert db_session.query(Comment).filter_by(task_id=task_id, kind=CommentKind.question).count() == 1

        # Answering sends the task back to where it was.
        r = client.post(f"/tasks/{task_id}/comments", headers=auth(alice),
                        json={"kind": "answer", "body": "Keep it.", "parent_id": question["id"]})
        assert r.status_code == 201, r.text
        assert client.get(f"/tasks/{task_id}", headers=h).json()["status"] == "to_do"
        # The same question is not asked again after it was answered.
        assert client.post("/tasks/import", headers=h, json=batch).json()[0]["action"] == "unchanged"

    def test_dry_run_reports_and_writes_nothing(self, client, auth, leader, db_session):
        h = auth(leader)
        client.post("/tasks/import", headers=h, json={"tasks": [_task("QX-0001")]})
        events = db_session.query(TaskEvent).count()
        r = client.post("/tasks/import", headers=h, json={"dry_run": True, "tasks": [
            {"external_key": "QX-0001", "title": "Renamed"},
            _task("QX-0002", question="Which one?", question_to="nobody"),
            _task("QX-0003"),
            _task("QX-0003"),
            {"external_key": "QX-0004", "title": "Same as now"},
        ]})
        rows = r.json()
        assert [x["action"] for x in rows] == ["updated", "error", "created", "error", "created"]
        assert rows[2]["id"] is None and "nobody" in rows[1]["error"] and "twice" in rows[3]["error"]
        assert db_session.query(Task).count() == 1
        assert db_session.query(TaskEvent).count() == events
        assert db_session.query(Task).one().title == "Imported QX-0001"

    def test_one_bad_task_does_not_stop_the_rest(self, client, auth, leader, db_session):
        r = client.post("/tasks/import", headers=auth(leader), json={"tasks": [
            _task("QX-0001", description="Server at 10.20.30.40 is down"),
            _task("QX-0002", kind="epic"),
            _task("QX-0003", area="no-such-area"),
            {"title": "No key"},
            _task("QX-0005", question="Asked of nobody"),
            _task("QX-0006"),
        ]})
        assert r.status_code == 200, r.text
        rows = r.json()
        assert [x["action"] for x in rows] == ["error", "error", "error", "error", "error", "created"]
        assert "IP address" in rows[0]["error"]
        assert rows[1]["error"].startswith("kind:")
        assert "No area" in rows[2]["error"]
        assert rows[3]["external_key"] is None and "external_key" in rows[3]["error"]
        assert "question_to" in rows[4]["error"]
        assert [t.fingerprint for t in db_session.query(Task)] == ["ext:QX-0006"]

    def test_imports_skip_the_similar_task_check(self, client, auth, leader):
        r = client.post("/tasks/import", headers=auth(leader), json={"tasks": [
            {"external_key": "QX-0001", "title": "Refund totals are rounded wrong on the receipt"},
            {"external_key": "QX-0002", "title": "Refund totals are rounded wrong on the receipt"},
        ]})
        assert [x["action"] for x in r.json()] == ["created", "created"]

    def test_who_may_import(self, client, auth, token, leader, alice):
        body = {"tasks": [_task("QX-0001")]}
        assert client.post("/tasks/import", headers=auth(alice), json=body).status_code == 403
        assert client.post("/tasks/import", headers=token(alice), json=body).status_code == 403
        no_create = token(leader, scopes=["tasks:read", "tasks:write"])
        assert client.post("/tasks/import", headers=no_create, json=body).status_code == 403
        r = client.post("/tasks/import", headers=token(leader), json=body)
        assert r.status_code == 200 and r.json()[0]["action"] == "created"
        task = client.get(f"/tasks/{r.json()[0]['id']}", headers=auth(leader)).json()
        assert task["created_kind"] == "agent" and task["created_agent"] == "import-agent"
        assert task["events"][0]["agent_name"] == "import-agent"

    def test_batch_size_limit(self, client, auth, leader, monkeypatch):
        monkeypatch.setattr(settings, "import_max_tasks", 2)
        r = client.post("/tasks/import", headers=auth(leader), json={"tasks": [_task(f"QX-{n}") for n in range(3)]})
        assert r.status_code == 422 and "At most 2" in r.json()["detail"]
        assert client.post("/tasks/import", headers=auth(leader), json={"tasks": []}).status_code == 422


# --- decision view --------------------------------------------------------------


class TestAwaitingDecision:
    @pytest.fixture()
    def asked(self, client, auth, leader, alice, bob, make_task, db_session):
        """Three tasks with a question: to the lead, to a second lead, to Bob."""
        leader.handle = "lead"
        alice.handle = "alice"
        alice.role = Role.leader
        bob.handle = "bob"
        db_session.commit()
        tasks = [make_task(title=f"Needs an answer {n}") for n in range(4)]
        h = auth(leader)
        for task, to in zip(tasks, ("lead", "alice", "bob")):
            by = auth(alice) if to == "lead" else h
            r = client.post(f"/tasks/{task.id}/comments", headers=by,
                            json={"kind": "question", "body": f"Decide for {to}?", "to": to, "wait": True})
            assert r.status_code == 201, r.text
        return tasks

    def test_lists_tasks_with_an_open_question_to_the_caller(self, client, auth, leader, bob, asked):
        rows = client.get("/tasks?awaiting_decision=true", headers=auth(leader)).json()
        assert [t["id"] for t in rows] == [asked[0].id]
        question = rows[0]["decision_questions"][0]
        assert question["text"] == "Decide for lead?" and question["to"] == "lead" and question["author"]
        assert [t["id"] for t in client.get("/tasks?awaiting_decision=true", headers=auth(bob)).json()] == [asked[2].id]
        # Other lists do not carry the questions.
        assert client.get("/tasks", headers=auth(leader)).json()[0]["decision_questions"] == []

    def test_a_lead_can_list_questions_to_any_lead(self, client, auth, leader, bob, asked):
        r = client.get("/tasks?awaiting_decision=true&to=leads&page=1", headers=auth(leader))
        assert sorted(t["id"] for t in r.json()) == [asked[0].id, asked[1].id]
        assert r.headers["x-total-count"] == "2"
        assert client.get("/tasks?awaiting_decision=true&to=leads", headers=auth(bob)).status_code == 403

    def test_an_answered_question_leaves_the_list(self, client, auth, leader, asked):
        h = auth(leader)
        comment_id = client.get("/tasks?awaiting_decision=true", headers=h).json()[0]["decision_questions"][0]["comment_id"]
        r = client.post(f"/tasks/{asked[0].id}/comments", headers=h,
                        json={"kind": "answer", "body": "Go ahead.", "parent_id": comment_id})
        assert r.status_code == 201, r.text
        assert client.get("/tasks?awaiting_decision=true", headers=h).json() == []

    def test_imported_questions_show_up(self, client, auth, leader, asked):
        h = auth(leader)
        client.post("/tasks/import", headers=h, json={"tasks": [
            _task("QX-0001", question="Phase 0 or later?", question_to="lead")]})
        rows = client.get("/tasks?awaiting_decision=true", headers=h).json()
        assert [q["text"] for t in rows for q in t["decision_questions"]] == ["Phase 0 or later?", "Decide for lead?"]


def test_import_sets_points_and_rejects_off_scale(client, auth, leader):
    h = auth(leader)
    r = client.post("/tasks/import", headers=h, json={"tasks": [
        {"external_key": "PTS-1", "title": "Pointed task", "points": 8},
        {"external_key": "PTS-2", "title": "Bad points", "points": 4},
    ]})
    rows = {x["external_key"]: x for x in r.json()}
    assert rows["PTS-1"]["action"] == "created"
    assert rows["PTS-2"]["action"] == "error"
    assert client.get(f"/tasks/{rows['PTS-1']['id']}", headers=h).json()["points"] == 8
    r = client.post("/tasks/import", headers=h, json={"tasks": [{"external_key": "PTS-1", "title": "Pointed task", "points": 5}]})
    assert r.json()[0]["action"] == "updated"
    assert client.get(f"/tasks/{rows['PTS-1']['id']}", headers=h).json()["points"] == 5
