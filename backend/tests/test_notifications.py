"""Notifications: who is told, the in-app list, settings, and the batched
email sender (against a fake SMTP)."""

from __future__ import annotations

from datetime import timedelta

import pytest
from sqlalchemy.orm import sessionmaker

from app import mailer
from app.config import settings
from app.models import Notification, Role, TaskStatus, utcnow
from tests.conftest import make_user


@pytest.fixture()
def smtp_on(monkeypatch):
    """Email configured, sending captured instead of performed."""
    monkeypatch.setattr(settings, "smtp_host", "smtp.example.com")
    monkeypatch.setattr(settings, "smtp_from", "hub@example.com")
    monkeypatch.setattr(settings, "email_batch_seconds", 120)
    sent: list[dict] = []
    monkeypatch.setattr(mailer, "send_message", lambda to, subject, body: sent.append(
        {"to": to, "subject": subject, "body": body}))
    return sent


@pytest.fixture()
def handles(db_session, leader, alice, bob):
    leader.handle, alice.handle, bob.handle = "lead", "alice", "bob"
    db_session.commit()


def _rows(db_session, user):
    db_session.expire_all()
    return db_session.query(Notification).filter_by(user_id=user.id).order_by(Notification.id).all()


def _send(db_session, now=None):
    factory = sessionmaker(bind=db_session.get_bind(), autoflush=False)
    return mailer.run_once(now=now or utcnow() + timedelta(minutes=5), session_factory=factory)


class TestWhoIsTold:
    def test_assignment_tells_the_assignee_not_the_actor(self, client, auth, leader, alice, db_session):
        client.post("/tasks", headers=auth(leader), json={"title": "Fix login", "assignee_1_id": alice.id})
        rows = _rows(db_session, alice)
        assert [r.kind.value for r in rows] == ["assigned"]
        assert _rows(db_session, leader) == []

    def test_question_answer_and_mentions(self, client, auth, leader, alice, bob, make_task, handles, db_session):
        task = make_task(status=TaskStatus.in_progress, assignee_1=alice)
        q = client.post(f"/tasks/{task.id}/comments", headers=auth(alice),
                        json={"kind": "question", "body": "Which CSV columns? cc @bob", "to": "lead"}).json()
        assert [r.kind.value for r in _rows(db_session, leader)] == ["question"]
        assert [r.kind.value for r in _rows(db_session, bob)] == ["mention"]
        client.post(f"/tasks/{task.id}/comments", headers=auth(leader),
                    json={"kind": "answer", "body": "Email and password", "parent_id": q["id"]})
        assert [r.kind.value for r in _rows(db_session, alice)] == ["answered"]

    def test_an_email_address_is_not_a_mention(self, client, auth, alice, bob, make_task, handles, db_session):
        task = make_task(assignee_1=alice)
        client.post(f"/tasks/{task.id}/comments", headers=auth(alice), json={"body": "write to x@bob.com"})
        assert _rows(db_session, bob) == []

    def test_review_goes_to_leads_and_the_verdict_to_assignees(self, client, auth, leader, alice, make_task, db_session):
        task = make_task(status=TaskStatus.in_progress, assignee_1=alice)
        client.patch(f"/tasks/{task.id}/status", headers=auth(alice), json={"status": "in_review"})
        assert [r.kind.value for r in _rows(db_session, leader)] == ["review"]
        client.patch(f"/tasks/{task.id}/status", headers=auth(leader),
                     json={"status": "in_progress", "comment": "add tests"})
        rejected = _rows(db_session, alice)[-1]
        assert rejected.kind.value == "rejected" and rejected.text == "add tests"

    def test_proposals_go_to_leads(self, client, auth, leader, alice, db_session):
        client.post("/tasks", headers=auth(alice), json={"title": "Idea", "status": "proposed"})
        assert [r.kind.value for r in _rows(db_session, leader)] == ["proposal"]

    def test_people_who_cannot_see_the_task_are_not_told(self, client, auth, leader, alice, bob, make_task, handles, db_session):
        task = make_task(assignee_1=alice)
        task.restricted = True
        db_session.commit()
        client.post(f"/tasks/{task.id}/comments", headers=auth(alice), json={"body": "@bob @lead look"})
        assert _rows(db_session, bob) == []
        lead_row = _rows(db_session, leader)[0]
        assert lead_row.text is None  # restricted: no excerpt leaves the hub

    def test_bots_hear_a_tag_but_never_by_email(self, client, auth, leader, db_session, make_task):
        bot = client.post("/users", headers=auth(leader), json={
            "name": "Scanner", "email": "s@bots.example.com", "account_type": "bot", "handle": "scanner"}).json()
        task = make_task()
        client.post(f"/tasks/{task.id}/comments", headers=auth(leader), json={"body": "@scanner hi"})
        rows = db_session.query(Notification).filter_by(user_id=bot["id"]).all()
        assert [(r.kind.value, r.email_state) for r in rows] == [("mention", "skipped")]


