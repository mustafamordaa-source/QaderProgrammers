"""Access roles, bot accounts, bulk triage, task documents, attachments,
context links and the library."""

from __future__ import annotations

import pytest

from app.config import settings
from app.models import AccessRole, Role, TaskStatus
from tests.conftest import PASSWORD, make_user

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64


@pytest.fixture(autouse=True)
def _files_in_tmp(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "files_dir", str(tmp_path / "files"))


def _person(client, headers, email, roles, **extra):
    body = {"name": email.split("@")[0], "email": email, "password": PASSWORD, "roles": roles, **extra}
    response = client.post("/users", headers=headers, json=body)
    assert response.status_code == 201, response.text
    return response.json()


def _login(client, email):
    r = client.post("/auth/login", json={"email": email, "password": PASSWORD})
    assert r.status_code == 200, r.text
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


# --- roles ------------------------------------------------------------------------


class TestRoles:
    def test_a_person_can_hold_several_roles_and_sides(self, client, auth, leader):
        body = _person(
            client, auth(leader), "full@example.com", ["admin", "lead", "member"], sides=["fe", "be", "infra"]
        )
        assert body["roles"] == ["admin", "lead", "member"]
        assert body["sides"] == ["fe", "be", "infra"]
        assert body["role"] == "leader"  # older clients still read one role

    def test_viewer_is_dropped_next_to_a_stronger_role(self, client, auth, leader):
        body = _person(client, auth(leader), "mixed@example.com", ["viewer", "member"])
        assert body["roles"] == ["member"]

    def test_the_old_single_role_still_works(self, client, auth, leader):
        r = client.post(
            "/users", headers=auth(leader),
            json={"name": "x", "email": "old@example.com", "password": PASSWORD, "role": "viewer"},
        )
        assert r.json()["roles"] == ["viewer"]

    def test_only_admins_manage_people(self, client, auth, leader):
        _person(client, auth(leader), "lead-only@example.com", ["lead"])
        lead = _login(client, "lead-only@example.com")
        assert client.get("/users", headers=lead).status_code == 200
        r = client.post("/users", headers=lead, json={"name": "x", "email": "n@example.com", "password": PASSWORD})
        assert r.status_code == 403

    def test_a_lead_runs_the_work(self, client, auth, leader, alice, make_task):
        _person(client, auth(leader), "lead-only@example.com", ["lead"])
        lead = _login(client, "lead-only@example.com")
        task = make_task(status=TaskStatus.in_review, assignee_1=alice)
        assert client.patch(f"/tasks/{task.id}/status", headers=lead, json={"status": "done"}).status_code == 200

    def test_a_lead_who_is_also_a_member_can_be_assigned(self, client, auth, leader):
        full = _person(client, auth(leader), "full@example.com", ["admin", "lead", "member"])
        r = client.post("/tasks", headers=auth(leader), json={"title": "x", "assignee_1_id": full["id"]})
        assert r.status_code == 201

    def test_a_lead_without_member_cannot_be_assigned(self, client, auth, leader):
        lead = _person(client, auth(leader), "lead-only@example.com", ["lead"])
        r = client.post("/tasks", headers=auth(leader), json={"title": "x", "assignee_1_id": lead["id"]})
        assert r.status_code == 422

    def test_the_last_admin_cannot_drop_admin(self, client, auth, leader):
        r = client.patch(f"/users/{leader.id}", headers=auth(leader), json={"roles": ["lead"]})
        assert r.status_code == 409
        _person(client, auth(leader), "second@example.com", ["admin"])
        r = client.patch(f"/users/{leader.id}", headers=auth(leader), json={"roles": ["lead", "member"]})
        assert r.status_code == 200 and r.json()["roles"] == ["lead", "member"]

    def test_directory_filters_by_role_and_side(self, client, auth, leader):
        _person(client, auth(leader), "fe@example.com", ["member"], sides=["fe"])
        _person(client, auth(leader), "be@example.com", ["member"], sides=["be"])
        fe = client.get("/auth/users?role=member&side=fe", headers=auth(leader)).json()
        assert [u["email"] for u in fe] == ["fe@example.com"]


# --- bots -------------------------------------------------------------------------


