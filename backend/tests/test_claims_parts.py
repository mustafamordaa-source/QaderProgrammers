"""Claiming from the backlog, taking one part of a task, the people on a task,
the "free to take" list and the filter counts."""

from __future__ import annotations

from app.models import Criterion, Task


def _import(client, h, *tasks):
    r = client.post("/tasks/import", headers=h, json={"tasks": list(tasks)})
    assert r.status_code == 200, r.text
    return [row["id"] for row in r.json()]


def _item(key, **fields):
    return {"external_key": key, "title": f"Imported {key}", **fields}


def _member(alice, db_session, sides=("be",)):
    alice.sides = list(sides)
    db_session.commit()
    return alice


class TestClaimFromBacklog:
    def test_imported_task_is_pool_and_a_member_claims_it_from_backlog(self, client, auth, leader, alice, db_session):
        _member(alice, db_session)
        [tid] = _import(client, auth(leader), _item("QX-1", side="be"))
        row = client.get(f"/tasks/{tid}", headers=auth(alice)).json()
        assert row["pool"] is True and row["status"] == "backlog"
        assert row["claimable"] is True and row["lane"] == "backlog" and row["claim_block"] is None
        r = client.post(f"/tasks/{tid}/claim", headers=auth(alice), json={})
        assert r.status_code == 200, r.text
        out = r.json()
        assert out["status"] == "in_progress" and out["claimed_by"] == alice.id
        # Yours now: not "claimable" again, and no lock reason.
        assert out["claimable"] is False and out["claim_block"] is None
        assert [(p["handle"], p["role"]) for p in out["people"]] == [(alice.handle or alice.name, "claim")]

    def test_refusals_explain_why(self, client, auth, leader, alice, bob, db_session):
        _member(alice, db_session, ("fe",))
        h = auth(leader)
        [other_side, asked] = _import(
            client, h, _item("QX-2", side="be"),
            _item("QX-3", side="fe", question="Is this allowed?", question_to=str(leader.id)),
        )
        r = client.post(f"/tasks/{other_side}/claim", headers=auth(alice), json={})
        assert r.status_code == 403 and "Backend work" in r.json()["detail"]
        row = client.get(f"/tasks/{asked}", headers=auth(alice)).json()
        assert row["status"] == "needs_confirm" and row["claim_block"] == "waiting_decision"
        r = client.post(f"/tasks/{asked}/claim", headers=auth(alice), json={})
        assert r.status_code == 409 and "decision" in r.json()["detail"]
        # A task assigned to someone else.
        theirs = client.post("/tasks", headers=h, json={"title": "Lead work", "status": "to_do",
                                                        "assignee_1_id": alice.id}).json()
        r = client.post(f"/tasks/{theirs['id']}/claim", headers=auth(bob), json={})
        assert r.status_code == 403 and r.headers["X-Claim-Block"] == "not_pool"

    def test_ready_lists_planned_then_backlog_by_priority(self, client, auth, leader, alice, db_session):
        _member(alice, db_session)
        h = auth(leader)
        low, urgent, planned = _import(
            client, h, _item("QX-4", side="be", priority="low"), _item("QX-5", side="be", priority="urgent"),
            _item("QX-6", side="be", priority="low", status="to_do"),
        )
        # Planned first, then the backlog oldest first (the default sort).
        rows = client.get("/tasks?ready=true", headers=auth(alice)).json()
        assert [r["id"] for r in rows] == [planned, low, urgent]
        # Urgent first inside each lane when asked.
        rows = client.get("/tasks?ready=true&sort=priority", headers=auth(alice)).json()
        assert [r["id"] for r in rows] == [planned, urgent, low]
        assert [r["lane"] for r in rows] == ["planned", "backlog", "backlog"]
        only_planned = client.get("/tasks?ready=true&lane=planned", headers=auth(alice)).json()
        assert [r["id"] for r in only_planned] == [planned]
        urgent_only = client.get("/tasks?priority=urgent,high", headers=auth(alice)).json()
        assert [r["id"] for r in urgent_only] == [urgent]


