"""Helpers for appending to the task_events audit log.

Every mutation that changes a task funnels through `log_event` (or `record`,
which takes the caller's Auth), so the KPI layer and the history view can trust
that the log is complete. The table itself refuses UPDATE and DELETE.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from sqlalchemy.orm import Session

from app.models import ActorKind, EventType, TaskEvent, TaskStatus, utcnow

if TYPE_CHECKING:  # pragma: no cover
    from app.deps import Auth


def log_event(
    db: Session,
    *,
    task_id: int,
    actor_id: int,
    event_type: EventType,
    from_status: TaskStatus | None = None,
    to_status: TaskStatus | None = None,
    comment: str | None = None,
    timestamp=None,
    actor_kind: ActorKind = ActorKind.human,
    agent_name: str | None = None,
    token_id: int | None = None,
    data: dict[str, Any] | None = None,
) -> TaskEvent:
    event = TaskEvent(
        task_id=task_id,
        actor_id=actor_id,
        event_type=event_type,
        from_status=from_status,
        to_status=to_status,
        comment=comment,
        timestamp=timestamp or utcnow(),
        actor_kind=actor_kind,
        agent_name=agent_name,
        token_id=token_id,
        data=data,
    )
    db.add(event)
    return event


def record(
    db: Session,
    auth: "Auth",
    *,
    task_id: int,
    event_type: EventType,
    **kwargs: Any,
) -> TaskEvent:
    """`log_event` with the actor taken from the request's Auth."""
    return log_event(
        db,
        task_id=task_id,
        actor_id=auth.user.id,
        event_type=event_type,
        actor_kind=auth.kind,
        agent_name=auth.agent,
        token_id=auth.token_id,
        **kwargs,
    )