class TestList:
    def test_list_count_and_mark_read(self, client, auth, leader, alice):
        for i in range(3):
            client.post("/tasks", headers=auth(leader), json={"title": f"t{i}", "assignee_1_id": alice.id})
        h = auth(alice)
        assert client.get("/notifications/count", headers=h).json() == {"unread": 3}
        first = client.get("/notifications", headers=h).json()[0]
        assert first["kind"] == "assigned" and first["actor_kind"] == "human"
        client.post("/notifications/read", headers=h, json={"ids": [first["id"]]})
        assert client.get("/notifications/count", headers=h).json() == {"unread": 2}
        client.post("/notifications/read", headers=h, json={"all": True})
        assert client.get("/notifications?unread=true", headers=h).json() == []


class TestPreferences:
    def test_defaults_and_changes(self, client, auth, alice):
        h = auth(alice)
        prefs = client.get("/notifications/preferences", headers=h).json()
        assert prefs["email_notifications"] is True
        assert "review" not in prefs["available_kinds"]  # leads only
        changed = client.patch("/notifications/preferences", headers=h, json={
            "notify_kinds": ["assigned"], "notify_address": "Alice.Work@Example.com"}).json()
        assert changed["notify_kinds"] == ["assigned"]
        assert changed["notify_address"] == "alice.work@example.com"

    def test_tokens_cannot_change_preferences(self, client, auth, alice):
        token = client.post("/auth/tokens", headers=auth(alice), json={"name": "t"}).json()["token"]
        r = client.patch("/notifications/preferences", json={"email_notifications": False},
                         headers={"Authorization": f"Bearer {token}", "X-Agent": "a"})
        assert r.status_code == 403