class TestTakePart:
    def _task(self, client, auth, leader, alice, db_session):
        _member(alice, db_session)
        [tid] = _import(client, auth(leader), _item("QX-10", side="be", criteria=["Part one", "Part two"]))
        return tid

    def test_take_makes_a_claimed_subtask_and_the_parent_shows_the_person(self, client, auth, leader, alice, db_session):
        tid = self._task(client, auth, leader, alice, db_session)
        before = client.get(f"/tasks/{tid}", headers=auth(alice)).json()
        assert [c["can_take"] for c in before["criteria"]] == [True, True]
        r = client.post(f"/tasks/{tid}/criteria/2/take", headers=auth(alice), json={})
        assert r.status_code == 201, r.text
        sub = r.json()
        assert sub["parent_id"] == tid and sub["status"] == "in_progress" and sub["claimed_by"] == alice.id
        assert sub["title"] == "Part two" and sub["side"] == "be" and sub["pool"] is True
        parent = client.get(f"/tasks/{tid}", headers=auth(alice)).json()
        assert parent["status"] == "in_progress"
        assert parent["parts_total"] == 2 and parent["parts_taken"] == 1
        assert [(p["role"], p["task_id"], p["part"]) for p in parent["people"]] == [("part", sub["id"], 2)]
        taken = parent["criteria"][1]
        assert taken["subtask"]["id"] == sub["id"] and taken["can_take"] is False
        assert f"HUB-{sub['id']}" in taken["take_block_text"]
        # Taking it twice is refused with the reason.
        again = client.post(f"/tasks/{tid}/criteria/2/take", headers=auth(leader), json={})
        assert again.status_code == 409 and f"HUB-{sub['id']}" in again.json()["detail"]
        # Part one is still free.
        assert parent["criteria"][0]["can_take"] is True

    def test_done_subtask_marks_the_part_met(self, client, auth, leader, alice, db_session):
        tid = self._task(client, auth, leader, alice, db_session)
        sub = client.post(f"/tasks/{tid}/criteria/1/take", headers=auth(alice), json={}).json()
        db_session.query(Criterion).filter_by(task_id=sub["id"]).update({"state": "met", "evidence": "ok"})
        db_session.commit()
        r = client.patch(f"/tasks/{sub['id']}/status", headers=auth(alice), json={"status": "in_review"})
        assert r.status_code == 200, r.text
        r = client.patch(f"/tasks/{sub['id']}/status", headers=auth(leader), json={"status": "done"})
        assert r.status_code == 200, r.text
        parent = client.get(f"/tasks/{tid}", headers=auth(leader)).json()
        part = parent["criteria"][0]
        assert part["state"] == "met" and part["evidence"] == f"Done in HUB-{sub['id']}"

    def test_dropped_subtask_frees_the_part(self, client, auth, leader, alice, db_session):
        tid = self._task(client, auth, leader, alice, db_session)
        sub = client.post(f"/tasks/{tid}/criteria/1/take", headers=auth(alice), json={}).json()
        client.patch(f"/tasks/{sub['id']}/status", headers=auth(leader), json={"status": "dropped", "comment": "no"})
        parent = client.get(f"/tasks/{tid}", headers=auth(alice)).json()
        assert parent["criteria"][0]["can_take"] is True and parent["parts_taken"] == 0

    def test_other_side_and_waiting_tasks_cannot_be_taken(self, client, auth, leader, alice, db_session):
        _member(alice, db_session, ("fe",))
        h = auth(leader)
        [be_task, asked] = _import(
            client, h, _item("QX-11", side="be", criteria=["A"]),
            _item("QX-12", side="fe", criteria=["B"], question="Allowed?", question_to=str(leader.id)),
        )
        r = client.post(f"/tasks/{be_task}/criteria/1/take", headers=auth(alice), json={})
        assert r.status_code == 403 and "Backend" in r.json()["detail"]
        r = client.post(f"/tasks/{asked}/criteria/1/take", headers=auth(alice), json={})
        assert r.status_code == 409 and "decision" in r.json()["detail"]
        assert client.post(f"/tasks/{be_task}/criteria/9/take", headers=auth(leader), json={}).status_code == 404


class TestFiltersAndFacets:
    def test_subtasks_filter_and_facets(self, client, auth, leader, alice, db_session):
        _member(alice, db_session)
        h = auth(leader)
        [tid, other] = _import(client, h, _item("QX-20", side="be", kind="bug", criteria=["A"]),
                               _item("QX-21", side="be", kind="feature", status="to_do"))
        sub = client.post(f"/tasks/{tid}/criteria/1/take", headers=auth(alice), json={}).json()
        top = client.get("/tasks?subtasks=top", headers=h).json()
        assert sub["id"] not in [r["id"] for r in top]
        only = client.get("/tasks?subtasks=only", headers=h).json()
        assert [r["id"] for r in only] == [sub["id"]]
        kinds = client.get("/tasks?kinds=feature", headers=h).json()
        assert [r["id"] for r in kinds] == [other]
        f = client.get("/tasks/facets", headers=auth(alice)).json()
        assert f["total"] == 3 and f["subtasks"] == 1
        assert f["kind"] == {"bug": 2, "feature": 1}
        assert f["lane"] == {"planned": 1}
        # Free to take counts the plan and the backlog: the feature, not the in-progress bug.
        assert f["claimable"] == 1
        ready = client.get("/tasks/facets?ready=true", headers=auth(alice)).json()
        assert ready["total"] == 1 and ready["lane"] == {"planned": 1}

    def test_bad_comma_value_is_a_clear_422(self, client, auth, leader):
        r = client.get("/tasks?priority=soon", headers=auth(leader))
        assert r.status_code == 422 and "soon" in r.json()["detail"]


