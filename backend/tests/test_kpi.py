"""KPI computation.

These build event logs by hand with explicit timestamps, so every expected
number is arithmetic the test states outright rather than a snapshot.
"""

from __future__ import annotations

from datetime import datetime, timedelta

import pytest

from app.events import log_event
from app.kpi.service import compute_metrics, resolve_range
from app.models import EventType, TaskStatus as S

BASE = datetime(2026, 3, 2, 9, 0, 0)  # a Monday
WINDOW = (BASE - timedelta(days=30), BASE + timedelta(days=30))


@pytest.fixture()
def flow(db_session, leader):
    """Drive a task through a status sequence at fixed hourly offsets."""

    def _flow(task, steps: list[tuple[EventType, S | None, S, int]], actor=None):
        log_event(
            db_session,
            task_id=task.id,
            actor_id=leader.id,
            event_type=EventType.created,
            to_status=S.to_do,
            timestamp=task.created_at,
        )
        current = S.to_do
        for event_type, _, to_status, hours_from_base in steps:
            log_event(
                db_session,
                task_id=task.id,
                actor_id=(actor or leader).id,
                event_type=event_type,
                from_status=current,
                to_status=to_status,
                timestamp=task.created_at + timedelta(hours=hours_from_base),
            )
            current = to_status
        task.status = current
        db_session.commit()
        db_session.refresh(task)
        return task

    return _flow


def _metrics(tasks, window=WINDOW):
    return compute_metrics(tasks, *window)


class TestRange:
    def test_defaults_to_the_last_90_days(self):
        start, end = resolve_range(None, None)
        assert (end - start).days == 90

    def test_rejects_an_inverted_range(self):
        with pytest.raises(ValueError):
            resolve_range(datetime(2026, 5, 1), datetime(2026, 4, 1))

    def test_normalises_aware_timestamps_to_naive_utc(self):
        start, end = resolve_range(
            datetime.fromisoformat("2026-03-01T00:00:00+02:00"),
            datetime.fromisoformat("2026-03-02T00:00:00+02:00"),
        )
        assert start == datetime(2026, 2, 28, 22, 0)
        assert end.tzinfo is None


class TestSpeed:
    def test_cycle_time_runs_from_creation_to_close(self, make_task, flow):
        task = make_task(created_at=BASE)
        flow(task, [
            (EventType.status_changed, None, S.in_progress_back, 2),
            (EventType.status_changed, None, S.in_review, 6),
            (EventType.approved, None, S.done, 10),
            (EventType.closed, None, S.done, 10),
        ])
        speed, *_ = _metrics([task])
        assert speed.avg_cycle_time_hours == 10.0
        assert speed.median_cycle_time_hours == 10.0

    def test_time_in_status_measures_each_stage(self, make_task, flow):
        task = make_task(created_at=BASE)
        flow(task, [
            (EventType.status_changed, None, S.in_progress_back, 3),   # to_do: 3h
            (EventType.status_changed, None, S.in_progress_front, 8),  # back: 5h
            (EventType.status_changed, None, S.in_review, 10),         # front: 2h
            (EventType.approved, None, S.done, 14),                    # review: 4h
            (EventType.closed, None, S.done, 14),
        ])
        speed, *_ = _metrics([task])
        assert speed.avg_time_in_status_hours == {
            "to_do": 3.0,
            "in_progress_back": 5.0,
            "in_progress_front": 2.0,
            "in_review": 4.0,
        }

    def test_the_current_open_stage_is_not_averaged_in(self, make_task, flow):
        """An unfinished stay would otherwise drag every average toward zero."""
        task = make_task(created_at=BASE)
        flow(task, [(EventType.status_changed, None, S.in_progress_front, 4)])
        speed, *_ = _metrics([task])
        assert speed.avg_time_in_status_hours["to_do"] == 4.0
        assert speed.avg_time_in_status_hours["in_progress_front"] is None
        assert speed.avg_cycle_time_hours is None

    def test_a_reassignment_does_not_split_a_stage_in_two(self, db_session, make_task, flow, leader):
        """Reassign events carry from_status == to_status; merging them keeps
        one six-hour stay from being counted as two three-hour ones."""
        task = make_task(created_at=BASE)
        flow(task, [(EventType.status_changed, None, S.in_progress_front, 6)])
        log_event(
            db_session,
            task_id=task.id,
            actor_id=leader.id,
            event_type=EventType.status_changed,
            from_status=S.to_do,
            to_status=S.to_do,
            comment="Reassigned",
            timestamp=BASE + timedelta(hours=3),
        )
        db_session.commit()
        db_session.refresh(task)
        speed, *_ = _metrics([task])
        assert speed.avg_time_in_status_hours["to_do"] == 6.0


