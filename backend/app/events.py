"""Helpers for appending to the task_events audit log.

Every mutation that changes a task's status funnels through `log_event` so the
KPI layer can trust that the log is complete.
"""

from __future__ import annotations

from sqlalchemy.orm import Session

from app.models import EventType, TaskEvent, TaskStatus, utcnow


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
) -> TaskEvent:
    event = TaskEvent(
        task_id=task_id,
        actor_id=actor_id,
        event_type=event_type,
        from_status=from_status,
        to_status=to_status,
        comment=comment,
        timestamp=timestamp or utcnow(),
    )
    db.add(event)
    return event
