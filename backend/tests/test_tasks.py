"""Task routes: creation, visibility, transitions over HTTP and event logging."""

from __future__ import annotations

import pytest

from app.models import TaskStatus


def _events(client, headers, task_id):
    response = client.get(f"/tasks/{task_id}", headers=headers)
    assert response.status_code == 200
    return [(e["event_type"], e["from_status"], e["to_status"]) for e in response.json()["events"]]


class TestCreation:
    def test_leader_creates_a_task_and_logs_it(self, client, auth, leader, alice):
        response = client.post(
            "/tasks",
            headers=auth(leader),
            json={"title": "Ship it", "priority": "high", "assignee_1_id": alice.id},
        )
        assert response.status_code == 201
        body = response.json()
        assert body["status"] == "to_do"
        assert body["assignee_1"]["email"] == alice.email
        assert [(e["event_type"], e["to_status"]) for e in body["events"]] == [
            ("created", "to_do")
        ]

    def test_dual_assignment_is_one_shared_task(self, client, auth, leader, alice, bob):
        response = client.post(
            "/tasks",
            headers=auth(leader),
            json={"title": "Shared", "assignee_1_id": alice.id, "assignee_2_id": bob.id},
        )
        assert response.status_code == 201
        body = response.json()
        assert body["assignee_1_id"] == alice.id
        assert body["assignee_2_id"] == bob.id
        # Both see the same single task, not a split pair.
        for user in (alice, bob):
            queue = client.get("/tasks", headers=auth(user)).json()
            assert [t["id"] for t in queue] == [body["id"]]

    def test_programmers_cannot_create_tasks(self, client, auth, alice):
        response = client.post("/tasks", headers=auth(alice), json={"title": "Nope"})
        assert response.status_code == 403

    def test_rejects_the_same_assignee_twice(self, client, auth, leader, alice):
        response = client.post(
            "/tasks",
            headers=auth(leader),
            json={"title": "x", "assignee_1_id": alice.id, "assignee_2_id": alice.id},
        )
        assert response.status_code == 422

    def test_rejects_a_second_assignee_without_a_first(self, client, auth, leader, alice):
        response = client.post(
            "/tasks", headers=auth(leader), json={"title": "x", "assignee_2_id": alice.id}
        )
        assert response.status_code == 422

    def test_rejects_assigning_work_to_a_leader(self, client, auth, leader):
        response = client.post(
            "/tasks", headers=auth(leader), json={"title": "x", "assignee_1_id": leader.id}
        )
        assert response.status_code == 422

    def test_rejects_an_unknown_assignee(self, client, auth, leader):
        response = client.post(
            "/tasks", headers=auth(leader), json={"title": "x", "assignee_1_id": 9999}
        )
        assert response.status_code == 422

    def test_rejects_a_blank_title(self, client, auth, leader):
        assert client.post("/tasks", headers=auth(leader), json={"title": "   "}).status_code == 422


class TestVisibility:
    def test_leader_sees_every_task(self, client, auth, leader, alice, bob, make_task):
        make_task(title="A", assignee_1=alice)
        make_task(title="B", assignee_1=bob)
        make_task(title="Unassigned")
        assert len(client.get("/tasks", headers=auth(leader)).json()) == 3

    def test_programmer_sees_only_their_queue(self, client, auth, alice, bob, make_task):
        mine = make_task(title="Mine", assignee_1=alice)
        make_task(title="Theirs", assignee_1=bob)
        queue = client.get("/tasks", headers=auth(alice)).json()
        assert [t["id"] for t in queue] == [mine.id]

    def test_programmer_cannot_widen_their_queue_with_a_filter(
        self, client, auth, alice, bob, make_task
    ):
        make_task(title="Theirs", assignee_1=bob)
        queue = client.get(f"/tasks?assignee_id={bob.id}", headers=auth(alice)).json()
        assert queue == []

    def test_other_peoples_tasks_are_404_not_403(self, client, auth, alice, bob, make_task):
        task = make_task(title="Theirs", assignee_1=bob)
        assert client.get(f"/tasks/{task.id}", headers=auth(alice)).status_code == 404

    def test_second_assignee_can_open_the_task(self, client, auth, alice, bob, make_task):
        task = make_task(title="Shared", assignee_1=alice, assignee_2=bob)
        assert client.get(f"/tasks/{task.id}", headers=auth(bob)).status_code == 200


