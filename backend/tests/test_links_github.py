"""Task kinds and templates, fingerprints, task links and subtasks, and the
GitHub webhook."""

from __future__ import annotations

import hashlib
import hmac
import json

import pytest

from app.config import settings
from app.models import CriterionState, Task, TaskStatus

BUG = "Steps:\n1. open /login\n2. submit\n\nExpected: a session\nActual: 500\n"


class TestKinds:
    def test_templates_are_listed(self, client, auth, alice):
        kinds = {t["kind"]: t for t in client.get("/tasks/templates", headers=auth(alice)).json()}
        assert kinds["bug"]["required"] == ["Steps:", "Expected:", "Actual:"]
        assert "Steps:" in kinds["bug"]["skeleton"]

    def test_a_bug_without_steps_is_refused(self, client, auth, leader):
        r = client.post("/tasks", headers=auth(leader), json={"title": "Login broken", "kind": "bug",
                                                               "description": "it breaks"})
        assert r.status_code == 422 and "Steps:" in r.json()["detail"]

    def test_a_good_bug_gets_the_template_criteria(self, client, auth, leader):
        r = client.post("/tasks", headers=auth(leader), json={"title": "Login broken", "kind": "bug",
                                                               "description": BUG})
        assert r.status_code == 201
        body = r.json()
        assert body["kind"] == "bug"
        assert [c["text"] for c in body["criteria"]] == ["The steps no longer reproduce the bug",
                                                         "A test covers the case"]

    def test_own_criteria_win_and_templates_can_be_skipped(self, client, auth, leader):
        own = client.post("/tasks", headers=auth(leader), json={
            "title": "x", "kind": "chore", "criteria": ["Only this"]}).json()
        assert [c["text"] for c in own["criteria"]] == ["Only this"]
        bare = client.post("/tasks", headers=auth(leader), json={
            "title": "y", "kind": "chore", "use_template": False}).json()
        assert bare["criteria"] == []


class TestFingerprint:
    def test_an_open_duplicate_is_noted_not_copied(self, client, auth, leader):
        body = {"title": "N+1 on students list", "fingerprint": "n-plus-one:students/views.py:list"}
        first = client.post("/tasks", headers=auth(leader), json=body).json()
        again = client.post("/tasks", headers=auth(leader), json=body)
        assert again.status_code == 200
        assert again.json()["id"] == first["id"] and again.json()["duplicate_of_existing"] is True
        assert again.json()["events"][-1]["event_type"] == "seen_again"

    def test_a_recently_dropped_finding_is_not_filed_again(self, client, auth, leader):
        body = {"title": "Unused import", "fingerprint": "unused:admin/x.py:os"}
        tid = client.post("/tasks", headers=auth(leader), json=body).json()["id"]
        client.patch(f"/tasks/{tid}/status", headers=auth(leader), json={"status": "dropped", "comment": "won't fix"})
        r = client.post("/tasks", headers=auth(leader), json=body)
        assert r.status_code == 409 and "won't fix" in r.json()["detail"]


