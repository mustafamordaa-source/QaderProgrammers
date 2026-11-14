"""Product areas (open list, reuse first) and the similar-task check on create."""

import pytest

from app.models import TaskStatus


@pytest.fixture()
def payments(client, auth, leader):
    r = client.post("/areas", headers=auth(leader), json={
        "name": "Payments", "description": "Plans, wallet, serial codes, the store",
        "aliases": ["billing", "wallet", "الدفع"]})
    assert r.status_code == 201, r.text
    return r.json()


class TestAreas:
    def test_create_and_list_with_counts(self, client, auth, leader, alice, payments):
        client.post("/tasks", headers=auth(leader), json={"title": "Refund flow", "area": "payments"})
        rows = client.get("/areas", headers=auth(alice)).json()
        assert [(a["slug"], a["open_count"], a["total_count"]) for a in rows] == [("payments", 1, 1)]

    def test_a_close_name_is_refused_with_suggestions(self, client, auth, alice, payments):
        r = client.post("/areas", headers=auth(alice), json={"name": "Payment"})
        assert r.status_code == 409
        assert r.json()["detail"]["suggestions"][0]["slug"] == "payments"
        # An alias counts too.
        r = client.post("/areas", headers=auth(alice), json={"name": "Billing"})
        assert r.status_code == 409
        # Confirmed as different, it is added.
        r = client.post("/areas", headers=auth(alice), json={"name": "Payment", "slug": "payment-gateway", "confirm_new": True})
        assert r.status_code == 201

    def test_same_slug_is_always_refused(self, client, auth, alice, payments):
        r = client.post("/areas", headers=auth(alice), json={"name": "payments", "confirm_new": True})
        assert r.status_code == 409

    def test_arabic_name_needs_a_slug(self, client, auth, leader):
        r = client.post("/areas", headers=auth(leader), json={"name": "الاختبارات"})
        assert r.status_code == 422
        r = client.post("/areas", headers=auth(leader), json={"name": "الاختبارات", "slug": "exams"})
        assert r.status_code == 201

    def test_search_matches_alias(self, client, auth, alice, payments):
        assert [a["slug"] for a in client.get("/areas?q=wallet", headers=auth(alice)).json()] == ["payments"]
        assert client.get("/areas?q=exams", headers=auth(alice)).json() == []

    def test_tasks_take_an_area_by_slug_or_alias_and_filter_by_it(self, client, auth, leader, payments):
        h = auth(leader)
        a = client.post("/tasks", headers=h, json={"title": "Wallet top-up limits", "area": "wallet"}).json()
        assert a["area"]["slug"] == "payments"
        client.post("/tasks", headers=h, json={"title": "Dark mode toggle", "auto_area": False})
        rows = client.get("/tasks?area=payments", headers=h).json()
        assert [t["id"] for t in rows] == [a["id"]]
        r = client.post("/tasks", headers=h, json={"title": "Something", "area": "paymnts"})
        assert r.status_code == 422 and "payments" in r.json()["detail"]

    def test_merge_moves_tasks_and_keeps_the_old_name(self, client, auth, leader, alice, payments):
        h = auth(leader)
        store = client.post("/areas", headers=h, json={"name": "Store", "confirm_new": True}).json()
        t = client.post("/tasks", headers=h, json={"title": "Store banner", "area": "store"}).json()
        assert client.post("/areas/store/merge", headers=auth(alice), json={"into": "payments"}).status_code == 403
        r = client.post("/areas/store/merge", headers=h, json={"into": "payments"})
        assert r.status_code == 200 and "Store" in r.json()["aliases"]
        assert client.get(f"/tasks/{t['id']}", headers=h).json()["area"]["slug"] == "payments"
        # The old slug still resolves.
        assert client.get("/tasks?area=store", headers=h).json()[0]["id"] == t["id"]
        assert store["slug"] not in [a["slug"] for a in client.get("/areas", headers=h).json()]

    def test_sub_areas_are_included_in_the_filter(self, client, auth, leader, payments):
        h = auth(leader)
        client.post("/areas", headers=h, json={"name": "Salla", "parent": "payments", "confirm_new": True})
        t = client.post("/tasks", headers=h, json={"title": "Salla webhook signature", "area": "salla"}).json()
        assert [x["id"] for x in client.get("/tasks?area=payments", headers=h).json()] == [t["id"]]

    def test_workers_can_set_the_area_of_their_task(self, client, auth, leader, alice, payments):
        t = client.post("/tasks", headers=auth(leader), json={"title": "Coupon codes", "assignee_1_id": alice.id}).json()
        r = client.patch(f"/tasks/{t['id']}", headers=auth(alice), json={"area": "payments"})
        assert r.status_code == 200 and r.json()["area"]["slug"] == "payments"
        r = client.patch(f"/tasks/{t['id']}", headers=auth(alice), json={"area": ""})
        assert r.json()["area"] is None

    def test_viewers_cannot_add_areas(self, client, auth, db_session):
        from tests.conftest import make_user
        from app.models import Role
        viewer = make_user(db_session, "View", "view@example.com", Role.programmer)
        viewer.roles = ["viewer"]
        db_session.commit()
        assert client.post("/areas", headers=auth(viewer), json={"name": "Exams"}).status_code == 403