def test_import_has_no_pool_box_but_can_mark_assign_only(client, auth, leader, alice, db_session):
    _member(alice, db_session)
    [open_task, kept] = _import(client, auth(leader), _item("QX-30", side="be"),
                                _item("QX-31", side="be", assign_only=True))
    assert client.get(f"/tasks/{open_task}", headers=auth(alice)).json()["claimable"] is True
    row = client.get(f"/tasks/{kept}", headers=auth(alice)).json()
    assert row["claimable"] is False and row["claim_block"] == "assign_only"


def test_brief_and_refusal_code_for_agents(client, auth, leader, alice, db_session):
    alice.sides = ["fe"]
    db_session.commit()
    [tid] = _import(client, auth(leader), _item("QX-40", side="be", criteria=["A", "B"]))
    r = client.post(f"/tasks/{tid}/claim", headers=auth(alice), json={})
    assert r.status_code == 403 and r.headers["X-Claim-Block"] == "other_side"
    r = client.post(f"/tasks/{tid}/criteria/1/take", headers=auth(alice), json={})
    assert r.headers["X-Claim-Block"] == "other_side"
    sub = client.post(f"/tasks/{tid}/criteria/1/take", headers=auth(leader), json={}).json()
    b = client.get(f"/tasks/{tid}/brief", headers=auth(alice)).json()
    assert b["claim_block"] == "other_side" and b["claimable"] is False
    assert b["parts"] == "1/2 taken"
    assert b["criteria"][0].startswith(f"1. [open] [taken in HUB-{sub['id']} in_progress by @")
    assert b["people"] and b["people"][0].endswith(f"part 1 via HUB-{sub['id']}")
    rows = client.get("/tasks?side=be,fe", headers=auth(leader)).json()
    assert {r["id"] for r in rows} == {tid, sub["id"]}


