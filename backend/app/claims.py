"""Claim leases that follow activity.

A claim lasts while its holder works on the task: every event the holder
records (a comment, a criterion, a git link, a status change, a hand-back...)
pushes the lease to `claim_idle_free_hours` from now. A background sweep:

- after `claim_idle_warn_hours` without activity, reminds the holder once
  (in the app, and by email when they get claim emails);
- when the lease runs out, frees the claim, sends the task back to the lane
  the claim took it from (backlog or to_do) and tells the holder and the leads.

The sweep runs in a thread next to the email sender (one uvicorn worker).
"""

from __future__ import annotations

import logging
import threading
from datetime import datetime, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import settings
from app.events import log_event
from app.models import (
    CLOSED_STATUSES,
    ActorKind,
    EventType,
    Notification,
    NotifyKind,
    Task,
    TaskStatus,
    User,
    utcnow,
)

log = logging.getLogger(__name__)
S = TaskStatus


def lease_end(now: datetime) -> datetime:
    return now + timedelta(hours=settings.claim_idle_free_hours)


def renew_on_activity(db: Session, task_id: int, user_id: int, now: datetime | None = None) -> None:
    """The holder did something on the task: restart the idle clock."""
    task = db.get(Task, task_id)
    if task is None or task.claimed_by != user_id:
        return
    now = now or utcnow()
    if task.claim_expires_at is None or task.claim_expires_at <= now:
        return
    task.claim_expires_at = max(task.claim_expires_at, lease_end(now))
    task.claim_warned_at = None


def _note(db: Session, user: User | None, task: Task, kind: NotifyKind, text: str, now: datetime) -> None:
    """A notification with no actor: the hub itself sends it."""
    from app.notify import wants_email
    from app.routers.tasks import _can_see

    if user is None or not user.is_active or user.is_bot or not _can_see(task, user):
        return
    db.add(Notification(
        user_id=user.id, task_id=task.id, kind=kind, actor_id=None, actor_kind=ActorKind.human,
        text=text, created_at=now,
        email_state="pending" if wants_email(user, kind) else "skipped",
    ))


def _origin(task: Task) -> TaskStatus | None:
    from app.routers.tasks import _claim_origin

    return _claim_origin(task)


def sweep(db: Session, now: datetime | None = None) -> dict[str, int]:
    """Remind idle holders and free lapsed claims. Commits. Returns counts."""
    from app.notify import leads

    now = now or utcnow()
    warn_after = timedelta(hours=settings.claim_idle_free_hours - settings.claim_idle_warn_hours)
    reminded = freed = 0
    held = list(db.scalars(select(Task).where(Task.claimed_by.is_not(None), Task.claim_expires_at.is_not(None))))
    lead_list = None
    for task in held:
        holder = task.claimer
        if task.claim_expires_at <= now:
            from_status = task.status
            data = {"holder": task.claimed_by, "agent": task.claim_agent, "reason": "idle",
                    "idle_hours": settings.claim_idle_free_hours}
            origin = _origin(task) if task.status is S.in_progress else None
            back = origin is not None and not any(c.status not in CLOSED_STATUSES for c in task.children)
            if back:
                log_event(db, task_id=task.id, actor_id=task.claimed_by, event_type=EventType.status_changed,
                          from_status=from_status, to_status=origin, timestamp=now,
                          comment=f"Freed after {settings.claim_idle_free_hours:g} hours without activity")
                task.status = origin
            log_event(db, task_id=task.id, actor_id=task.claimed_by, event_type=EventType.released,
                      timestamp=now, data=data)
            task.claimed_by = None
            task.claim_agent = None
            task.claim_expires_at = None
            task.claim_warned_at = None
            task.version = (task.version or 1) + 1
            task.updated_at = now
            where = f"back in {origin.value.replace('_', ' ')}" if back else "still in progress"
            text = (f"Your claim was freed after {settings.claim_idle_free_hours:g} hours without activity; "
                    f"the task is {where} and anyone on its side can take it.")
            _note(db, holder, task, NotifyKind.claim_freed, text, now)
            if lead_list is None:
                lead_list = leads(db)
            for lead in lead_list:
                if holder is None or lead.id != holder.id:
                    who = (holder.handle or holder.name) if holder else "someone"
                    _note(db, lead, task, NotifyKind.claim_freed,
                          f"@{who}'s claim was freed after {settings.claim_idle_free_hours:g} idle hours.", now)
            freed += 1
        elif task.claim_warned_at is None and task.claim_expires_at - now <= warn_after:
            left = task.claim_expires_at - now
            hours = max(1, round(left.total_seconds() / 3600))
            _note(db, holder, task, NotifyKind.claim_idle,
                  f"No activity on your claim for {settings.claim_idle_warn_hours:g} hours. Post an update or "
                  f"release it; it is freed in about {hours} hours.", now)
            task.claim_warned_at = now
            reminded += 1
    db.commit()
    return {"reminded": reminded, "freed": freed}


class Sweeper:
    """The background thread. Started and stopped with the app."""

    def __init__(self) -> None:
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def start(self) -> bool:
        if settings.claim_sweeper == "off":
            return False
        self._thread = threading.Thread(target=self._loop, name="claim-sweeper", daemon=True)
        self._thread.start()
        return True

    def stop(self) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=5)

    def _loop(self) -> None:
        from app.database import SessionLocal

        while not self._stop.wait(settings.claim_sweep_seconds):
            db = SessionLocal()
            try:
                counts = sweep(db)
                if any(counts.values()):
                    log.info("claim sweep: %s", counts)
            except Exception:  # noqa: BLE001 - keep the loop alive
                db.rollback()
                log.exception("claim sweep failed")
            finally:
                db.close()


sweeper = Sweeper()