class TestStatusChanges:
    def test_either_assignee_can_advance_a_shared_task(
        self, client, auth, alice, bob, make_task
    ):
        task = make_task(assignee_1=alice, assignee_2=bob)
        first = client.patch(
            f"/tasks/{task.id}/status", headers=auth(alice), json={"status": "in_progress_back"}
        )
        assert first.json()["status"] == "in_progress_back"
        second = client.patch(
            f"/tasks/{task.id}/status", headers=auth(bob), json={"status": "in_progress_front"}
        )
        assert second.json()["status"] == "in_progress_front"

    def test_each_change_records_who_made_it(self, client, auth, alice, bob, make_task):
        task = make_task(assignee_1=alice, assignee_2=bob)
        client.patch(
            f"/tasks/{task.id}/status", headers=auth(alice), json={"status": "in_progress_back"}
        )
        client.patch(
            f"/tasks/{task.id}/status", headers=auth(bob), json={"status": "in_review"}
        )
        events = client.get(f"/tasks/{task.id}", headers=auth(alice)).json()["events"]
        actors = [e["actor_id"] for e in events if e["event_type"] == "status_changed"]
        assert actors == [alice.id, bob.id]

    def test_programmer_cannot_reach_done(self, client, auth, alice, make_task):
        task = make_task(status=TaskStatus.in_review, assignee_1=alice)
        response = client.patch(
            f"/tasks/{task.id}/status", headers=auth(alice), json={"status": "done"}
        )
        assert response.status_code == 409
        assert "leader" in response.json()["detail"]

    def test_invalid_transition_is_a_conflict(self, client, auth, alice, make_task):
        task = make_task(status=TaskStatus.to_do, assignee_1=alice)
        response = client.patch(
            f"/tasks/{task.id}/status", headers=auth(alice), json={"status": "in_review"}
        )
        assert response.status_code == 409

    def test_non_assignee_cannot_move_a_task(self, client, auth, bob, alice, make_task):
        task = make_task(assignee_1=alice)
        response = client.patch(
            f"/tasks/{task.id}/status", headers=auth(bob), json={"status": "in_progress_front"}
        )
        assert response.status_code == 404

    def test_leader_approval_logs_approved_and_closed(self, client, auth, leader, alice, make_task):
        task = make_task(status=TaskStatus.in_review, assignee_1=alice)
        response = client.patch(
            f"/tasks/{task.id}/status", headers=auth(leader), json={"status": "done"}
        )
        assert response.status_code == 200
        assert response.json()["status"] == "done"
        assert _events(client, auth(leader), task.id) == [
            ("approved", "in_review", "done"),
            ("closed", "in_review", "done"),
        ]

    def test_done_is_terminal_over_http(self, client, auth, leader, alice, make_task):
        task = make_task(status=TaskStatus.done, assignee_1=alice)
        response = client.patch(
            f"/tasks/{task.id}/status", headers=auth(leader), json={"status": "in_review"}
        )
        assert response.status_code == 409

    def test_leader_sending_work_back_requires_a_comment(
        self, client, auth, leader, alice, make_task
    ):
        task = make_task(status=TaskStatus.in_review, assignee_1=alice)
        bare = client.patch(
            f"/tasks/{task.id}/status",
            headers=auth(leader),
            json={"status": "in_progress_front"},
        )
        assert bare.status_code == 422

    def test_leader_sending_work_back_logs_a_rejection(
        self, client, auth, leader, alice, make_task
    ):
        task = make_task(status=TaskStatus.in_review, assignee_1=alice)
        response = client.patch(
            f"/tasks/{task.id}/status",
            headers=auth(leader),
            json={"status": "in_progress_front", "comment": "needs tests"},
        )
        assert response.status_code == 200
        assert _events(client, auth(leader), task.id) == [
            ("rejected", "in_review", "in_progress_front")
        ]

    def test_missing_task_is_404(self, client, auth, leader):
        response = client.patch(
            "/tasks/4242/status", headers=auth(leader), json={"status": "in_review"}
        )
        assert response.status_code == 404


