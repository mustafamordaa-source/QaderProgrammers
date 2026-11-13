"""The single source of truth for task status transitions.

Every status change in the system is validated here, so there is exactly one
place to read (or change) the workflow rules.

    proposed ──▶ backlog ──▶ to_do ──▶ in_progress ──▶ in_review ──▶ done
        │           ▲  │       ▲  │          ▲              │
        │           └──┼───────┘  │          └──────────────┘ (leader: reject)
        └──────────────┴──────────┴──▶ dropped (leader, reason required)

    Any open working status ──▶ blocked / needs_confirm ──▶ back to where it was.
"""

from __future__ import annotations

from app.models import CLOSED_STATUSES, LEGACY_IN_PROGRESS, Role, TaskStatus

S = TaskStatus

# from_status -> set of reachable statuses (blocked / needs_confirm handled apart).
ALLOWED_TRANSITIONS: dict[TaskStatus, set[TaskStatus]] = {
    S.proposed: {S.backlog, S.to_do, S.dropped},
    S.backlog: {S.to_do, S.dropped},
    S.to_do: {S.in_progress, S.backlog, S.dropped},
    S.in_progress: {S.in_review, S.to_do, S.dropped},
    # Leaving review is a leader decision: approve to done, or reject back.
    S.in_review: {S.done, S.in_progress, S.dropped},
    S.blocked: {S.dropped},
    S.needs_confirm: {S.dropped},
    S.done: set(),
    S.dropped: set(),
}

# Statuses a task can be parked from, and the two parking statuses.
PARKABLE: set[TaskStatus] = {S.backlog, S.to_do, S.in_progress, S.in_review}
PARKING: set[TaskStatus] = {S.blocked, S.needs_confirm}

# Transitions only a leader may perform.
LEADER_ONLY_TARGETS: set[TaskStatus] = {S.done, S.dropped}
# Triage moves: deciding what enters the plan is the leader's call.
LEADER_ONLY_MOVES: set[tuple[TaskStatus, TaskStatus]] = {
    (S.proposed, S.backlog),
    (S.proposed, S.to_do),
    (S.backlog, S.to_do),
    (S.to_do, S.backlog),
}

# Kept for callers that still import the old name.
IN_PROGRESS_STATUSES: set[TaskStatus] = {S.in_progress}


class TransitionError(ValueError):
    """Raised when a requested transition is not permitted."""


def allowed_targets(current: TaskStatus, resume_status: TaskStatus | None = None) -> set[TaskStatus]:
    """Every status reachable from `current`, ignoring who asks."""
    if current in PARKING:
        targets = set(ALLOWED_TRANSITIONS[current])
        targets.add(resume_status or S.to_do)
        # Switching between the two parking statuses is allowed too.
        targets |= PARKING - {current}
        return targets
    targets = set(ALLOWED_TRANSITIONS.get(current, set()))
    if current in PARKABLE:
        targets |= PARKING
    return targets


def check_transition(
    *,
    current: TaskStatus,
    target: TaskStatus,
    role: Role,
    is_assignee: bool,
    resume_status: TaskStatus | None = None,
) -> None:
    """Validate a status change, raising TransitionError with a usable message.

    `is_assignee` is ignored for leaders, who may move any task. For a pool
    task, the caller passes True when the person holds the claim.
    """
    if target in LEGACY_IN_PROGRESS:
        raise TransitionError(
            f"'{target.value}' is retired. Use 'in_progress' and set the task's side."
        )

    if current == target:
        raise TransitionError(f"Task is already in status '{target.value}'.")

    if current in CLOSED_STATUSES:
        raise TransitionError(
            f"'{current.value}' is terminal; a closed task cannot be reopened."
        )

    targets = allowed_targets(current, resume_status)
    if target not in targets:
        allowed = sorted(s.value for s in targets)
        raise TransitionError(
            f"Cannot move a task from '{current.value}' to '{target.value}'. "
            f"Allowed from here: {allowed or ['(none)']}."
        )

    if role is Role.leader:
        return

    if role is Role.viewer:
        raise TransitionError("Viewer accounts are read-only.")

    if target in LEADER_ONLY_TARGETS:
        raise TransitionError(f"Only a leader can move a task to '{target.value}'.")

    if (current, target) in LEADER_ONLY_MOVES:
        raise TransitionError(
            f"Only a leader can move a task from '{current.value}' to '{target.value}'."
        )

    # A leader sending work back out of review is a rejection, which goes
    # through the dedicated reject endpoint.
    if current == S.in_review and target in IN_PROGRESS_STATUSES:
        raise TransitionError("Only a leader can send a task back out of review.")

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
