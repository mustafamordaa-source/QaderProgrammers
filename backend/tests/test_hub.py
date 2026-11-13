"""Agent-hub features: API tokens, actor kind, claims, comments and questions,
acceptance criteria, git links, deploy state, brief, inbox, text lint, limits."""

from __future__ import annotations

from datetime import timedelta

import pytest

from app import ratelimit
from app.config import Settings, check_production_settings, settings
from app.models import ApiToken, Task, TaskStatus, utcnow

HANDBACK = "Summary: login works\nChecks run: pytest, 12 passed\nLeft: nothing\n"


@pytest.fixture()
def token(client, auth):
    """Create an API token for a user and return agent headers."""

    def _token(user, *, scopes=None, agent="be-agent-1"):
        body = {"name": "laptop agent", "expires_days": 7}
        if scopes is not None:
            body["scopes"] = scopes
        response = client.post("/auth/tokens", headers=auth(user), json=body)
        assert response.status_code == 201, response.text
        headers = {"Authorization": f"Bearer {response.json()['token']}"}
        if agent:
            headers["X-Agent"] = agent
        return headers

    return _token


# --- tokens -----------------------------------------------------------------


class TestTokens:
    def test_token_is_shown_once_and_stored_hashed(self, client, auth, alice, db_session):
        created = client.post("/auth/tokens", headers=auth(alice), json={"name": "cli"}).json()
        assert created["token"].startswith("qhub_")
        row = db_session.get(ApiToken, created["id"])
        assert created["token"].split("_", 2)[2] not in row.secret_hash
        listed = client.get("/auth/tokens", headers=auth(alice)).json()
        assert "token" not in listed[0]

    def test_a_token_authenticates_as_its_owner(self, client, alice, token):
        me = client.get("/auth/me", headers=token(alice)).json()
        assert me["email"] == alice.email

    def test_tokens_cannot_mint_tokens(self, client, alice, token):
        response = client.post("/auth/tokens", headers=token(alice), json={"name": "x"})
        assert response.status_code == 403

    def test_revoked_and_expired_tokens_stop_working(self, client, auth, alice, token, db_session):
        headers = token(alice)
        token_id = client.get("/auth/tokens", headers=auth(alice)).json()[0]["id"]
        assert client.delete(f"/auth/tokens/{token_id}", headers=auth(alice)).status_code == 200
        assert client.get("/auth/me", headers=headers).status_code == 401

        headers = token(alice)
        row = db_session.query(ApiToken).filter(ApiToken.revoked_at.is_(None)).one()
        row.expires_at = utcnow() - timedelta(minutes=1)
        db_session.commit()
        assert client.get("/auth/me", headers=headers).status_code == 401

    def test_expiry_is_capped(self, client, auth, alice):
        response = client.post(
            "/auth/tokens", headers=auth(alice), json={"name": "x", "expires_days": 365}
        )
        assert response.status_code == 422

    def test_unknown_scopes_are_refused(self, client, auth, alice):
        response = client.post(
            "/auth/tokens", headers=auth(alice), json={"name": "x", "scopes": ["root"]}
        )
        assert response.status_code == 422

    def test_scopes_limit_what_a_token_does(self, client, alice, token, make_task):
        task = make_task(assignee_1=alice)
        headers = token(alice, scopes=["tasks:read"])
        assert client.get(f"/tasks/{task.id}", headers=headers).status_code == 200
        response = client.post(f"/tasks/{task.id}/claim", headers=headers, json={})
        assert response.status_code == 403
        assert "claims" in response.json()["detail"]

    def test_writes_need_an_agent_name(self, client, alice, token, make_task):
        task = make_task(assignee_1=alice)
        for name in (None, "unknown"):
            headers = token(alice, agent=name)
            response = client.post(f"/tasks/{task.id}/claim", headers=headers, json={})
            assert response.status_code == 400

    def test_deactivating_a_person_revokes_their_tokens(self, client, auth, leader, alice, token):
        headers = token(alice)
        client.patch(f"/users/{alice.id}", headers=auth(leader), json={"is_active": False})
        assert client.get("/auth/me", headers=headers).status_code in {401, 403}

    def test_leader_can_revoke_anyones_token(self, client, auth, leader, alice, token):
        token(alice)
        token_id = client.get("/auth/tokens", headers=auth(alice)).json()[0]["id"]
        assert client.delete(f"/auth/tokens/{token_id}", headers=auth(leader)).status_code == 200