class TestRejectEndpoint:
    def test_leader_rejects_with_a_comment(self, client, auth, leader, alice, make_task):
        task = make_task(status=TaskStatus.in_review, assignee_1=alice)
        response = client.post(
            f"/tasks/{task.id}/reject",
            headers=auth(leader),
            json={"to_status": "in_progress_back", "comment": "Missing tests"},
        )
        assert response.status_code == 200
        assert response.json()["status"] == "in_progress_back"
        events = response.json()["events"]
        assert events[-1]["event_type"] == "rejected"
        assert events[-1]["comment"] == "Missing tests"

    def test_comment_is_required(self, client, auth, leader, alice, make_task):
        task = make_task(status=TaskStatus.in_review, assignee_1=alice)
        for payload in ({"to_status": "in_progress_back"}, {"to_status": "in_progress_back", "comment": "  "}):
            response = client.post(f"/tasks/{task.id}/reject", headers=auth(leader), json=payload)
            assert response.status_code == 422

    def test_programmers_cannot_reject(self, client, auth, alice, make_task):
        task = make_task(status=TaskStatus.in_review, assignee_1=alice)
        response = client.post(
            f"/tasks/{task.id}/reject",
            headers=auth(alice),
            json={"to_status": "in_progress_back", "comment": "x"},
        )
        assert response.status_code == 403

    def test_cannot_reject_a_task_that_is_not_in_review(self, client, auth, leader, alice, make_task):
        task = make_task(status=TaskStatus.to_do, assignee_1=alice)
        response = client.post(
            f"/tasks/{task.id}/reject",
            headers=auth(leader),
            json={"to_status": "in_progress_back", "comment": "x"},
        )
        assert response.status_code == 409

    def test_cannot_reject_into_an_invalid_status(self, client, auth, leader, alice, make_task):
        task = make_task(status=TaskStatus.in_review, assignee_1=alice)
        response = client.post(
            f"/tasks/{task.id}/reject",
            headers=auth(leader),
            json={"to_status": "done", "comment": "x"},
        )
        assert response.status_code == 409


class TestAssignment:
    def test_leader_reassigns_and_it_is_audited(self, client, auth, leader, alice, bob, make_task):
        task = make_task(assignee_1=alice)
        response = client.patch(
            f"/tasks/{task.id}/assign",
            headers=auth(leader),
            json={"assignee_1_id": bob.id},
        )
        assert response.status_code == 200
        assert response.json()["assignee_1_id"] == bob.id
        assert response.json()["events"][-1]["comment"].startswith("Reassigned")

    def test_reassignment_moves_the_task_between_queues(
        self, client, auth, leader, alice, bob, make_task
    ):
        task = make_task(assignee_1=alice)
        client.patch(
            f"/tasks/{task.id}/assign", headers=auth(leader), json={"assignee_1_id": bob.id}
        )
        assert client.get("/tasks", headers=auth(alice)).json() == []
        assert len(client.get("/tasks", headers=auth(bob)).json()) == 1

    def test_programmers_cannot_reassign(self, client, auth, alice, bob, make_task):
        task = make_task(assignee_1=alice)
        response = client.patch(
            f"/tasks/{task.id}/assign", headers=auth(alice), json={"assignee_1_id": bob.id}
        )
        assert response.status_code == 403


class TestPoints:
    """Difficulty is set by the leader on the Fibonacci scale in POINT_VALUES."""

    def test_defaults_to_the_middle_of_the_scale(self, client, auth, leader):
        response = client.post("/tasks", headers=auth(leader), json={"title": "x"})
        assert response.status_code == 201
        assert response.json()["points"] == 3

    @pytest.mark.parametrize("points", [1, 2, 3, 5, 8, 13])
    def test_every_scale_value_is_accepted(self, client, auth, leader, points):
        response = client.post(
            "/tasks", headers=auth(leader), json={"title": "x", "points": points}
        )
        assert response.status_code == 201
        assert response.json()["points"] == points

    @pytest.mark.parametrize("points", [0, -1, 4, 6, 7, 9, 21, 100])
    def test_off_scale_values_are_rejected(self, client, auth, leader, points):
        response = client.post(
            "/tasks", headers=auth(leader), json={"title": "x", "points": points}
        )
        assert response.status_code == 422

    def test_points_are_independent_of_priority(self, client, auth, leader):
        """Urgency and difficulty are separate axes: a trivial task can be urgent."""
        response = client.post(
            "/tasks",
            headers=auth(leader),
            json={"title": "x", "priority": "urgent", "points": 1},
        )
        assert response.json()["priority"] == "urgent"
        assert response.json()["points"] == 1

    def test_leader_can_re_estimate_an_existing_task(self, client, auth, leader, make_task):
        task = make_task()
        response = client.patch(f"/tasks/{task.id}", headers=auth(leader), json={"points": 8})
        assert response.status_code == 200
        assert response.json()["points"] == 8

    def test_re_estimating_off_scale_is_rejected(self, client, auth, leader, make_task):
        task = make_task()
        assert (
            client.patch(f"/tasks/{task.id}", headers=auth(leader), json={"points": 4}).status_code
            == 422
        )

    def test_programmers_cannot_re_estimate(self, client, auth, alice, make_task):
        task = make_task(assignee_1=alice)
        response = client.patch(f"/tasks/{task.id}", headers=auth(alice), json={"points": 13})
        assert response.status_code == 403

    def test_points_are_visible_to_the_assignee(self, client, auth, alice, make_task):
        task = make_task(assignee_1=alice, points=8)
        assert client.get(f"/tasks/{task.id}", headers=auth(alice)).json()["points"] == 8