@pytest.fixture()
def bot(client, auth, leader):
    body = {"name": "Server scanner", "email": "scanner@bots.example.com", "account_type": "bot", "handle": "scanner"}
    created = client.post("/users", headers=auth(leader), json=body)
    assert created.status_code == 201, created.text
    bot_id = created.json()["id"]
    token = client.post(f"/users/{bot_id}/tokens", headers=auth(leader), json={"name": "cs", "expires_days": 30})
    assert token.status_code == 201, token.text
    return {"id": bot_id, "headers": {"Authorization": f"Bearer {token.json()['token']}", "X-Agent": "scanner"}}


class TestBots:
    def test_bots_cannot_log_in(self, client, bot):
        r = client.post("/auth/login", json={"email": "scanner@bots.example.com", "password": "anything-at-all"})
        assert r.status_code == 401

    def test_bot_tasks_always_land_in_proposed(self, client, bot):
        r = client.post("/tasks", headers=bot["headers"], json={"title": "Unused import in views", "status": "to_do"})
        assert r.status_code == 201
        assert r.json()["status"] == "proposed"
        assert r.json()["created_kind"] == "agent"

    def test_bot_tokens_are_limited(self, client, auth, leader, bot):
        r = client.post(
            f"/users/{bot['id']}/tokens", headers=auth(leader),
            json={"name": "x", "scopes": ["tasks:read", "claims"]},
        )
        assert r.status_code == 422

    def test_bots_comment_only_on_their_proposals(self, client, bot, make_task):
        other = make_task(title="human task")
        r = client.post(f"/tasks/{other.id}/comments", headers=bot["headers"], json={"body": "hi"})
        assert r.status_code == 403
        own = client.post("/tasks", headers=bot["headers"], json={"title": "Finding"}).json()
        r = client.post(f"/tasks/{own['id']}/comments", headers=bot["headers"], json={"body": "evidence: line 12"})
        assert r.status_code == 201

    def test_a_propose_only_token_files_proposals(self, client, auth, leader):
        token = client.post(
            "/auth/tokens", headers=auth(leader), json={"name": "p", "scopes": ["tasks:read", "tasks:propose"]}
        ).json()["token"]
        h = {"Authorization": f"Bearer {token}", "X-Agent": "lead-agent"}
        r = client.post("/tasks", headers=h, json={"title": "idea", "status": "to_do"})
        assert r.json()["status"] == "proposed"


# --- triage -----------------------------------------------------------------------


class TestTriage:
    def test_bulk_accept_and_drop(self, client, auth, leader, alice, bot):
        ids = [client.post("/tasks", headers=bot["headers"], json={"title": f"f{i}"}).json()["id"] for i in range(3)]
        accepted = client.post(
            "/tasks/triage", headers=auth(leader),
            json={"task_ids": ids[:2], "to": "to_do", "assignee_1_id": alice.id, "priority": "high"},
        ).json()
        assert [r["ok"] for r in accepted] == [True, True]
        task = client.get(f"/tasks/{ids[0]}", headers=auth(leader)).json()
        assert task["status"] == "to_do" and task["assignee_1_id"] == alice.id and task["priority"] == "high"
        assert task["events"][-1]["event_type"] == "triaged"

        no_reason = client.post("/tasks/triage", headers=auth(leader), json={"task_ids": ids[2:], "to": "dropped"})
        assert no_reason.status_code == 422
        dropped = client.post(
            "/tasks/triage", headers=auth(leader), json={"task_ids": ids[2:], "to": "dropped", "reason": "false positive"}
        ).json()
        assert dropped[0]["status"] == "dropped"

    def test_triage_skips_tasks_already_in_work(self, client, auth, leader, make_task):
        task = make_task(status=TaskStatus.in_progress)
        r = client.post("/tasks/triage", headers=auth(leader), json={"task_ids": [task.id, 999], "to": "to_do"}).json()
        assert [x["ok"] for x in r] == [False, False]

    def test_members_cannot_triage(self, client, auth, alice, bot):
        tid = client.post("/tasks", headers=bot["headers"], json={"title": "x"}).json()["id"]
        r = client.post("/tasks/triage", headers=auth(alice), json={"task_ids": [tid], "to": "to_do"})
        assert r.status_code == 403

    def test_filter_proposals_by_who_made_them(self, client, auth, leader, bot):
        client.post("/tasks", headers=bot["headers"], json={"title": "from bot"})
        client.post("/tasks", headers=auth(leader), json={"title": "from lead", "status": "proposed"})
        rows = client.get(
            "/tasks?status_filter=proposed&created_kind=agent", headers=auth(leader)
        ).json()
        assert [r["title"] for r in rows] == ["from bot"]