# --- actor kind -----------------------------------------------------------------


class TestActorKind:
    def test_agent_writes_are_marked_agent(self, client, auth, alice, token):
        headers = token(alice, agent="fe-agent-2")
        created = client.post("/tasks", headers=headers, json={"title": "Found a bug"}).json()
        assert created["created_kind"] == "agent"
        assert created["created_agent"] == "fe-agent-2"
        assert created["events"][0]["actor_kind"] == "agent"
        assert created["events"][0]["agent_name"] == "fe-agent-2"

    def test_browser_writes_are_marked_human(self, client, auth, leader):
        created = client.post("/tasks", headers=auth(leader), json={"title": "Plan"}).json()
        assert created["created_kind"] == "human"
        assert created["created_agent"] is None

    def test_the_kind_cannot_be_forged_in_the_body(self, client, auth, leader):
        created = client.post(
            "/tasks", headers=auth(leader), json={"title": "x", "created_kind": "agent"}
        ).json()
        assert created["created_kind"] == "human"


# --- claims -----------------------------------------------------------------


class TestClaims:
    def test_claiming_a_to_do_task_starts_it(self, client, alice, token, make_task):
        task = make_task(assignee_1=alice)
        body = client.post(
            f"/tasks/{task.id}/claim", headers=token(alice), json={"branch": "feat/HUB-1-x"}
        ).json()
        assert body["status"] == "in_progress"
        assert body["claim_agent"] == "be-agent-1"
        assert body["claim_branch"] == "feat/HUB-1-x"

    def test_two_agents_cannot_hold_one_task(self, client, alice, token, make_task):
        task = make_task(assignee_1=alice)
        first = token(alice, agent="agent-a")
        second = token(alice, agent="agent-b")
        assert client.post(f"/tasks/{task.id}/claim", headers=first, json={}).status_code == 200
        response = client.post(f"/tasks/{task.id}/claim", headers=second, json={})
        assert response.status_code == 409
        assert "agent-a" in response.json()["detail"]

    def test_the_holder_renews(self, client, alice, token, make_task):
        task = make_task(assignee_1=alice)
        headers = token(alice)
        client.post(f"/tasks/{task.id}/claim", headers=headers, json={})
        assert client.post(f"/tasks/{task.id}/claim", headers=headers, json={}).status_code == 200

    def test_an_expired_claim_can_be_taken(self, client, alice, token, make_task, db_session):
        task = make_task(assignee_1=alice)
        client.post(f"/tasks/{task.id}/claim", headers=token(alice, agent="old"), json={})
        db_session.expire_all()
        row = db_session.get(Task, task.id)
        row.claim_expires_at = utcnow() - timedelta(minutes=1)
        db_session.commit()
        response = client.post(f"/tasks/{task.id}/claim", headers=token(alice, agent="new"), json={})
        assert response.status_code == 200
        assert response.json()["claim_agent"] == "new"

    def test_members_claim_only_their_tasks_or_pool_tasks(self, client, alice, bob, token, make_task, db_session):
        task = make_task(assignee_1=alice)
        assert client.post(f"/tasks/{task.id}/claim", headers=token(bob), json={}).status_code == 403
        task.pool = True
        db_session.commit()
        assert client.post(f"/tasks/{task.id}/claim", headers=token(bob), json={}).status_code == 200

    def test_release_clears_the_claim(self, client, alice, token, make_task):
        task = make_task(assignee_1=alice)
        headers = token(alice)
        client.post(f"/tasks/{task.id}/claim", headers=headers, json={})
        body = client.post(f"/tasks/{task.id}/release", headers=headers).json()
        assert body["claimed_by"] is None
        assert body["events"][-1]["event_type"] == "released"

    def test_ready_lists_claimable_work_only(self, client, auth, alice, token, make_task):
        free = make_task(title="free", assignee_1=alice)
        taken = make_task(title="taken", assignee_1=alice)
        client.post(f"/tasks/{taken.id}/claim", headers=token(alice), json={})
        ready = client.get("/tasks?ready=true", headers=auth(alice)).json()
        assert [t["id"] for t in ready] == [free.id]

    def test_claim_warns_on_wip_and_shared_areas(self, client, auth, leader, alice, token, make_task, db_session):
        one = make_task(title="one", assignee_1=alice)
        two = make_task(title="two", assignee_1=alice)
        three = make_task(title="three", assignee_1=alice)
        for t in (one, two, three):
            t.areas = ["backend/app"]
        db_session.commit()
        headers = token(alice)
        client.post(f"/tasks/{one.id}/claim", headers=headers, json={})
        client.post(f"/tasks/{two.id}/claim", headers=headers, json={})
        body = client.post(f"/tasks/{three.id}/claim", headers=headers, json={}).json()
        assert any("WIP" in w for w in body["warnings"])
        assert any("same area" in w for w in body["warnings"])