class TestSimilar:
    def test_similar_ranks_and_bands(self, client, auth, leader):
        h = auth(leader)
        a = client.post("/tasks", headers=h, json={"title": "Export the weekly report as CSV"}).json()
        client.post("/tasks", headers=h, json={"title": "Fix login rate limit behind the proxy"})
        r = client.post("/tasks/similar", headers=h, json={"title": "Export weekly reprot as CSV"}).json()
        assert r["matches"][0]["id"] == a["id"]
        assert r["matches"][0]["band"] == "related"
        assert len(r["matches"]) == 1  # the login task is below the floor

    def test_a_duplicate_is_refused_without_a_reason(self, client, auth, leader):
        h = auth(leader)
        a = client.post("/tasks", headers=h, json={"title": "Export the weekly report as CSV"}).json()
        r = client.post("/tasks", headers=h, json={"title": "Export the weekly report as CSV"})
        assert r.status_code == 409
        assert r.json()["detail"]["similar"][0]["id"] == a["id"]
        r = client.post("/tasks", headers=h, json={
            "title": "Export the weekly report as CSV", "duplicate_reason": "This one is for the parents' report"})
        assert r.status_code == 201
        body = r.json()
        assert body["similar"][0]["id"] == a["id"]
        assert any(l["other"]["id"] == a["id"] and l["kind"] == "relates" for l in body["links"])

    def test_done_tasks_count(self, client, auth, leader, db_session):
        from app.models import Task
        h = auth(leader)
        a = client.post("/tasks", headers=h, json={"title": "Streak counts days in Riyadh time"}).json()
        db_session.get(Task, a["id"]).status = TaskStatus.done
        db_session.commit()
        r = client.post("/tasks", headers=h, json={"title": "Streak counts days in Riyadh time"})
        assert r.status_code == 409 and "done" in r.json()["detail"]["message"]

    def test_related_tasks_are_linked_and_reported(self, client, auth, leader):
        h = auth(leader)
        a = client.post("/tasks", headers=h, json={"title": "Export the weekly report as CSV"}).json()
        r = client.post("/tasks", headers=h, json={"title": "Export weekly reprot as CSV"})
        assert r.status_code == 201
        body = r.json()
        assert body["similar"][0]["band"] == "related"
        assert [l["other"]["id"] for l in body["links"]] == [a["id"]]

    def test_check_can_be_skipped_for_bulk_imports(self, client, auth, leader):
        h = auth(leader)
        client.post("/tasks", headers=h, json={"title": "Export the weekly report as CSV"})
        r = client.post("/tasks", headers=h, json={"title": "Export the weekly report as CSV", "check_similar": False})
        assert r.status_code == 201 and r.json()["similar"] == []

    def test_subtasks_do_not_match_their_parent(self, client, auth, leader):
        h = auth(leader)
        p = client.post("/tasks", headers=h, json={"title": "Export the weekly report as CSV"}).json()
        r = client.post("/tasks", headers=h, json={"title": "Export the weekly report as CSV", "parent_id": p["id"]})
        assert r.status_code == 201

    def test_hidden_tasks_are_never_shown(self, client, auth, leader, alice):
        client.post("/tasks", headers=auth(leader), json={"title": "Rotate the payment keys", "restricted": True})
        r = client.post("/tasks/similar", headers=auth(alice), json={"title": "Rotate the payment keys"}).json()
        assert r["matches"] == []

    def test_same_area_ranks_first(self, client, auth, leader, payments):
        h = auth(leader)
        client.post("/areas", headers=h, json={"name": "Exams", "confirm_new": True})
        other = client.post("/tasks", headers=h, json={"title": "Timer colors fail contrast", "area": "exams",
                                                       "check_similar": False}).json()
        mine = client.post("/tasks", headers=h, json={"title": "Timer colors fail contrast", "area": "payments",
                                                      "check_similar": False}).json()
        r = client.post("/tasks/similar", headers=h, json={"title": "Timer colors fail the contrast check",
                                                           "area": "payments"}).json()
        assert r["matches"][0]["id"] == mine["id"] and r["matches"][0]["same_area"] is True
        assert other["id"] in [m["id"] for m in r["matches"]]

    def test_area_is_suggested_and_picked_when_clear(self, client, auth, leader, payments):
        h = auth(leader)
        r = client.post("/tasks", headers=h, json={"title": "Wallet balance shows the wrong currency"}).json()
        assert r["area"]["slug"] == "payments" and r["area_auto"] is True
        r = client.post("/tasks", headers=h, json={"title": "Dark mode toggle"}).json()
        assert r["area"] is None and r["area_auto"] is False