# --- documents --------------------------------------------------------------------


class TestDocs:
    def test_create_save_history_diff_restore(self, client, auth, alice, make_task):
        task = make_task(assignee_1=alice)
        h = auth(alice)
        doc = client.post(
            f"/tasks/{task.id}/docs", headers=h,
            json={"title": "API spec", "kind": "spec", "body": "# Spec\n\nPOST /accounts\n"},
        ).json()
        assert doc["slug"] == "api-spec" and doc["version"] == 1
        v2 = client.put(
            f"/tasks/{task.id}/docs/api-spec", headers=h,
            json={"body": "# Spec\n\nPOST /accounts\nGET /accounts\n", "base_version": 1, "note": "add GET"},
        ).json()
        assert v2["version"] == 2 and v2["note"] == "add GET"

        stale = client.put(f"/tasks/{task.id}/docs/api-spec", headers=h, json={"body": "x", "base_version": 1})
        assert stale.status_code == 409

        history = client.get(f"/tasks/{task.id}/docs/api-spec/history", headers=h).json()
        assert [v["n"] for v in history] == [2, 1]
        assert history[0]["actor_kind"] == "human"

        diff = client.get(f"/tasks/{task.id}/docs/api-spec/diff?from=1", headers=h).text
        assert "+GET /accounts" in diff

        old = client.get(f"/tasks/{task.id}/docs/api-spec?version=1", headers=h).json()
        assert "GET" not in old["body"]
        restored = client.post(f"/tasks/{task.id}/docs/api-spec/restore/1", headers=h).json()
        assert restored["version"] == 3 and restored["body"] == old["body"]

        raw = client.get(f"/tasks/{task.id}/docs/api-spec/raw", headers=h)
        assert raw.text == old["body"]

    def test_saving_the_same_text_makes_no_version(self, client, auth, alice, make_task):
        task = make_task(assignee_1=alice)
        h = auth(alice)
        client.post(f"/tasks/{task.id}/docs", headers=h, json={"title": "Notes", "body": "a"})
        again = client.put(f"/tasks/{task.id}/docs/notes", headers=h, json={"body": "a", "base_version": 1}).json()
        assert again["version"] == 1

    def test_agent_versions_are_marked(self, client, auth, alice, make_task):
        task = make_task(assignee_1=alice)
        token = client.post("/auth/tokens", headers=auth(alice), json={"name": "t"}).json()["token"]
        h = {"Authorization": f"Bearer {token}", "X-Agent": "fe-agent"}
        doc = client.post(f"/tasks/{task.id}/docs", headers=h, json={"title": "Plan", "kind": "plan"}).json()
        assert doc["version_actor_kind"] == "agent" and doc["version_agent_name"] == "fe-agent"

    def test_only_people_working_the_task_write_docs(self, client, auth, alice, bob, make_task):
        task = make_task(assignee_1=alice)
        r = client.post(f"/tasks/{task.id}/docs", headers=auth(bob), json={"title": "x"})
        assert r.status_code == 403
        client.post(f"/tasks/{task.id}/docs", headers=auth(alice), json={"title": "Notes", "body": "hello"})
        assert client.get(f"/tasks/{task.id}/docs/notes", headers=auth(bob)).status_code == 200

    def test_doc_bodies_pass_the_text_check(self, client, auth, alice, make_task):
        task = make_task(assignee_1=alice)
        r = client.post(
            f"/tasks/{task.id}/docs", headers=auth(alice), json={"title": "x", "body": "ssh 203.0.113.7"}
        )
        assert r.status_code == 422

    def test_versions_cannot_be_edited_in_the_database(self, client, auth, alice, make_task, db_session):
        import sqlalchemy

        task = make_task(assignee_1=alice)
        client.post(f"/tasks/{task.id}/docs", headers=auth(alice), json={"title": "Notes", "body": "a"})
        with pytest.raises(sqlalchemy.exc.IntegrityError):
            db_session.execute(sqlalchemy.text("UPDATE task_doc_versions SET body = 'forged'"))
        db_session.rollback()