class TestReviewFixes:
    def test_part_of_restricted_assigned_task_stays_visible_to_its_taker(self, client, auth, leader, alice, db_session):
        h = auth(leader)
        t = client.post("/tasks", headers=h, json={"title": "Secret", "restricted": True, "status": "to_do",
                                                   "assignee_1_id": alice.id, "side": "be"}).json()
        client.post(f"/tasks/{t['id']}/criteria", headers=h, json={"text": "Part A"})
        sub = client.post(f"/tasks/{t['id']}/criteria/1/take", headers=auth(alice), json={})
        assert sub.status_code == 201, sub.text
        sub = sub.json()
        assert sub["restricted"] is True and sub["pool"] is False and sub["assignee_1_id"] == alice.id
        assert client.get(f"/tasks/{sub['id']}", headers=auth(alice)).status_code == 200

    def test_lost_race_on_a_part_is_a_clean_409(self, client, auth, leader, alice, db_session):
        _member(alice, db_session)
        [tid] = _import(client, auth(leader), _item("QX-50", side="be", criteria=["A"]))
        # Simulate the other request winning between the check and the write.
        from app.routers import tasks as tasks_router
        real = tasks_router._take_block
        tasks_router._take_block = lambda *a, **k: None
        try:
            first = client.post(f"/tasks/{tid}/criteria/1/take", headers=auth(leader), json={})
            assert first.status_code == 201
            second = client.post(f"/tasks/{tid}/criteria/1/take", headers=auth(alice), json={})
        finally:
            tasks_router._take_block = real
        assert second.status_code == 409 and second.headers["X-Claim-Block"] == "taken"
        assert db_session.query(Task).filter(Task.parent_id == tid).count() == 1

    def test_backlog_claim_cannot_be_planned_by_a_member(self, client, auth, leader, alice, db_session):
        _member(alice, db_session)
        [tid] = _import(client, auth(leader), _item("QX-51", side="be"))
        client.post(f"/tasks/{tid}/claim", headers=auth(alice), json={})
        r = client.patch(f"/tasks/{tid}/status", headers=auth(alice), json={"status": "to_do"})
        assert r.status_code == 200 and r.json()["status"] == "backlog"

    def test_release_returns_the_task_to_its_lane(self, client, auth, leader, alice, db_session):
        _member(alice, db_session)
        [tid] = _import(client, auth(leader), _item("QX-52", side="be"))
        client.post(f"/tasks/{tid}/claim", headers=auth(alice), json={})
        r = client.post(f"/tasks/{tid}/release", headers=auth(alice))
        assert r.status_code == 200 and r.json()["status"] == "backlog" and r.json()["claimable"] is True
        ready = client.get("/tasks?ready=true", headers=auth(alice)).json()
        assert tid in [x["id"] for x in ready]

    def test_whole_task_and_parts_do_not_overlap(self, client, auth, leader, alice, bob, db_session):
        _member(alice, db_session)
        _member(bob, db_session)
        [tid, other] = _import(client, auth(leader), _item("QX-53", side="be", criteria=["A", "B"]),
                               _item("QX-54", side="be", criteria=["C"]))
        client.post(f"/tasks/{tid}/criteria/1/take", headers=auth(alice), json={})
        r = client.post(f"/tasks/{tid}/claim", headers=auth(bob), json={})
        assert r.status_code == 409 and r.headers["X-Claim-Block"] == "parts_taken"
        client.post(f"/tasks/{other}/claim", headers=auth(alice), json={})
        r = client.post(f"/tasks/{other}/criteria/1/take", headers=auth(bob), json={})
        assert r.status_code == 409 and r.headers["X-Claim-Block"] == "claimed"

    def test_dropped_part_shows_no_taker(self, client, auth, leader, alice, db_session):
        _member(alice, db_session)
        [tid] = _import(client, auth(leader), _item("QX-55", side="be", criteria=["A"]))
        sub = client.post(f"/tasks/{tid}/criteria/1/take", headers=auth(alice), json={}).json()
        client.patch(f"/tasks/{sub['id']}/status", headers=auth(leader), json={"status": "dropped", "comment": "x"})
        part = client.get(f"/tasks/{tid}", headers=auth(alice)).json()["criteria"][0]
        assert part["subtask"] is None and part["can_take"] is True
        again = client.post(f"/tasks/{tid}/criteria/1/take", headers=auth(alice), json={})
        assert again.status_code == 201

    def test_claimable_list_skips_your_own_claims(self, client, auth, leader, alice, db_session):
        _member(alice, db_session)
        [a, b] = _import(client, auth(leader), _item("QX-56", side="be"), _item("QX-57", side="be"))
        client.post(f"/tasks/{a}/claim", headers=auth(alice), json={})
        rows = client.get("/tasks?claimable=true", headers=auth(alice)).json()
        assert [r["id"] for r in rows] == [b]


class TestOpenUnassigned:
    def test_unassigned_task_is_open_to_its_side_without_the_pool_box(self, client, auth, leader, alice, db_session):
        _member(alice, db_session)
        t = client.post("/tasks", headers=auth(leader), json={"title": "Plain work", "side": "be"}).json()
        assert t["pool"] is True  # "open to its side" in the API
        row = client.get(f"/tasks/{t['id']}", headers=auth(alice)).json()
        assert row["claimable"] is True
        assert t["id"] in [r["id"] for r in client.get("/tasks?ready=true", headers=auth(alice)).json()]
        assert t["id"] in [r["id"] for r in client.get("/tasks?pool=true", headers=auth(alice)).json()]
        r = client.post(f"/tasks/{t['id']}/claim", headers=auth(alice), json={})
        assert r.status_code == 200 and r.json()["status"] == "in_progress"
        # The claim holder works on it like on a pool task.
        assert client.patch(f"/tasks/{t['id']}", headers=auth(alice), json={"summary": "on it"}).status_code == 200

    def test_assign_only_keeps_it_for_a_chosen_person(self, client, auth, leader, alice, bob, db_session):
        _member(alice, db_session)
        h = auth(leader)
        t = client.post("/tasks", headers=h, json={"title": "Payments core", "side": "be", "assign_only": True,
                                                   "criteria": ["Part A"]}).json()
        assert t["assign_only"] is True
        row = client.get(f"/tasks/{t['id']}", headers=auth(alice)).json()
        assert row["claimable"] is False and row["claim_block"] == "assign_only"
        assert row["criteria"][0]["can_take"] is False
        r = client.post(f"/tasks/{t['id']}/claim", headers=auth(alice), json={})
        assert r.status_code == 403 and r.headers["X-Claim-Block"] == "assign_only"
        r = client.post(f"/tasks/{t['id']}/criteria/1/take", headers=auth(alice), json={})
        assert r.status_code == 403 and r.headers["X-Claim-Block"] == "assign_only"
        assert t["id"] not in [x["id"] for x in client.get("/tasks?ready=true", headers=auth(alice)).json()]
        # Once a lead assigns it, the assignee claims it.
        client.patch(f"/tasks/{t['id']}/assign", headers=h, json={"assignee_1_id": alice.id})
        assert client.post(f"/tasks/{t['id']}/claim", headers=auth(alice), json={}).status_code == 200

    def test_only_a_lead_sets_assign_only(self, client, auth, alice, db_session):
        r = client.post("/tasks", headers=auth(alice), json={"title": "Mine", "assign_only": True})
        assert r.status_code == 403