# --- comments and questions ---------------------------------------------------


class TestComments:
    def test_question_with_wait_parks_the_task_until_answered(
        self, client, auth, leader, alice, token, make_task, db_session
    ):
        leader.handle = "lead"
        db_session.commit()
        task = make_task(status=TaskStatus.in_progress, assignee_1=alice)
        q = client.post(
            f"/tasks/{task.id}/comments",
            headers=token(alice),
            json={"kind": "question", "body": "Which endpoint?", "to": "lead", "wait": True},
        ).json()
        detail = client.get(f"/tasks/{task.id}", headers=auth(alice)).json()
        assert detail["status"] == "needs_confirm"
        assert detail["open_questions"] == 1

        inbox = client.get("/tasks/inbox", headers=auth(leader)).json()
        assert any(i["comment_id"] == q["id"] for i in inbox)

        client.post(
            f"/tasks/{task.id}/comments",
            headers=auth(leader),
            json={"kind": "answer", "body": "Use /auth/tokens", "parent_id": q["id"]},
        )
        detail = client.get(f"/tasks/{task.id}", headers=auth(alice)).json()
        assert detail["status"] == "in_progress"
        assert detail["open_questions"] == 0

    def test_a_question_needs_someone_to_ask(self, client, alice, token, make_task):
        task = make_task(assignee_1=alice)
        response = client.post(
            f"/tasks/{task.id}/comments", headers=token(alice), json={"kind": "question", "body": "?"}
        )
        assert response.status_code == 422

    def test_threads_are_one_level_deep(self, client, auth, alice, make_task):
        task = make_task(assignee_1=alice)
        top = client.post(f"/tasks/{task.id}/comments", headers=auth(alice), json={"body": "a"}).json()
        reply = client.post(
            f"/tasks/{task.id}/comments", headers=auth(alice), json={"body": "b", "parent_id": top["id"]}
        ).json()
        response = client.post(
            f"/tasks/{task.id}/comments", headers=auth(alice), json={"body": "c", "parent_id": reply["id"]}
        )
        assert response.status_code == 422

    def test_handback_needs_its_headings_and_updates_the_summary(self, client, alice, token, make_task):
        task = make_task(status=TaskStatus.in_progress, assignee_1=alice)
        headers = token(alice)
        bad = client.post(
            f"/tasks/{task.id}/comments", headers=headers, json={"kind": "handback", "body": "done!"}
        )
        assert bad.status_code == 422
        ok = client.post(
            f"/tasks/{task.id}/comments", headers=headers, json={"kind": "handback", "body": HANDBACK}
        )
        assert ok.status_code == 201
        assert client.get(f"/tasks/{task.id}", headers=headers).json()["summary"] == "login works"

    def test_viewers_cannot_comment(self, client, auth, db_session, make_task):
        from tests.conftest import make_user
        from app.models import Role

        viewer = make_user(db_session, "Manager", "manager@example.com", Role.viewer)
        task = make_task()
        assert client.get(f"/tasks/{task.id}", headers=auth(viewer)).status_code == 200
        response = client.post(f"/tasks/{task.id}/comments", headers=auth(viewer), json={"body": "hi"})
        assert response.status_code == 403


# --- the contract: criteria, review gate ---------------------------------------