# --- files ------------------------------------------------------------------------


class TestFiles:
    def test_upload_download_remove(self, client, auth, alice, make_task):
        task = make_task(assignee_1=alice)
        h = auth(alice)
        up = client.post(
            f"/tasks/{task.id}/files", headers=h,
            files={"upload": ("screen.png", PNG, "image/png")}, data={"note": "login page"},
        )
        assert up.status_code == 201, up.text
        file_id = up.json()["id"]
        down = client.get(f"/tasks/{task.id}/files/{file_id}", headers=h)
        assert down.content == PNG
        assert down.headers["x-content-type-options"] == "nosniff"
        assert "sandbox" in down.headers["content-security-policy"]
        detail = client.get(f"/tasks/{task.id}", headers=h).json()
        assert [f["name"] for f in detail["files"]] == ["screen.png"]
        assert client.delete(f"/tasks/{task.id}/files/{file_id}", headers=h).status_code == 200
        assert client.get(f"/tasks/{task.id}/files/{file_id}", headers=h).status_code == 404

    @pytest.mark.parametrize(
        "name,content",
        [("x.svg", b"<svg onload=alert(1)>"), ("x.html", b"<script>"), ("fake.png", b"not a png at all")],
    )
    def test_unsafe_or_fake_files_are_refused(self, client, auth, alice, make_task, name, content):
        task = make_task(assignee_1=alice)
        r = client.post(f"/tasks/{task.id}/files", headers=auth(alice), files={"upload": (name, content)})
        assert r.status_code == 422

    def test_size_limit(self, client, auth, alice, make_task, monkeypatch):
        monkeypatch.setattr(settings, "file_max_mb", 0)
        task = make_task(assignee_1=alice)
        r = client.post(f"/tasks/{task.id}/files", headers=auth(alice), files={"upload": ("a.txt", b"hello")})
        assert r.status_code == 413

    def test_text_files_pass_the_text_check(self, client, auth, alice, make_task):
        task = make_task(assignee_1=alice)
        r = client.post(
            f"/tasks/{task.id}/files", headers=auth(alice),
            files={"upload": ("env.txt", b"SECRET_KEY=abcdefghijk\n")},
        )
        assert r.status_code == 422


# --- context and library ----------------------------------------------------------


class TestContext:
    def test_repo_paths_and_the_library(self, client, auth, leader, alice, make_task):
        one = make_task(title="Accounts backend", assignee_1=alice)
        two = make_task(title="Accounts frontend", assignee_1=alice)
        h = auth(alice)
        link = {
            "kind": "repo_path", "repo": "J3ffar/Qader",
            "path": "plans/cross-team/2026-11-13/ready-accounts.md", "ref": "develop",
            "title": "Ready accounts plan", "summary": "Endpoint, CSV format, admin screen",
        }
        assert client.post(f"/tasks/{one.id}/context", headers=h, json=link).status_code == 201
        assert client.post(f"/tasks/{two.id}/context", headers=h, json=link).status_code == 201
        client.post(f"/tasks/{one.id}/docs", headers=h, json={"title": "Test plan", "kind": "test_plan"})

        library = client.get("/library", headers=h).json()
        kinds = sorted(i["kind"] for i in library)
        assert kinds == ["hub_doc", "repo_path"]  # the shared plan shows once
        found = client.get("/library?q=csv", headers=h).json()
        assert [i["path"] for i in found] == ["plans/cross-team/2026-11-13/ready-accounts.md"]

        brief = client.get(f"/tasks/{one.id}/brief", headers=h).json()
        assert any("ready-accounts.md" in c for c in brief["context"])
        assert any(d.startswith("test-plan v1") for d in brief["docs"])

    @pytest.mark.parametrize(
        "path", ["../secrets.md", "/etc/passwd", "C:/Users/x.md", "~/notes.md"]
    )
    def test_paths_outside_the_repo_are_refused(self, client, auth, alice, make_task, path):
        task = make_task(assignee_1=alice)
        r = client.post(
            f"/tasks/{task.id}/context", headers=auth(alice),
            json={"kind": "repo_path", "repo": "org/repo", "path": path, "title": "x"},
        )
        assert r.status_code == 422

    def test_urls_must_be_on_an_allowed_host(self, client, auth, alice, make_task):
        task = make_task(assignee_1=alice)
        h = auth(alice)
        ok = client.post(
            f"/tasks/{task.id}/context", headers=h,
            json={"kind": "url", "url": "https://github.com/org/repo/pull/12", "title": "PR"},
        )
        assert ok.status_code == 201
        for bad in ("https://evil.example.com/x", "http://github.com/x", "https://github.com.evil.io/x"):
            r = client.post(f"/tasks/{task.id}/context", headers=h, json={"kind": "url", "url": bad, "title": "x"})
            assert r.status_code == 422, bad

    def test_restricted_tasks_stay_out_of_the_library(self, client, auth, alice, bob, make_task, db_session):
        task = make_task(assignee_1=alice)
        client.post(f"/tasks/{task.id}/docs", headers=auth(alice), json={"title": "Secret plan"})
        task.restricted = True
        db_session.commit()
        assert client.get("/library", headers=auth(bob)).json() == []