class TestLinks:
    def test_a_blocker_keeps_a_task_out_of_ready_and_unclaimable(self, client, auth, leader, alice, make_task):
        api_task = make_task(title="API", assignee_1=alice)
        screen = make_task(title="Screen", assignee_1=alice)
        h = auth(alice)
        r = client.post(f"/tasks/{api_task.id}/links", headers=h, json={"kind": "blocks", "to_task_id": screen.id})
        assert r.status_code == 201
        assert "this task blocks" in r.json()["links"][0]["label"]
        ready = [t["id"] for t in client.get("/tasks?ready=true", headers=h).json()]
        assert screen.id not in ready and api_task.id in ready
        assert client.post(f"/tasks/{screen.id}/claim", headers=h, json={}).status_code == 409
        assert client.patch(f"/tasks/{screen.id}/status", headers=h, json={"status": "in_progress"}).status_code == 409
        detail = client.get(f"/tasks/{screen.id}", headers=h).json()
        assert detail["blocked_by"] == [api_task.id]

        # Finishing the blocker frees it.
        for to in ("in_progress", "in_review"):
            client.patch(f"/tasks/{api_task.id}/status", headers=h, json={"status": to})
        client.patch(f"/tasks/{api_task.id}/status", headers=auth(leader), json={"status": "done"})
        assert client.post(f"/tasks/{screen.id}/claim", headers=h, json={}).status_code == 200

    def test_loops_are_refused(self, client, auth, leader, make_task):
        a, b, c = make_task(title="a"), make_task(title="b"), make_task(title="c")
        h = auth(leader)
        client.post(f"/tasks/{a.id}/links", headers=h, json={"kind": "blocks", "to_task_id": b.id})
        client.post(f"/tasks/{b.id}/links", headers=h, json={"kind": "blocks", "to_task_id": c.id})
        r = client.post(f"/tasks/{c.id}/links", headers=h, json={"kind": "blocks", "to_task_id": a.id})
        assert r.status_code == 409

    def test_unlink(self, client, auth, leader, make_task):
        a, b = make_task(title="a"), make_task(title="b")
        h = auth(leader)
        link_id = client.post(f"/tasks/{a.id}/links", headers=h, json={"kind": "relates", "to_task_id": b.id}).json()["links"][0]["id"]
        assert client.get(f"/tasks/{b.id}", headers=h).json()["links"][0]["direction"] == "incoming"
        assert client.delete(f"/tasks/{b.id}/links/{link_id}", headers=h).json()["links"] == []

    def test_people_outside_both_tasks_cannot_link(self, client, auth, alice, bob, make_task):
        a, b = make_task(title="a", assignee_1=alice), make_task(title="b", assignee_1=alice)
        r = client.post(f"/tasks/{a.id}/links", headers=auth(bob), json={"kind": "relates", "to_task_id": b.id})
        assert r.status_code == 403


class TestSubtasks:
    def test_two_levels_and_the_done_gate(self, client, auth, leader, alice):
        h = auth(leader)
        parent = client.post("/tasks", headers=h, json={"title": "Ready accounts"}).json()
        fe = client.post("/tasks", headers=h, json={"title": "Screen", "parent_id": parent["id"], "side": "fe"}).json()
        deeper = client.post("/tasks", headers=h, json={"title": "x", "parent_id": fe["id"]})
        assert deeper.status_code == 422
        detail = client.get(f"/tasks/{parent['id']}", headers=h).json()
        assert [c["id"] for c in detail["children"]] == [fe["id"]] and detail["children_open"] == 1
        child = client.get(f"/tasks/{fe['id']}", headers=h).json()
        assert child["parent"]["id"] == parent["id"]

        for to in ("in_progress", "in_review"):
            client.patch(f"/tasks/{parent['id']}/status", headers=h, json={"status": to})
        r = client.patch(f"/tasks/{parent['id']}/status", headers=h, json={"status": "done"})
        assert r.status_code == 409 and f"#{fe['id']}" in r.json()["detail"]

    def test_a_parent_cannot_become_a_subtask(self, client, auth, leader):
        h = auth(leader)
        p = client.post("/tasks", headers=h, json={"title": "p"}).json()
        client.post("/tasks", headers=h, json={"title": "c", "parent_id": p["id"]})
        other = client.post("/tasks", headers=h, json={"title": "o"}).json()
        r = client.patch(f"/tasks/{p['id']}", headers=h, json={"parent_id": other["id"]})
        assert r.status_code == 422

    def test_brief_shows_family_and_blockers(self, client, auth, leader):
        h = auth(leader)
        p = client.post("/tasks", headers=h, json={"title": "Parent"}).json()
        c = client.post("/tasks", headers=h, json={"title": "Child", "parent_id": p["id"]}).json()
        blocker = client.post("/tasks", headers=h, json={"title": "Blocker"}).json()
        client.post(f"/tasks/{blocker['id']}/links", headers=h, json={"kind": "blocks", "to_task_id": c["id"]})
        brief = client.get(f"/tasks/{c['id']}/brief", headers=h).json()
        assert brief["parent"].startswith(f"#{p['id']}")
        assert brief["blocked_by"] == [f"#{blocker['id']}"]
        assert any("Child" in x for x in client.get(f"/tasks/{p['id']}/brief", headers=h).json()["children"])


# --- GitHub webhook ---------------------------------------------------------------

