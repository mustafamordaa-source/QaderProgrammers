"""The transition matrix, exercised both as a pure function and over HTTP."""

from __future__ import annotations

import pytest

from app.models import Role, TaskStatus as S
from app.transitions import (
    ALLOWED_TRANSITIONS,
    TransitionError,
    check_rejection,
    check_transition,
)


def _allow(current, target, role, is_assignee=True):
    check_transition(current=current, target=target, role=role, is_assignee=is_assignee)


def _deny(current, target, role, is_assignee=True):
    with pytest.raises(TransitionError):
        _allow(current, target, role, is_assignee)


class TestMatrix:
    def test_every_status_has_an_entry(self):
        assert set(ALLOWED_TRANSITIONS) == set(S)

    @pytest.mark.parametrize("target", [S.in_progress_front, S.in_progress_back])
    def test_todo_starts_either_kind_of_work(self, target):
        _allow(S.to_do, target, Role.programmer)

    def test_work_can_move_between_front_and_back(self):
        _allow(S.in_progress_front, S.in_progress_back, Role.programmer)
        _allow(S.in_progress_back, S.in_progress_front, Role.programmer)

    @pytest.mark.parametrize("current", [S.in_progress_front, S.in_progress_back])
    def test_work_can_be_submitted_for_review(self, current):
        _allow(current, S.in_review, Role.programmer)

    def test_a_task_need_not_visit_both_progress_stages(self):
        """Frontend-only work goes to_do -> front -> in_review with no back stage."""
        _allow(S.to_do, S.in_progress_front, Role.programmer)
        _allow(S.in_progress_front, S.in_review, Role.programmer)


class TestDoneIsProtected:
    @pytest.mark.parametrize("current", [S.to_do, S.in_progress_front, S.in_progress_back])
    def test_nobody_skips_straight_to_done(self, current):
        _deny(current, S.done, Role.leader)
        _deny(current, S.done, Role.programmer)

    def test_programmers_cannot_complete_a_task(self):
        _deny(S.in_review, S.done, Role.programmer)

    def test_leaders_can_complete_a_task_from_review(self):
        _allow(S.in_review, S.done, Role.leader)

    @pytest.mark.parametrize("target", [S.to_do, S.in_progress_front, S.in_review])
    def test_done_is_terminal(self, target):
        _deny(S.done, target, Role.leader)


class TestReview:
    @pytest.mark.parametrize("target", [S.in_progress_front, S.in_progress_back])
    def test_only_leaders_send_work_back(self, target):
        _allow(S.in_review, target, Role.leader)
        _deny(S.in_review, target, Role.programmer)

    def test_rejection_must_start_from_review(self):
        check_rejection(current=S.in_review, target=S.in_progress_back)
        with pytest.raises(TransitionError):
            check_rejection(current=S.to_do, target=S.in_progress_back)

    def test_rejection_must_land_in_progress(self):
        for bad in (S.to_do, S.done, S.in_review):
            with pytest.raises(TransitionError):
                check_rejection(current=S.in_review, target=bad)


class TestAssignment:
    def test_programmers_cannot_move_someone_elses_task(self):
        _deny(S.to_do, S.in_progress_front, Role.programmer, is_assignee=False)

    def test_leaders_can_move_any_task(self):
        _allow(S.to_do, S.in_progress_front, Role.leader, is_assignee=False)


def test_a_no_op_transition_is_rejected():
    _deny(S.in_review, S.in_review, Role.leader)