class TestIdleClaims:
    def _claimed(self, client, auth, leader, alice, db_session):
        _member(alice, db_session)
        [tid] = _import(client, auth(leader), _item("QX-60", side="be", criteria=["A"]))
        r = client.post(f"/tasks/{tid}/claim", headers=auth(alice), json={"ttl_hours": 2})
        assert r.status_code == 200
        return tid

    def test_lease_is_48_hours_and_activity_restarts_it(self, client, auth, leader, alice, db_session):
        from datetime import timedelta

        from app.models import utcnow

        tid = self._claimed(client, auth, leader, alice, db_session)
        task = db_session.get(Task, tid)
        left = task.claim_expires_at - utcnow()
        assert timedelta(hours=47) < left <= timedelta(hours=48)
        # Pretend 30 idle hours passed and a reminder went out; a comment restarts the clock.
        task.claim_expires_at = utcnow() + timedelta(hours=18)
        task.claim_warned_at = utcnow()
        db_session.commit()
        r = client.post(f"/tasks/{tid}/comments", headers=auth(alice), json={"body": "Still on it"})
        assert r.status_code == 201, r.text
        db_session.refresh(task)
        assert task.claim_expires_at - utcnow() > timedelta(hours=47) and task.claim_warned_at is None

    def test_someone_elses_activity_does_not_renew(self, client, auth, leader, alice, db_session):
        from datetime import timedelta

        from app.models import utcnow

        tid = self._claimed(client, auth, leader, alice, db_session)
        task = db_session.get(Task, tid)
        task.claim_expires_at = utcnow() + timedelta(hours=5)
        db_session.commit()
        client.post(f"/tasks/{tid}/comments", headers=auth(leader), json={"body": "Any news?"})
        db_session.refresh(task)
        assert task.claim_expires_at - utcnow() < timedelta(hours=6)

    def test_sweep_reminds_once_then_frees_to_the_lane(self, client, auth, leader, alice, db_session):
        from datetime import timedelta

        from app.claims import sweep
        from app.models import Notification, utcnow

        tid = self._claimed(client, auth, leader, alice, db_session)
        task = db_session.get(Task, tid)
        now = utcnow()
        assert sweep(db_session, now) == {"reminded": 0, "freed": 0}
        assert sweep(db_session, now + timedelta(hours=25)) == {"reminded": 1, "freed": 0}
        assert sweep(db_session, now + timedelta(hours=26)) == {"reminded": 0, "freed": 0}
        idle = db_session.query(Notification).filter_by(user_id=alice.id, kind="claim_idle").one()
        assert "24 hours" in idle.text and idle.actor_id is None
        assert sweep(db_session, now + timedelta(hours=49)) == {"reminded": 0, "freed": 1}
        db_session.refresh(task)
        assert task.claimed_by is None and task.status.value == "backlog"
        assert db_session.query(Notification).filter_by(user_id=alice.id, kind="claim_freed").count() == 1
        assert db_session.query(Notification).filter_by(user_id=leader.id, kind="claim_freed").count() == 1
        ready = client.get("/tasks?ready=true", headers=auth(alice)).json()
        assert tid in [r["id"] for r in ready]

    def test_claim_kinds_are_not_a_setting(self, client, auth, alice):
        r = client.get("/notifications/preferences", headers=auth(alice))
        assert r.status_code == 200 and "claim_idle" not in str(r.json())