class TestQuality:
    def test_rejection_rate_is_rejections_over_submissions(self, make_task, flow):
        task = make_task(created_at=BASE)
        flow(task, [
            (EventType.status_changed, None, S.in_progress_front, 1),
            (EventType.status_changed, None, S.in_review, 2),
            (EventType.rejected, None, S.in_progress_front, 3),
            (EventType.status_changed, None, S.in_review, 4),
            (EventType.approved, None, S.done, 5),
            (EventType.closed, None, S.done, 5),
        ])
        _, quality, *_ = _metrics([task])
        assert quality.review_submissions == 2
        assert quality.rejections == 1
        assert quality.rejection_rate == 0.5

    def test_first_pass_rate_counts_tasks_approved_on_one_submission(self, make_task, flow):
        clean = make_task(title="clean", created_at=BASE)
        flow(clean, [
            (EventType.status_changed, None, S.in_progress_front, 1),
            (EventType.status_changed, None, S.in_review, 2),
            (EventType.approved, None, S.done, 3),
            (EventType.closed, None, S.done, 3),
        ])
        bounced = make_task(title="bounced", created_at=BASE)
        flow(bounced, [
            (EventType.status_changed, None, S.in_progress_front, 1),
            (EventType.status_changed, None, S.in_review, 2),
            (EventType.rejected, None, S.in_progress_front, 3),
            (EventType.status_changed, None, S.in_review, 4),
            (EventType.approved, None, S.done, 5),
            (EventType.closed, None, S.done, 5),
        ])
        _, quality, *_ = _metrics([clean, bounced])
        assert quality.first_pass_rate == 0.5

    def test_rates_are_none_when_there_is_nothing_to_divide_by(self, make_task, flow):
        task = make_task(created_at=BASE)
        flow(task, [])
        _, quality, *_ = _metrics([task])
        assert quality.rejection_rate is None
        assert quality.first_pass_rate is None


class TestVolume:
    def test_open_tasks_are_grouped_by_current_status(self, make_task, flow):
        a = make_task(title="a", created_at=BASE)
        flow(a, [(EventType.status_changed, None, S.in_progress_front, 1)])
        b = make_task(title="b", created_at=BASE)
        flow(b, [(EventType.status_changed, None, S.in_progress_front, 1)])
        c = make_task(title="c", created_at=BASE)
        flow(c, [])
        *_, volume, _ = _metrics([a, b, c])
        assert volume.open_total == 3
        assert volume.open_by_status["in_progress_front"] == 2
        assert volume.open_by_status["to_do"] == 1
        assert volume.completed_total == 0

    def test_completed_tasks_are_bucketed_by_week_and_month(self, make_task, flow):
        first = make_task(title="first", created_at=BASE)
        flow(first, [
            (EventType.status_changed, None, S.in_progress_front, 1),
            (EventType.status_changed, None, S.in_review, 2),
            (EventType.approved, None, S.done, 3),
            (EventType.closed, None, S.done, 3),
        ])
        later = make_task(title="later", created_at=BASE)
        flow(later, [
            (EventType.status_changed, None, S.in_progress_front, 1),
            (EventType.status_changed, None, S.in_review, 2),
            (EventType.approved, None, S.done, 24 * 8),
            (EventType.closed, None, S.done, 24 * 8),
        ])
        *_, volume, _ = _metrics([first, later])
        assert volume.completed_total == 2
        assert volume.completed_per_week == {"2026-W10": 1, "2026-W11": 1}
        assert volume.completed_per_month == {"2026-03": 2}

    def test_completions_outside_the_window_are_excluded(self, make_task, flow):
        task = make_task(created_at=BASE)
        flow(task, [
            (EventType.status_changed, None, S.in_progress_front, 1),
            (EventType.status_changed, None, S.in_review, 2),
            (EventType.approved, None, S.done, 3),
            (EventType.closed, None, S.done, 3),
        ])
        narrow = (BASE + timedelta(days=1), BASE + timedelta(days=2))
        *_, volume, _ = _metrics([task], narrow)
        assert volume.completed_total == 0
        # Still counted as open work, since open counts are a "right now" figure.
        assert volume.open_total == 0


class TestOnTime:
    def _close_at(self, make_task, flow, hours: int, due_in_days: int | None):
        task = make_task(created_at=BASE, due_in_days=due_in_days)
        flow(task, [
            (EventType.status_changed, None, S.in_progress_front, 1),
            (EventType.status_changed, None, S.in_review, 2),
            (EventType.approved, None, S.done, hours),
            (EventType.closed, None, S.done, hours),
        ])
        return task

    def test_on_time_when_closed_before_the_due_date(self, make_task, flow):
        task = self._close_at(make_task, flow, hours=24, due_in_days=3)
        *_, on_time = _metrics([task])
        assert on_time.on_time_rate == 1.0

    def test_late_when_closed_after_the_due_date(self, make_task, flow):
        task = self._close_at(make_task, flow, hours=24 * 5, due_in_days=3)
        *_, on_time = _metrics([task])
        assert on_time.on_time == 0
        assert on_time.on_time_rate == 0.0

    def test_tasks_without_a_due_date_are_left_out_of_the_denominator(self, make_task, flow):
        undated = self._close_at(make_task, flow, hours=24, due_in_days=None)
        late = self._close_at(make_task, flow, hours=24 * 5, due_in_days=3)
        *_, on_time = _metrics([undated, late])
        assert on_time.completed_with_due_date == 1
        assert on_time.on_time_rate == 0.0


