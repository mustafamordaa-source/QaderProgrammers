"""The transition matrix, exercised as a pure function."""

from __future__ import annotations

import pytest

from app.models import LEGACY_IN_PROGRESS, Role, TaskStatus as S
from app.transitions import (
    ALLOWED_TRANSITIONS,
    TransitionError,
    allowed_targets,
    check_rejection,
    check_transition,
)


def _allow(current, target, role, is_assignee=True, resume=None):
    check_transition(
        current=current, target=target, role=role, is_assignee=is_assignee, resume_status=resume
    )


def _deny(current, target, role, is_assignee=True, resume=None):
    with pytest.raises(TransitionError):
        _allow(current, target, role, is_assignee, resume)


class TestMatrix:
    def test_every_live_status_has_an_entry(self):
        assert set(ALLOWED_TRANSITIONS) == set(S) - LEGACY_IN_PROGRESS

    def test_the_happy_path(self):
        _allow(S.to_do, S.in_progress, Role.programmer)
        _allow(S.in_progress, S.in_review, Role.programmer)
        _allow(S.in_review, S.done, Role.leader)

    @pytest.mark.parametrize("legacy", sorted(LEGACY_IN_PROGRESS, key=lambda s: s.value))
    def test_legacy_statuses_cannot_be_entered(self, legacy):
        _deny(S.to_do, legacy, Role.leader)

    def test_work_can_be_put_back_to_do(self):
        _allow(S.in_progress, S.to_do, Role.programmer)


class TestTriage:
    def test_only_leaders_triage_proposals_and_backlog(self):
        for current, target in ((S.proposed, S.backlog), (S.proposed, S.to_do), (S.backlog, S.to_do)):
            _allow(current, target, Role.leader)
            _deny(current, target, Role.programmer)

    def test_only_leaders_drop(self):
        _allow(S.to_do, S.dropped, Role.leader)
        _deny(S.to_do, S.dropped, Role.programmer)

    @pytest.mark.parametrize("target", [S.to_do, S.in_progress, S.backlog])
    def test_dropped_is_terminal(self, target):
        _deny(S.dropped, target, Role.leader)


class TestParking:
    @pytest.mark.parametrize("current", [S.to_do, S.in_progress, S.in_review, S.backlog])
    @pytest.mark.parametrize("target", [S.blocked, S.needs_confirm])
    def test_open_work_can_be_parked(self, current, target):
        _allow(current, target, Role.leader)

    def test_a_parked_task_returns_where_it_was(self):
        _allow(S.blocked, S.in_progress, Role.programmer, resume=S.in_progress)
        _deny(S.blocked, S.in_review, Role.programmer, resume=S.in_progress)

    def test_parked_without_a_resume_status_returns_to_do(self):
        assert S.to_do in allowed_targets(S.needs_confirm, None)

    def test_switch_between_parking_statuses(self):
        _allow(S.blocked, S.needs_confirm, Role.programmer, resume=S.in_progress)

    def test_proposals_cannot_be_parked(self):
        _deny(S.proposed, S.blocked, Role.leader)


class TestDoneIsProtected:
    @pytest.mark.parametrize("current", [S.to_do, S.in_progress, S.backlog])
    def test_nobody_skips_straight_to_done(self, current):
        _deny(current, S.done, Role.leader)
        _deny(current, S.done, Role.programmer)

    def test_programmers_cannot_complete_a_task(self):
        _deny(S.in_review, S.done, Role.programmer)

    @pytest.mark.parametrize("target", [S.to_do, S.in_progress, S.in_review])
    def test_done_is_terminal(self, target):
        _deny(S.done, target, Role.leader)


class TestReview:
    def test_only_leaders_send_work_back(self):
        _allow(S.in_review, S.in_progress, Role.leader)
        _deny(S.in_review, S.in_progress, Role.programmer)

    def test_rejection_must_start_from_review(self):
        check_rejection(current=S.in_review, target=S.in_progress)
        with pytest.raises(TransitionError):
            check_rejection(current=S.to_do, target=S.in_progress)

    def test_rejection_must_land_in_progress(self):
        for bad in (S.to_do, S.done, S.in_review, S.in_progress_front):
            with pytest.raises(TransitionError):
                check_rejection(current=S.in_review, target=bad)


class TestRoles:
    def test_programmers_cannot_move_someone_elses_task(self):
        _deny(S.to_do, S.in_progress, Role.programmer, is_assignee=False)

    def test_leaders_can_move_any_task(self):
        _allow(S.to_do, S.in_progress, Role.leader, is_assignee=False)

    def test_viewers_move_nothing(self):
        _deny(S.to_do, S.in_progress, Role.viewer)


def test_a_no_op_transition_is_rejected():
    _deny(S.in_review, S.in_review, Role.leader)