class TestScopeFixes:
    def _token(self, client, auth, user, scopes):
        t = client.post("/auth/tokens", headers=auth(user), json={"name": "x", "scopes": scopes}).json()["token"]
        return {"Authorization": f"Bearer {t}", "X-Agent": "a1"}

    def test_reads_need_the_read_scope(self, client, auth, alice, make_task):
        task = make_task(assignee_1=alice)
        h = self._token(client, auth, alice, ["claims"])
        assert client.get("/library", headers=h).status_code == 403
        assert client.get(f"/tasks/{task.id}/docs", headers=h).status_code == 403

    def test_triage_needs_the_write_scope(self, client, auth, leader, make_task):
        task = make_task(status=TaskStatus.proposed)
        h = self._token(client, auth, leader, ["tasks:read", "claims"])
        r = client.post("/tasks/triage", headers=h, json={"task_ids": [task.id], "to": "to_do"})
        assert r.status_code == 403

    def test_from_bots_filter(self, client, auth, leader, alice, bot):
        client.post("/tasks", headers=bot["headers"], json={"title": "bot finding"})
        h = self._token(client, auth, alice, ["tasks:read", "tasks:create"])
        client.post("/tasks", headers=h, json={"title": "member agent idea", "status": "proposed"})
        rows = client.get("/tasks?status_filter=proposed&from_bots=true", headers=auth(leader)).json()
        assert [r["title"] for r in rows] == ["bot finding"]

    def test_context_and_files_name_who_added_them(self, client, auth, alice, make_task):
        task = make_task(assignee_1=alice)
        h = self._token(client, auth, alice, ["tasks:read", "docs:write"])
        client.post(f"/tasks/{task.id}/context", headers=h,
                    json={"kind": "url", "url": "https://github.com/o/r", "title": "repo"})
        client.post(f"/tasks/{task.id}/files", headers=h, files={"upload": ("a.txt", b"hello")})
        detail = client.get(f"/tasks/{task.id}", headers=auth(alice)).json()
        assert detail["context"][0]["adder"]["id"] == alice.id
        assert detail["context"][0]["agent_name"] == "a1"
        assert detail["files"][0]["uploader"]["id"] == alice.id
        brief = client.get(f"/tasks/{task.id}/brief", headers=auth(alice)).json()
        assert brief["files"] == ["a.txt (5 B)"]

    def test_restore_with_a_stale_base_conflicts(self, client, auth, alice, make_task):
        task = make_task(assignee_1=alice)
        h = auth(alice)
        client.post(f"/tasks/{task.id}/docs", headers=h, json={"title": "N", "body": "a"})
        client.put(f"/tasks/{task.id}/docs/n", headers=h, json={"body": "b", "base_version": 1})
        r = client.post(f"/tasks/{task.id}/docs/n/restore/1?base_version=1", headers=h)
        assert r.status_code == 409


def test_bots_are_never_assignable(client, auth, leader, bot):
    r = client.post("/tasks", headers=auth(leader), json={"title": "x", "assignee_1_id": bot["id"]})
    assert r.status_code == 422
    members = client.get("/auth/users?role=member", headers=auth(leader)).json()
    assert bot["id"] not in [u["id"] for u in members]