SECRET = "webhook-test-secret"
REPO = "J3ffar/Qader"


@pytest.fixture()
def github_on(monkeypatch):
    monkeypatch.setattr(settings, "github_webhook_secret", SECRET)
    monkeypatch.setattr(settings, "github_repos", REPO)
    monkeypatch.setattr(settings, "github_deploy_rules", "develop=staging,main=production")


def _hook(client, event, payload, secret=SECRET):
    body = json.dumps(payload).encode()
    sig = "sha256=" + hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
    return client.post("/github/webhook", content=body,
                       headers={"X-GitHub-Event": event, "X-Hub-Signature-256": sig,
                                "Content-Type": "application/json"})


def _pr(number, title, head, base="develop", merged=False, author="MEMBER", merged_at="2026-11-13T10:00:00Z"):
    return {
        "action": "closed" if merged else "opened",
        "repository": {"full_name": REPO},
        "pull_request": {
            "number": number, "title": title, "html_url": f"https://github.com/{REPO}/pull/{number}",
            "state": "closed" if merged else "open", "merged": merged,
            "merged_at": merged_at if merged else None, "author_association": author,
            "head": {"ref": head}, "base": {"ref": base},
        },
    }


class TestGithub:
    def test_off_without_a_secret(self, client):
        assert client.post("/github/webhook", content=b"{}").status_code == 404

    def test_bad_signature_and_other_repos(self, client, github_on):
        assert _hook(client, "ping", {}, secret="wrong").status_code == 401
        assert _hook(client, "ping", {}).json()["event"] == "ping"
        r = _hook(client, "push", {"repository": {"full_name": "evil/repo"}, "ref": "refs/heads/feat/HUB-1-x"})
        assert "not in GITHUB_REPOS" in r.json()["ignored"]

    def test_push_links_branch_and_commits(self, client, auth, alice, make_task, github_on):
        task = make_task(assignee_1=alice)
        sha = "a" * 40
        r = _hook(client, "push", {
            "repository": {"full_name": REPO}, "ref": f"refs/heads/feat/HUB-{task.id}-csv",
            "commits": [{"id": sha, "message": "Add CSV export\n\nbody", "url": f"https://github.com/{REPO}/commit/{sha}"}],
        })
        assert r.json()["tasks"] == [task.id]
        links = client.get(f"/tasks/{task.id}", headers=auth(alice)).json()["git_links"]
        kinds = sorted((l["kind"], l["actor_kind"]) for l in links)
        assert kinds == [("branch", "system"), ("commit", "system")]
        assert [l["title"] for l in links if l["kind"] == "commit"] == ["Add CSV export"]

    def test_merged_pr_moves_work_to_review_and_tells_leads(self, client, auth, leader, alice, make_task, github_on, db_session):
        task = make_task(status=TaskStatus.in_progress, assignee_1=alice)
        _hook(client, "pull_request", _pr(12, f"HUB-{task.id}: CSV export", f"feat/HUB-{task.id}-csv"))
        detail = client.get(f"/tasks/{task.id}", headers=auth(alice)).json()
        assert [l["state"] for l in detail["git_links"] if l["kind"] == "pr"] == ["open"]
        assert detail["status"] == "in_progress"

        _hook(client, "pull_request", _pr(12, f"HUB-{task.id}: CSV export", f"feat/HUB-{task.id}-csv", merged=True))
        detail = client.get(f"/tasks/{task.id}", headers=auth(alice)).json()
        assert detail["status"] == "in_review"
        pr = [l for l in detail["git_links"] if l["kind"] == "pr"][0]
        assert pr["state"] == "merged" and pr["base_ref"] == "develop"
        lead_kinds = [n["kind"] for n in client.get("/notifications", headers=auth(leader)).json()]
        assert "review" in lead_kinds

    def test_open_criteria_keep_a_merged_task_in_progress(self, client, auth, leader, alice, github_on):
        t = client.post("/tasks", headers=auth(leader), json={
            "title": "x", "assignee_1_id": alice.id, "criteria": ["c"]}).json()
        client.patch(f"/tasks/{t['id']}/status", headers=auth(alice), json={"status": "in_progress"})
        _hook(client, "pull_request", _pr(13, "x", f"feat/HUB-{t['id']}-x", merged=True))
        assert client.get(f"/tasks/{t['id']}", headers=auth(alice)).json()["status"] == "in_progress"

    def test_outsiders_and_pr_bodies_do_not_move_tasks(self, client, auth, alice, make_task, github_on):
        task = make_task(status=TaskStatus.in_progress, assignee_1=alice)
        r = _hook(client, "pull_request", _pr(14, f"HUB-{task.id}", f"feat/HUB-{task.id}", merged=True, author="NONE"))
        assert "not a repo member" in r.json()["ignored"]
        payload = _pr(15, "unrelated", "fix/typo", merged=True)
        payload["pull_request"]["body"] = f"closes HUB-{task.id}"
        assert _hook(client, "pull_request", payload).json()["tasks"] == []

    def test_deploy_runs_move_deploy_state_forward(self, client, auth, alice, make_task, github_on):
        task = make_task(status=TaskStatus.in_review, assignee_1=alice)
        _hook(client, "pull_request", _pr(16, f"HUB-{task.id}", f"feat/HUB-{task.id}", merged=True,
                                          merged_at="2026-11-13T10:00:00Z"))

        def run(branch, started):
            return {"action": "completed", "repository": {"full_name": REPO},
                    "workflow_run": {"id": 99, "name": "Deploy", "conclusion": "success",
                                     "head_branch": branch, "run_started_at": started}}

        assert _hook(client, "workflow_run", run("develop", "2026-11-13T09:00:00Z")).json()["tasks"] == []  # merged later
        assert _hook(client, "workflow_run", run("develop", "2026-11-13T11:00:00Z")).json()["tasks"] == [task.id]
        assert client.get(f"/tasks/{task.id}", headers=auth(alice)).json()["deploy_state"] == "staging"
        _hook(client, "workflow_run", run("main", "2026-11-14T08:00:00Z"))
        assert client.get(f"/tasks/{task.id}", headers=auth(alice)).json()["deploy_state"] == "production"
        # Never back.
        assert _hook(client, "workflow_run", run("develop", "2026-11-15T08:00:00Z")).json()["tasks"] == []