class TestMemberAssign:
    def test_open_task_can_be_handed_to_a_teammate(self, client, auth, leader, alice, bob, db_session):
        from app.models import Notification

        _member(alice, db_session, ("fe",))
        [tid] = _import(client, auth(leader), _item("QX-70", side="be"))
        row = client.get(f"/tasks/{tid}", headers=auth(alice)).json()
        assert row["can_assign"] is True
        r = client.patch(f"/tasks/{tid}/assign", headers=auth(alice), json={"assignee_1_id": bob.id})
        assert r.status_code == 200 and r.json()["assignee_1_id"] == bob.id
        assert db_session.query(Notification).filter_by(user_id=bob.id, kind="assigned").count() == 1
        # Now it is Bob's: Alice can no longer reassign it.
        assert client.get(f"/tasks/{tid}", headers=auth(alice)).json()["can_assign"] is False

    def test_handing_over_ends_the_old_claim(self, client, auth, leader, alice, bob, db_session):
        _member(alice, db_session)
        [tid] = _import(client, auth(leader), _item("QX-71", side="be"))
        client.post(f"/tasks/{tid}/claim", headers=auth(alice), json={})
        r = client.patch(f"/tasks/{tid}/assign", headers=auth(alice), json={"assignee_1_id": bob.id})
        assert r.status_code == 200 and r.json()["claimed_by"] is None

    def test_restricted_and_lead_assigns_stay_with_leads(self, client, auth, leader, alice, bob, db_session):
        h = auth(leader)
        [kept, secret] = _import(client, h, _item("QX-72", assign_only=True), _item("QX-73", restricted=True))
        r = client.patch(f"/tasks/{kept}/assign", headers=auth(alice), json={"assignee_1_id": bob.id})
        assert r.status_code == 403 and "Lead assigns" in r.json()["detail"]
        client.patch(f"/tasks/{secret}/assign", headers=h, json={"assignee_1_id": alice.id})
        r = client.patch(f"/tasks/{secret}/assign", headers=auth(alice), json={"assignee_1_id": bob.id})
        assert r.status_code == 403 and "Restricted" in r.json()["detail"]


class TestSorting:
    def test_each_sort_and_its_natural_direction(self, client, auth, leader, db_session):
        h = auth(leader)
        a, b, c = _import(client, h, _item("QX-80", priority="low", points=8),
                          _item("QX-81", priority="urgent", points=2), _item("QX-82", priority="medium", points=5))
        ids = lambda q: [r["id"] for r in client.get(f"/tasks?{q}", headers=h).json()]  # noqa: E731
        assert ids("") == [a, b, c]  # oldest first by default
        assert ids("sort=created&order=desc") == [c, b, a]
        assert ids("sort=priority") == [b, c, a]  # urgent first
        assert ids("sort=priority&order=desc") == [a, c, b]
        assert ids("sort=points") == [b, c, a]  # easiest first
        assert ids("sort=title") == [a, b, c]
        assert client.get("/tasks?sort=size", headers=h).status_code == 422

    def test_paged_sort_never_repeats_a_row(self, client, auth, leader):
        h = auth(leader)
        _import(client, h, *[_item(f"QX-9{i}", priority="high") for i in range(5)])
        seen = []
        for page in (1, 2, 3):
            seen += [r["id"] for r in client.get(f"/tasks?sort=priority&page={page}&page_size=2", headers=h).json()]
        assert len(seen) == len(set(seen)) == 5


class TestAudience:
    def test_impact_is_the_default_sort(self, client, auth, leader, db_session):
        h = auth(leader)
        team, unset, students, parents = _import(
            client, h, _item("QX-A1", audience="team"), _item("QX-A2"),
            _item("QX-A3", audience="students"), _item("QX-A4", audience="parents"))
        ids = [r["id"] for r in client.get("/tasks", headers=h).json()]
        assert ids == [students, parents, unset, team]
        ids = [r["id"] for r in client.get("/tasks?order=desc", headers=h).json()]
        assert ids == [team, unset, parents, students]

    def test_filter_facets_set_and_clear(self, client, auth, leader, alice, db_session):
        h = auth(leader)
        a, b = _import(client, h, _item("QX-A5", audience="students"), _item("QX-A6"))
        assert [r["id"] for r in client.get("/tasks?audience=students", headers=h).json()] == [a]
        assert [r["id"] for r in client.get("/tasks?audience=none", headers=h).json()] == [b]
        f = client.get("/tasks/facets", headers=h).json()
        assert f["audience"] == {"students": 1, "none": 1}
        r = client.patch(f"/tasks/{b}", headers=h, json={"audience": "Teachers"})
        assert r.status_code == 200 and r.json()["audience"] == "teachers"
        r = client.patch(f"/tasks/{b}", headers=h, json={"audience": ""})
        assert r.json()["audience"] is None
        assert client.patch(f"/tasks/{b}", headers=h, json={"audience": "aliens"}).status_code == 422
        assert client.get("/tasks?audience=aliens", headers=h).status_code == 422
        t = client.post("/tasks", headers=auth(alice), json={"title": "Student bug", "audience": "students"}).json()
        assert t["audience"] == "students"
        assert client.get(f"/tasks/{a}/brief", headers=h).json()["audience"] == "students"