class TestCriteria:
    def test_open_criteria_block_review_and_done(self, client, auth, leader, alice, token):
        created = client.post(
            "/tasks",
            headers=auth(leader),
            json={"title": "Feature", "assignee_1_id": alice.id, "criteria": ["API returns 201", "Tests pass"]},
        ).json()
        task_id = created["id"]
        assert [c["n"] for c in created["criteria"]] == [1, 2]
        headers = token(alice)
        client.post(f"/tasks/{task_id}/claim", headers=headers, json={})
        client.post(f"/tasks/{task_id}/comments", headers=headers, json={"kind": "handback", "body": HANDBACK})

        blocked = client.patch(f"/tasks/{task_id}/status", headers=headers, json={"status": "in_review"})
        assert blocked.status_code == 409
        assert "1, 2" in blocked.json()["detail"]

        no_evidence = client.patch(f"/tasks/{task_id}/criteria/1", headers=headers, json={"state": "met"})
        assert no_evidence.status_code == 422

        met = client.patch(
            f"/tasks/{task_id}/criteria/1",
            headers=headers,
            json={"state": "met", "evidence": "curl -X POST ... -> 201"},
        ).json()
        assert met["checked_kind"] == "agent"
        client.patch(f"/tasks/{task_id}/criteria/2", headers=headers, json={"state": "dropped", "evidence": "covered by 1"})
        assert client.patch(f"/tasks/{task_id}/status", headers=headers, json={"status": "in_review"}).status_code == 200

    def test_agents_hand_back_before_review(self, client, alice, token, make_task):
        task = make_task(assignee_1=alice)
        headers = token(alice)
        client.post(f"/tasks/{task.id}/claim", headers=headers, json={})
        response = client.patch(f"/tasks/{task.id}/status", headers=headers, json={"status": "in_review"})
        assert response.status_code == 409
        assert "hand-back" in response.json()["detail"]

    def test_review_releases_the_claim(self, client, alice, token, make_task):
        task = make_task(assignee_1=alice)
        headers = token(alice)
        client.post(f"/tasks/{task.id}/claim", headers=headers, json={})
        client.post(f"/tasks/{task.id}/comments", headers=headers, json={"kind": "handback", "body": HANDBACK})
        body = client.patch(f"/tasks/{task.id}/status", headers=headers, json={"status": "in_review"}).json()
        assert body["claimed_by"] is None


# --- parking, dropping, versions -----------------------------------------------


class TestWorkflow:
    def test_blocked_returns_to_where_it_was(self, client, auth, alice, make_task):
        task = make_task(status=TaskStatus.in_progress, assignee_1=alice)
        h = auth(alice)
        body = client.patch(f"/tasks/{task.id}/status", headers=h, json={"status": "blocked"}).json()
        assert body["resume_status"] == "in_progress"
        body = client.patch(f"/tasks/{task.id}/status", headers=h, json={"status": "in_progress"}).json()
        assert body["status"] == "in_progress" and body["resume_status"] is None

    def test_dropping_needs_a_reason(self, client, auth, leader, make_task):
        task = make_task()
        h = auth(leader)
        assert client.patch(f"/tasks/{task.id}/status", headers=h, json={"status": "dropped"}).status_code == 422
        body = client.patch(
            f"/tasks/{task.id}/status", headers=h, json={"status": "dropped", "comment": "duplicate"}
        ).json()
        assert body["drop_reason"] == "duplicate"

    def test_stale_version_is_a_conflict(self, client, auth, leader, alice, make_task):
        task = make_task(assignee_1=alice)
        h = auth(leader)
        v = client.get(f"/tasks/{task.id}", headers=h).json()["version"]
        client.patch(f"/tasks/{task.id}", headers=h, json={"title": "renamed", "expected_version": v})
        stale = client.patch(f"/tasks/{task.id}", headers=h, json={"title": "again", "expected_version": v})
        assert stale.status_code == 409

    def test_members_edit_only_summary_tags_areas_side(self, client, auth, alice, make_task):
        task = make_task(assignee_1=alice)
        h = auth(alice)
        ok = client.patch(f"/tasks/{task.id}", headers=h, json={"summary": "half done", "tags": ["auth"]})
        assert ok.status_code == 200 and ok.json()["tags"] == ["auth"]
        assert ok.json()["events"][-1]["event_type"] == "field_changed"
        assert client.patch(f"/tasks/{task.id}", headers=h, json={"title": "x"}).status_code == 403


# --- git links, deploy --------------------------------------------------------------