class TestEmail:
    def test_rows_wait_for_the_batch_then_go_as_one_email(self, client, auth, leader, alice, db_session, smtp_on):
        for title in ("Fix login", "Export CSV"):
            client.post("/tasks", headers=auth(leader), json={"title": title, "assignee_1_id": alice.id})
        assert all(r.email_state == "pending" for r in _rows(db_session, alice))
        assert _send(db_session, now=utcnow()) == 0  # still inside the batch window
        assert _send(db_session) == 1
        assert len(smtp_on) == 1
        mail = smtp_on[0]
        assert mail["to"] == alice.email
        assert mail["subject"] == "[Team hub] 2 updates for you"
        assert "Fix login" in mail["body"] and "Export CSV" in mail["body"]
        assert all(r.email_state == "sent" for r in _rows(db_session, alice))

    def test_switched_off_kinds_and_people_get_no_email(self, client, auth, leader, alice, bob, db_session, smtp_on):
        alice.notify_kinds = ["question"]
        bob.email_notifications = False
        db_session.commit()
        for who in (alice, bob):
            client.post("/tasks", headers=auth(leader), json={"title": "x", "assignee_1_id": who.id})
        assert [r.email_state for r in _rows(db_session, alice)] == ["skipped"]
        assert [r.email_state for r in _rows(db_session, bob)] == ["skipped"]
        assert _send(db_session) == 0

    def test_notify_address_wins(self, client, auth, leader, alice, db_session, smtp_on):
        alice.notify_address = "alice.personal@example.com"
        db_session.commit()
        client.post("/tasks", headers=auth(leader), json={"title": "x", "assignee_1_id": alice.id})
        _send(db_session)
        assert smtp_on[0]["to"] == "alice.personal@example.com"

    def test_failures_retry_then_stop(self, client, auth, leader, alice, db_session, smtp_on, monkeypatch):
        monkeypatch.setattr(settings, "email_max_attempts", 2)

        def boom(*_a):
            raise OSError("connection refused")

        monkeypatch.setattr(mailer, "send_message", boom)
        client.post("/tasks", headers=auth(leader), json={"title": "x", "assignee_1_id": alice.id})
        _send(db_session)
        assert _rows(db_session, alice)[0].email_state == "pending"
        _send(db_session)
        row = _rows(db_session, alice)[0]
        assert row.email_state == "failed" and "connection refused" in row.email_error

    def test_hourly_cap_holds_extra_mail(self, client, auth, leader, alice, db_session, smtp_on, monkeypatch):
        monkeypatch.setattr(settings, "email_max_per_user_hour", 1)
        client.post("/tasks", headers=auth(leader), json={"title": "a", "assignee_1_id": alice.id})
        _send(db_session)
        client.post("/tasks", headers=auth(leader), json={"title": "b", "assignee_1_id": alice.id})
        assert _send(db_session) == 0
        assert _rows(db_session, alice)[-1].email_state == "pending"

    def test_send_message_uses_starttls_and_login(self, monkeypatch, smtp_on):
        calls = []

        class FakeSMTP:
            def __init__(self, host, port, timeout):
                calls.append(("connect", host, port))

            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

            def starttls(self, context):
                calls.append(("starttls",))

            def login(self, user, password):
                calls.append(("login", user))

            def send_message(self, msg):
                calls.append(("send", msg["To"], msg["Subject"]))

        monkeypatch.undo()  # restore the real send_message
        monkeypatch.setattr(settings, "smtp_host", "smtp.gmail.com")
        monkeypatch.setattr(settings, "smtp_from", "hub@example.com")
        monkeypatch.setattr(settings, "smtp_user", "hub@example.com")
        monkeypatch.setattr(settings, "smtp_password", "app-password")
        monkeypatch.setattr(mailer.smtplib, "SMTP", FakeSMTP)
        mailer.send_message("a@example.com", "Hi", "Body")
        assert calls == [
            ("connect", "smtp.gmail.com", 587),
            ("starttls",),
            ("login", "hub@example.com"),
            ("send", "a@example.com", "Hi"),
        ]

    def test_test_email_endpoint(self, client, auth, alice, smtp_on):
        r = client.post("/notifications/test", headers=auth(alice))
        assert r.status_code == 200 and smtp_on[0]["to"] == alice.email

    def test_test_email_needs_smtp(self, client, auth, alice):
        assert client.post("/notifications/test", headers=auth(alice)).status_code == 409

    def test_status_is_admin_only_and_hides_the_password(self, client, auth, leader, alice, smtp_on, monkeypatch):
        monkeypatch.setattr(settings, "smtp_password", "app-password-123")
        assert client.get("/notifications/status", headers=auth(alice)).status_code == 403
        body = client.get("/notifications/status", headers=auth(leader))
        assert body.status_code == 200 and "app-password-123" not in body.text
        assert body.json()["email_enabled"] is True


def test_comment_response_lists_who_was_told(client, auth, leader, alice, bob, make_task, handles):
    task = make_task(assignee_1=alice)
    body = client.post(f"/tasks/{task.id}/comments", headers=auth(alice),
                       json={"body": "@bob @nobody-here @alice look"}).json()
    assert body["notified"] == ["bob"]  # unknown handle and yourself are skipped


def test_agents_read_their_owners_notifications_with_the_comment(client, auth, leader, alice, make_task, handles):
    task = make_task(status=TaskStatus.in_progress, assignee_1=alice)
    q = client.post(f"/tasks/{task.id}/comments", headers=auth(alice),
                    json={"kind": "question", "body": "CSV or JSON?", "to": "lead"}).json()
    token = client.post("/auth/tokens", headers=auth(leader), json={"name": "laptop"}).json()["token"]
    agent = {"Authorization": f"Bearer {token}", "X-Agent": "lead-agent"}
    items = client.get("/notifications?unread=true", headers=agent).json()
    assert items[0]["kind"] == "question" and items[0]["comment_id"] == q["id"]
    assert items[0]["question_open"] is True
    client.post(f"/tasks/{task.id}/comments", headers=agent,
                json={"kind": "answer", "body": "CSV", "parent_id": q["id"]})
    assert client.get("/notifications", headers=agent).json()[0]["question_open"] is False
    assert client.post("/notifications/read", headers=agent, json={"all": True}).json() == {"marked": 1}
