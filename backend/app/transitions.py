"""The single source of truth for task status transitions.

Every status change in the system is validated here, so there is exactly one
place to read (or change) the workflow rules.
"""

from __future__ import annotations

from app.models import Role, TaskStatus

S = TaskStatus

# from_status -> set of reachable statuses.
ALLOWED_TRANSITIONS: dict[TaskStatus, set[TaskStatus]] = {
    S.to_do: {S.in_progress_front, S.in_progress_back},
    # A task may need frontend work, backend work, or both in either order.
    S.in_progress_front: {S.in_progress_back, S.in_review},
    S.in_progress_back: {S.in_progress_front, S.in_review},
    # Leaving review is a leader decision: approve to done, or reject back.
    S.in_review: {S.done, S.in_progress_front, S.in_progress_back},
    S.done: set(),
}

# Transitions only a leader may perform.
LEADER_ONLY_TARGETS: set[TaskStatus] = {S.done}

IN_PROGRESS_STATUSES: set[TaskStatus] = {S.in_progress_front, S.in_progress_back}


class TransitionError(ValueError):
    """Raised when a requested transition is not permitted."""


def check_transition(
    *,
    current: TaskStatus,
    target: TaskStatus,
    role: Role,
    is_assignee: bool,
) -> None:
    """Validate a status change, raising TransitionError with a usable message.

    `is_assignee` is ignored for leaders, who may move any task.
    """
    if current == target:
        raise TransitionError(f"Task is already in status '{target.value}'.")

    if current == S.done:
        raise TransitionError("Done is terminal; a completed task cannot be reopened.")

    if target not in ALLOWED_TRANSITIONS[current]:
        allowed = sorted(s.value for s in ALLOWED_TRANSITIONS[current])
        raise TransitionError(
            f"Cannot move a task from '{current.value}' to '{target.value}'. "
            f"Allowed from here: {allowed or ['(none)']}."
        )

    if role is Role.leader:
        return

    if target in LEADER_ONLY_TARGETS:
        raise TransitionError(
            f"Only a leader can move a task to '{target.value}'."
        )

    # A leader sending work back out of review is a rejection, which goes
    # through the dedicated reject endpoint.
    if current == S.in_review and target in IN_PROGRESS_STATUSES:
        raise TransitionError(
            "Only a leader can send a task back out of review."
        )

    if not is_assignee:
        raise TransitionError("You can only move tasks assigned to you.")


def check_rejection(*, current: TaskStatus, target: TaskStatus) -> None:
    """Validate a leader rejection out of review."""
    if current != S.in_review:
        raise TransitionError(
            f"Only a task in review can be rejected (task is '{current.value}')."
        )
    if target not in IN_PROGRESS_STATUSES:
        allowed = sorted(s.value for s in IN_PROGRESS_STATUSES)
        raise TransitionError(f"A rejected task must go back to one of: {allowed}.")