def test_import_empty_audience_clears_it(client, auth, leader, db_session):
    h = auth(leader)
    [tid] = _import(client, h, _item("QX-A9", audience="students"))
    _import(client, h, _item("QX-A9", audience=""))
    assert db_session.get(Task, tid).audience is None
    assert [r["id"] for r in client.get("/tasks?audience=none", headers=h).json()] == [tid]


class TestSplitParts:
    def test_split_carries_and_links_parent_parts(self, client, auth, leader, alice, db_session):
        _member(alice, db_session)
        h = auth(leader)
        [tid] = _import(client, h, _item("QX-S1", audience="students", criteria=["API check", "Page shows it", "Both"]))
        out = client.post(f"/tasks/{tid}/split", headers=h, json={"parts": [
            {"side": "be", "parts_from": [1, 3], "parts_prefix": {"3": "API half: "}},
            {"side": "fe", "parts_from": [2, 3], "parts_prefix": {"3": "UI half: "}},
        ]})
        assert out.status_code == 201, out.text
        kids = {c["side"]: c for c in out.json()["children"]}
        be = client.get(f"/tasks/{kids['be']['id']}", headers=h).json()
        fe = client.get(f"/tasks/{kids['fe']['id']}", headers=h).json()
        assert [c["text"] for c in be["criteria"]] == ["API check", "API half: Both"]
        assert [c["text"] for c in fe["criteria"]] == ["Page shows it", "UI half: Both"]
        assert be["status"] == "backlog" and be["audience"] == "students"
        parent = client.get(f"/tasks/{tid}", headers=h).json()
        assert [c["subtask"]["id"] if c["subtask"] else None for c in parent["criteria"]] == \
            [be["id"], fe["id"], be["id"]]
        # Approving the backend half marks parts 1 and 3 met.
        db_session.query(Criterion).filter_by(task_id=be["id"]).update({"state": "met", "evidence": "ok"})
        db_session.commit()
        client.post(f"/tasks/{be['id']}/claim", headers=auth(alice), json={})
        client.patch(f"/tasks/{be['id']}/status", headers=auth(alice), json={"status": "in_review"})
        assert client.patch(f"/tasks/{be['id']}/status", headers=h, json={"status": "done"}).status_code == 200
        parent = client.get(f"/tasks/{tid}", headers=h).json()
        assert [c["state"] for c in parent["criteria"]] == ["met", "open", "met"]

    def test_parts_of_a_task_waiting_for_a_decision_wait_too(self, client, auth, leader, alice, db_session):
        _member(alice, db_session)
        h = auth(leader)
        [tid] = _import(client, h, _item("QX-S2", side="be", criteria=["A"], question="Allowed?",
                                         question_to=str(leader.id)))
        out = client.post(f"/tasks/{tid}/split", headers=h, json={"parts": [{"side": "be", "parts_from": [1]}]})
        kid = out.json()["children"][0]["id"]
        r = client.post(f"/tasks/{kid}/claim", headers=auth(alice), json={})
        assert r.status_code == 409 and r.headers["X-Claim-Block"] == "waiting_decision"