# --- split by side ------------------------------------------------------------------


class TestSplit:
    @pytest.fixture()
    def team(self, db_session, alice, bob, carol):
        alice.handle, alice.sides = "alice", ["be"]
        bob.handle, bob.sides = "bob", ["fe"]
        carol.handle, carol.sides = "carol", ["content"]
        db_session.commit()

    def test_split_into_parts_with_people_pool_and_order(self, client, auth, leader, alice, bob, carol, team):
        h = auth(leader)
        parent = client.post("/tasks", headers=h, json={
            "title": "Ready accounts", "priority": "high", "tags": ["accounts"]}).json()
        r = client.post(f"/tasks/{parent['id']}/split", headers=h, json={
            "parts": [
                {"side": "be", "assignee_id": alice.id, "criteria": ["Endpoint returns a CSV"]},
                {"side": "fe"},
                {"side": "content", "title": "Arabic and English copy for the screen"},
            ],
            "order": [{"before": "be", "after": "fe"}],
        })
        assert r.status_code == 201, r.text
        roster = {c["side"]: c for c in r.json()["children"]}
        assert roster["be"]["assignees"] == ["alice"] and roster["be"]["pool"] is False
        assert roster["fe"]["pool"] is True and roster["fe"]["title"] == "Ready accounts (Frontend)"
        assert roster["content"]["title"] == "Arabic and English copy for the screen"

        fe = client.get(f"/tasks/{roster['fe']['id']}", headers=h).json()
        assert fe["blocked_by"] == [roster["be"]["id"]]
        assert fe["priority"] == "high" and fe["tags"] == ["accounts"]
        assert [n["kind"] for n in client.get("/notifications", headers=auth(alice)).json()] == ["assigned"]

    def test_pool_parts_go_to_people_on_that_side(self, client, auth, leader, alice, bob, carol, team):
        h = auth(leader)
        parent = client.post("/tasks", headers=h, json={"title": "Page"}).json()
        out = client.post(f"/tasks/{parent['id']}/split", headers=h, json={"parts": [{"side": "fe"}]}).json()
        fe_id = out["children"][0]["id"]
        wrong = client.post(f"/tasks/{fe_id}/claim", headers=auth(alice), json={})
        assert wrong.status_code == 403 and "Frontend" in wrong.json()["detail"]
        right = client.post(f"/tasks/{fe_id}/claim", headers=auth(bob), json={})
        assert right.status_code == 200
        roster = client.get(f"/tasks/{parent['id']}", headers=h).json()["children"]
        assert roster[0]["claim_holder"] == "bob"

    def test_first_part_started_starts_the_parent_and_leads_hear_when_all_close(
        self, client, auth, leader, alice, bob, team, db_session
    ):
        h = auth(leader)
        parent = client.post("/tasks", headers=h, json={"title": "Feature"}).json()
        out = client.post(f"/tasks/{parent['id']}/split", headers=h, json={
            "parts": [{"side": "be", "assignee_id": alice.id}, {"side": "fe", "assignee_id": bob.id}]}).json()
        be, fe = (c["id"] for c in out["children"])
        client.post(f"/tasks/{be}/claim", headers=auth(alice), json={})
        assert client.get(f"/tasks/{parent['id']}", headers=h).json()["status"] == "in_progress"

        for tid, who in ((be, alice), (fe, bob)):
            client.patch(f"/tasks/{tid}/status", headers=auth(who), json={"status": "in_progress"})
            client.patch(f"/tasks/{tid}/status", headers=auth(who), json={"status": "in_review"})
            client.patch(f"/tasks/{tid}/status", headers=h, json={"status": "done"})
        from app.models import Role
        from tests.conftest import make_user

        second_lead = make_user(db_session, "Lead Two", "lead2@example.com", Role.leader)
        # Reopen nothing; the second lead was not there yet, so close a fresh family.
        p2 = client.post("/tasks", headers=h, json={"title": "Feature 2"}).json()
        kid = client.post(f"/tasks/{p2['id']}/split", headers=h,
                          json={"parts": [{"side": "be", "assignee_id": alice.id}]}).json()["children"][0]["id"]
        client.patch(f"/tasks/{kid}/status", headers=auth(alice), json={"status": "in_progress"})
        client.patch(f"/tasks/{kid}/status", headers=auth(alice), json={"status": "in_review"})
        client.patch(f"/tasks/{kid}/status", headers=h, json={"status": "done"})
        notes = client.get("/notifications", headers=auth(second_lead)).json()
        assert any("Every subtask" in (n["text"] or "") for n in notes)

    def test_split_rules(self, client, auth, leader, alice, team):
        h = auth(leader)
        parent = client.post("/tasks", headers=h, json={"title": "P"}).json()
        client.post(f"/tasks/{parent['id']}/split", headers=h, json={"parts": [{"side": "be"}]})
        again = client.post(f"/tasks/{parent['id']}/split", headers=h, json={"parts": [{"side": "be"}]})
        assert again.status_code == 409  # already covered
        dup = client.post(f"/tasks/{parent['id']}/split", headers=h, json={"parts": [{"side": "fe"}, {"side": "fe"}]})
        assert dup.status_code == 422
        # A member may split their own task into pool parts, not assign them.
        mine = client.post("/tasks", headers=h, json={"title": "M", "assignee_1_id": alice.id}).json()
        assigned = client.post(f"/tasks/{mine['id']}/split", headers=auth(alice),
                               json={"parts": [{"side": "fe", "assignee_id": alice.id}]})
        assert assigned.status_code == 403
        pooled = client.post(f"/tasks/{mine['id']}/split", headers=auth(alice), json={"parts": [{"side": "fe"}]})
        assert pooled.status_code == 201


def test_list_filters_pool_parts_for_my_sides(client, auth, leader, alice, db_session):
    alice.sides = ["fe"]
    db_session.commit()
    h = auth(leader)
    p = client.post("/tasks", headers=h, json={"title": "P"}).json()
    client.post(f"/tasks/{p['id']}/split", headers=h, json={"parts": [{"side": "fe"}, {"side": "be"}]})
    rows = client.get("/tasks?pool=true&my_sides=true&status_filter=to_do", headers=auth(alice)).json()
    assert [r["side"] for r in rows] == ["fe"]