class TestGitAndDeploy:
    def test_git_links_upsert(self, client, alice, token, make_task):
        task = make_task(assignee_1=alice)
        h = token(alice)
        first = client.post(
            f"/tasks/{task.id}/git", headers=h, json={"repo": "org/repo", "kind": "pr", "ref": "12", "state": "open"}
        ).json()
        second = client.post(
            f"/tasks/{task.id}/git", headers=h, json={"repo": "org/repo", "kind": "pr", "ref": "12", "state": "merged"}
        ).json()
        assert first["id"] == second["id"] and second["state"] == "merged"
        assert second["actor_kind"] == "agent"

    def test_commit_refs_must_be_hashes(self, client, alice, token, make_task):
        task = make_task(assignee_1=alice)
        response = client.post(
            f"/tasks/{task.id}/git", headers=token(alice), json={"repo": "org/repo", "kind": "commit", "ref": "HEAD"}
        )
        assert response.status_code == 422

    def test_deploy_state_is_recorded(self, client, alice, token, make_task):
        task = make_task(assignee_1=alice)
        body = client.patch(
            f"/tasks/{task.id}/deploy", headers=token(alice), json={"state": "staging", "note": "flag off"}
        ).json()
        assert body["deploy_state"] == "staging" and body["deployed_at"]
        assert body["events"][-1]["event_type"] == "deployed"


# --- cheap reads --------------------------------------------------------------------


class TestReads:
    def test_brief_is_small_and_marks_truncation(self, client, auth, leader, alice, make_task, db_session):
        task = make_task(assignee_1=alice)
        task.description = "x" * 5_000
        db_session.commit()
        brief = client.get(f"/tasks/{task.id}/brief", headers=auth(alice))
        assert brief.status_code == 200
        assert brief.json()["truncated"] is True
        assert len(brief.text) < 2_500

    def test_events_since(self, client, auth, leader, alice, make_task):
        task = make_task(assignee_1=alice)
        h = auth(alice)
        client.patch(f"/tasks/{task.id}/status", headers=h, json={"status": "in_progress"})
        first = client.get(f"/tasks/{task.id}/events", headers=h).json()
        client.post(f"/tasks/{task.id}/comments", headers=h, json={"body": "note"})
        newer = client.get(f"/tasks/{task.id}/events?since={first[-1]['id']}", headers=h).json()
        assert [e["event_type"] for e in newer] == ["commented"]


# --- lint ---------------------------------------------------------------------------


class TestLint:
    @pytest.mark.parametrize(
        "text",
        [
            "token ghp_" + "a" * 36,
            "SECRET_KEY=supersecretvalue",
            "ssh to 203.0.113.9 and restart",
            "-----BEGIN OPENSSH PRIVATE KEY-----",
        ],
    )
    def test_secrets_and_private_details_are_refused(self, client, auth, alice, make_task, text):
        task = make_task(assignee_1=alice)
        response = client.post(f"/tasks/{task.id}/comments", headers=auth(alice), json={"body": text})
        assert response.status_code == 422

    def test_arabic_and_localhost_pass(self, client, auth, alice, make_task):
        task = make_task(assignee_1=alice)
        body = "\u200fتم إصلاح صفحة الدخول\u200f، run on 127.0.0.1:8000"
        response = client.post(f"/tasks/{task.id}/comments", headers=auth(alice), json={"body": body})
        assert response.status_code == 201
        assert response.json()["body"] == body

    def test_invisible_override_characters_are_stripped(self, client, auth, alice, make_task):
        task = make_task(assignee_1=alice)
        response = client.post(
            f"/tasks/{task.id}/comments", headers=auth(alice), json={"body": "ok\u202eevil\u200b"}
        )
        assert response.json()["body"] == "okevil"

    def test_configured_private_paths_are_refused(self, client, auth, alice, make_task, monkeypatch):
        monkeypatch.setattr(settings, "lint_blocked_paths", "ops-notes/,secret-folder")
        task = make_task(assignee_1=alice)
        response = client.post(
            f"/tasks/{task.id}/comments", headers=auth(alice), json={"body": "see ops-notes/servers.md"}
        )
        assert response.status_code == 422

    def test_configured_private_id_prefixes_are_refused(self, client, auth, alice, make_task, monkeypatch):
        monkeypatch.setattr(settings, "lint_blocked_id_prefixes", "ZZQ")
        task = make_task(assignee_1=alice)
        response = client.post(f"/tasks/{task.id}/comments", headers=auth(alice), json={"body": "see zzq-12"})
        assert response.status_code == 422


# --- limits and start-up -------------------------------------------------------------