class TestCrossSide:
    def test_reason_lets_a_member_take_the_other_side(self, client, auth, leader, alice, bob, db_session):
        from app.models import Comment, Notification

        alice.sides = ["fe"]
        bob.sides = ["be"]
        db_session.commit()
        h = auth(leader)
        [tid] = _import(client, h, _item("QX-C1", criteria=["API", "UI"]))
        kids = client.post(f"/tasks/{tid}/split", headers=h, json={"parts": [
            {"side": "be", "parts_from": [1]}, {"side": "fe", "parts_from": [2]}]}).json()["children"]
        be = next(k for k in kids if k["side"] == "be")
        fe = next(k for k in kids if k["side"] == "fe")
        client.post(f"/tasks/{fe['id']}/claim", headers=auth(alice), json={})
        row = client.get(f"/tasks/{be['id']}", headers=auth(alice)).json()
        assert row["claimable"] is False and row["claim_block"] == "other_side" and row["cross_side_ok"] is True
        r = client.post(f"/tasks/{be['id']}/claim", headers=auth(alice), json={})
        assert r.status_code == 403 and r.headers["X-Claim-Block"] == "other_side"
        assert client.post(f"/tasks/{be['id']}/claim", headers=auth(alice),
                           json={"cross_side_reason": "short"}).status_code == 422
        r = client.post(f"/tasks/{be['id']}/claim", headers=auth(alice),
                        json={"cross_side_reason": "One new field on the serializer; I ran the API tests"})
        assert r.status_code == 200 and r.json()["claimed_by"] == alice.id
        note = db_session.query(Comment).filter_by(task_id=be["id"]).one()
        assert note.body.startswith("Cross-side claim by @") and "API tests" in note.body
        # Alice holds the fe half herself, so nobody else is told here; a lead assignment would be.
        assert client.get(f"/tasks/{be['id']}/brief", headers=auth(bob)).json()["cross_side_ok"] is False

    def test_blocked_work_stays_blocked_with_a_reason(self, client, auth, leader, alice, db_session):
        alice.sides = ["fe"]
        db_session.commit()
        h = auth(leader)
        [tid] = _import(client, h, _item("QX-C2", side="be", question="Allowed?", question_to=str(leader.id)))
        r = client.post(f"/tasks/{tid}/claim", headers=auth(alice),
                        json={"cross_side_reason": "Tiny change and I can test it fully"})
        assert r.status_code == 409 and r.headers["X-Claim-Block"] == "waiting_decision"


def test_impact_puts_bugs_first(client, auth, leader, db_session):
    h = auth(leader)
    page, team_bug, student_bug = _import(
        client, h, _item("QX-B1", kind="feature", audience="students"),
        _item("QX-B2", kind="bug", audience="team"), _item("QX-B3", kind="bug", audience="students"))
    assert [r["id"] for r in client.get("/tasks", headers=h).json()] == [student_bug, team_bug, page]


def test_split_halves_keep_the_parent_kind(client, auth, leader, db_session):
    h = auth(leader)
    [tid] = _import(client, h, _item("QX-K1", kind="bug", criteria=["A", "B"]))
    kids = client.post(f"/tasks/{tid}/split", headers=h, json={"parts": [
        {"side": "be", "parts_from": [1]}, {"side": "fe", "parts_from": [2]}]}).json()["children"]
    assert {k["kind"] for k in kids} == {"bug"}


class TestRequestedBy:
    def test_requests_come_first_and_halves_copy_them(self, client, auth, leader, alice, db_session):
        h = auth(leader)
        bug, page, asked = _import(
            client, h, _item("QX-R1", kind="bug", audience="students"),
            _item("QX-R2", kind="feature", audience="students"),
            _item("QX-R3", kind="feature", audience="team", requested_by="managers",
                  requested_by_name="Mustafa", requested_at="2026-11-12", criteria=["API", "UI"]))
        assert [r["id"] for r in client.get("/tasks?subtasks=top", headers=h).json()] == [asked, bug, page]
        row = client.get(f"/tasks/{asked}", headers=h).json()
        assert (row["requested_by"], row["requested_by_name"], row["requested_at"]) == ("managers", "Mustafa", "2026-11-12")
        kids = client.post(f"/tasks/{asked}/split", headers=h, json={"parts": [
            {"side": "be", "parts_from": [1]}, {"side": "fe", "parts_from": [2]}]}).json()["children"]
        assert {client.get(f"/tasks/{k['id']}", headers=h).json()["requested_by"] for k in kids} == {"managers"}
        f = client.get("/tasks/facets?requested_by=managers", headers=h).json()
        assert f["total"] == 3 and f["requested_by"] == {"managers": 3}
        assert [r["id"] for r in client.get("/tasks?requested_by=none", headers=h).json()] == [bug, page]
        b = client.get(f"/tasks/{asked}/brief", headers=h).json()
        assert b["requested_by"] == "managers" and b["requested_by_name"] == "Mustafa"

    def test_only_leads_set_it_and_empty_clears(self, client, auth, leader, alice, db_session):
        r = client.post("/tasks", headers=auth(alice), json={"title": "Mine", "requested_by": "managers"})
        assert r.status_code == 403
        t = client.post("/tasks", headers=auth(leader), json={"title": "Asked", "requested_by": "stakeholders",
                                                              "requested_at": "2026-11-16"}).json()
        r = client.patch(f"/tasks/{t['id']}", headers=auth(leader),
                         json={"requested_by": "", "requested_at": ""})
        assert r.status_code == 200 and r.json()["requested_by"] is None and r.json()["requested_at"] is None
        assert client.patch(f"/tasks/{t['id']}", headers=auth(leader), json={"requested_by": "boss"}).status_code == 422