class TestAttribution:
    """A dual-assigned task counts in full for both assignees, once for the team."""

    def test_both_assignees_are_credited_for_a_shared_completion(
        self, client, auth, leader, alice, bob, make_task, flow
    ):
        task = make_task(created_at=BASE, assignee_1=alice, assignee_2=bob)
        flow(task, [
            (EventType.status_changed, None, S.in_progress_front, 1),
            (EventType.status_changed, None, S.in_review, 2),
            (EventType.approved, None, S.done, 3),
            (EventType.closed, None, S.done, 3),
        ])
        window = {"range_start": BASE.isoformat(), "range_end": (BASE + timedelta(days=1)).isoformat()}
        for user in (alice, bob):
            report = client.get("/kpi/me", headers=auth(user), params=window).json()
            assert report["volume"]["completed_total"] == 1, user.name

        team = client.get("/kpi/team", headers=auth(leader), params=window).json()
        assert team["volume"]["completed_total"] == 1
        assert sum(p["volume"]["completed_total"] for p in team["programmers"]) == 2

    def test_the_leader_who_closes_a_task_is_not_credited_with_it(
        self, client, auth, leader, alice, make_task, flow
    ):
        """Credit follows assignment, not `actor_id` — the leader closes everything."""
        task = make_task(created_at=BASE, assignee_1=alice)
        flow(task, [
            (EventType.status_changed, None, S.in_progress_front, 1),
            (EventType.status_changed, None, S.in_review, 2),
            (EventType.approved, None, S.done, 3),
            (EventType.closed, None, S.done, 3),
        ])
        window = {"range_start": BASE.isoformat(), "range_end": (BASE + timedelta(days=1)).isoformat()}
        team = client.get("/kpi/team", headers=auth(leader), params=window).json()
        by_name = {p["user_name"]: p["volume"]["completed_total"] for p in team["programmers"]}
        assert by_name == {"Alice": 1}

    def test_a_programmer_only_sees_their_own_numbers(
        self, client, auth, alice, bob, make_task, flow
    ):
        theirs = make_task(title="bob's", created_at=BASE, assignee_1=bob)
        flow(theirs, [
            (EventType.status_changed, None, S.in_progress_front, 1),
            (EventType.status_changed, None, S.in_review, 2),
            (EventType.approved, None, S.done, 3),
            (EventType.closed, None, S.done, 3),
        ])
        report = client.get("/kpi/me", headers=auth(alice)).json()
        assert report["scope"] == "programmer"
        assert report["volume"]["completed_total"] == 0
        assert client.get(f"/kpi/programmer/{bob.id}", headers=auth(alice)).status_code == 403


class TestKpiRoutes:
    def test_leader_can_read_a_specific_programmer(self, client, auth, leader, alice):
        response = client.get(f"/kpi/programmer/{alice.id}", headers=auth(leader))
        assert response.status_code == 200
        assert response.json()["user_name"] == "Alice"

    def test_asking_for_a_leader_as_a_programmer_is_404(self, client, auth, leader):
        assert client.get(f"/kpi/programmer/{leader.id}", headers=auth(leader)).status_code == 404

    def test_an_inverted_range_is_rejected(self, client, auth, leader):
        response = client.get(
            "/kpi/team",
            headers=auth(leader),
            params={"range_start": "2026-05-01T00:00:00", "range_end": "2026-04-01T00:00:00"},
        )
        assert response.status_code == 422

    def test_leader_kpi_me_falls_back_to_the_team_view(self, client, auth, leader):
        assert client.get("/kpi/me", headers=auth(leader)).json()["scope"] == "team"


class TestCycleTimeTrend:
    def test_cycle_time_is_bucketed_by_the_week_it_closed_in(self, make_task, flow):
        fast = make_task(title="fast", created_at=BASE)
        flow(fast, [
            (EventType.status_changed, None, S.in_progress_front, 1),
            (EventType.status_changed, None, S.in_review, 2),
            (EventType.approved, None, S.done, 10),
            (EventType.closed, None, S.done, 10),
        ])
        slow = make_task(title="slow", created_at=BASE)
        flow(slow, [
            (EventType.status_changed, None, S.in_progress_front, 1),
            (EventType.status_changed, None, S.in_review, 2),
            (EventType.approved, None, S.done, 20),
            (EventType.closed, None, S.done, 20),
        ])
        next_week = make_task(title="next week", created_at=BASE)
        flow(next_week, [
            (EventType.status_changed, None, S.in_progress_front, 1),
            (EventType.status_changed, None, S.in_review, 2),
            (EventType.approved, None, S.done, 24 * 8),
            (EventType.closed, None, S.done, 24 * 8),
        ])
        speed, *_ = _metrics([fast, slow, next_week])
        # 10h and 20h closed in W10, 192h in W11.
        assert speed.avg_cycle_time_per_week == {"2026-W10": 15.0, "2026-W11": 192.0}