class TestLimits:
    def test_login_is_rate_limited(self, client, alice, monkeypatch):
        monkeypatch.setattr(settings, "rate_login_per_minute", 3)
        ratelimit.reset()
        codes = [
            client.post("/auth/login", json={"email": alice.email, "password": "wrong"}).status_code
            for _ in range(4)
        ]
        assert codes == [401, 401, 401, 429]

    def test_token_writes_are_rate_limited(self, client, alice, token, make_task, monkeypatch):
        task = make_task(assignee_1=alice)
        headers = token(alice)
        monkeypatch.setattr(settings, "rate_token_writes_per_minute", 2)
        ratelimit.reset()
        codes = [
            client.post(f"/tasks/{task.id}/comments", headers=headers, json={"body": f"n{i}"}).status_code
            for i in range(3)
        ]
        assert codes == [201, 201, 429]

    @pytest.mark.parametrize("key", ["dev-secret-change-me", "change-me", "short"])
    def test_production_refuses_weak_keys(self, key):
        with pytest.raises(RuntimeError):
            check_production_settings(Settings(app_env="production", secret_key=key))

    def test_production_accepts_a_strong_key(self):
        check_production_settings(Settings(app_env="production", secret_key="k" * 48))

    def test_development_allows_the_default(self):
        check_production_settings(Settings(app_env="development", secret_key="dev-secret-change-me"))


# --- fixes from the CLI and frontend review ---------------------------------------


class TestReviewFixes:
    def test_empty_summary_heading_is_refused(self, client, alice, token, make_task):
        task = make_task(status=TaskStatus.in_progress, assignee_1=alice)
        body = "Summary:\nChecks run: pytest\nLeft: none\n"
        response = client.post(
            f"/tasks/{task.id}/comments", headers=token(alice), json={"kind": "handback", "body": body}
        )
        assert response.status_code == 422
        assert "Summary:" in response.json()["detail"]

    def test_tag_filter_is_not_cut_by_the_limit(self, client, auth, leader, make_task, db_session):
        tagged = make_task(title="old tagged")
        tagged.tags = ["needle"]
        db_session.commit()
        for i in range(3):
            make_task(title=f"newer {i}")
        found = client.get("/tasks?tag=needle&limit=2", headers=auth(leader)).json()
        assert [t["id"] for t in found] == [tagged.id]

    def test_plain_renew_keeps_a_longer_lease(self, client, alice, token, make_task):
        task = make_task(assignee_1=alice)
        headers = token(alice)
        long = client.post(f"/tasks/{task.id}/claim", headers=headers, json={"ttl_hours": 6}).json()
        renewed = client.post(f"/tasks/{task.id}/claim", headers=headers, json={}).json()
        assert renewed["claim_expires_at"] >= long["claim_expires_at"]

    def test_dropping_a_criterion_needs_a_reason(self, client, auth, leader, alice):
        created = client.post(
            "/tasks", headers=auth(leader), json={"title": "x", "assignee_1_id": alice.id, "criteria": ["a"]}
        ).json()
        h = auth(alice)
        url = f"/tasks/{created['id']}/criteria/1"
        assert client.patch(url, headers=h, json={"state": "dropped"}).status_code == 422
        ok = client.patch(url, headers=h, json={"state": "dropped", "evidence": "out of scope"})
        assert ok.status_code == 200

    def test_members_cannot_edit_closed_tasks(self, client, auth, alice, make_task):
        task = make_task(status=TaskStatus.done, assignee_1=alice)
        response = client.patch(f"/tasks/{task.id}", headers=auth(alice), json={"summary": "late"})
        assert response.status_code == 409

    def test_whoami_shows_token_scopes(self, client, alice, token):
        body = client.get("/auth/whoami", headers=token(alice, scopes=["tasks:read"])).json()
        assert body["kind"] == "agent"
        assert body["scopes"] == ["tasks:read"]
        assert body["token"]["expires_at"]

    def test_brief_and_inbox_name_the_author(self, client, auth, leader, alice, token, make_task, db_session):
        leader.handle = "lead"
        alice.handle = "alice"
        db_session.commit()
        task = make_task(status=TaskStatus.in_progress, assignee_1=alice)
        client.post(
            f"/tasks/{task.id}/comments",
            headers=token(alice, agent="be-1"),
            json={"kind": "question", "body": "Which one?", "to": "lead"},
        )
        brief = client.get(f"/tasks/{task.id}/brief", headers=auth(alice)).json()
        assert "by alice (agent be-1)" in brief["open_questions"][0]
        inbox = client.get("/tasks/inbox", headers=auth(leader)).json()
        assert inbox[0]["author"] == "alice (agent be-1)"
