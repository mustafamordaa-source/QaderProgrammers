"""Who hears about what.

Routes call `notify(...)` inside their own transaction, so a notification
exists exactly when the change it describes was committed. Each row shows in
the person's notification list; when the person wants email for that kind,
the row is also queued (`email_state = "pending"`) for the batched sender in
`app.mailer`.

Nobody is told about their own action. Deactivated people and people who
cannot see the task are never notified. A bot hears only when someone tags
it (`@handle`) or asks it a question, never by email: its agent polls the
notification list and replies in that thread.
"""

from __future__ import annotations

import re
from collections.abc import Iterable
from typing import TYPE_CHECKING

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import settings
from app.models import DEFAULT_EMAIL_KINDS, Notification, NotifyKind, Task, User, utcnow

if TYPE_CHECKING:  # pragma: no cover
    from app.deps import Auth

# @handle, not inside an email address or a word.
MENTION_RE = re.compile(r"(?<![\w@.])@([a-z0-9][a-z0-9_-]{1,39})\b", re.IGNORECASE)
LEAD_ONLY_KINDS = {NotifyKind.review, NotifyKind.proposal}
# The only kinds a bot receives: the ones that ask it to reply.
BOT_KINDS = {NotifyKind.mention, NotifyKind.question}


def mentioned_handles(text: str | None) -> set[str]:
    return {m.lower() for m in MENTION_RE.findall(text or "")}


def wants_email(user: User, kind: NotifyKind) -> bool:
    if not user.email_notifications or not settings.email_enabled:
        return False
    kinds = user.notify_kinds or list(DEFAULT_EMAIL_KINDS)
    return kind.value in kinds


def _excerpt(task: Task, text: str | None) -> str | None:
    if task.restricted or not text:
        return None
    text = " ".join(text.split())
    return text[:297] + "..." if len(text) > 300 else text


def notify(
    db: Session,
    auth: "Auth",
    *,
    users: Iterable[User | None],
    task: Task,
    kind: NotifyKind,
    text: str | None = None,
    comment_id: int | None = None,
) -> list[Notification]:
    from app.routers.tasks import _can_see  # visibility rules live with the routes

    out: list[Notification] = []
    seen: set[int] = set()
    for user in users:
        if user is None or user.id in seen:
            continue
        seen.add(user.id)
        if user.id == auth.user.id or not user.is_active:
            continue
        if user.is_bot and (kind not in BOT_KINDS or auth.user.is_bot):
            continue
        if kind in LEAD_ONLY_KINDS and not user.is_lead:
            continue
        if not _can_see(task, user):
            continue
        row = Notification(
            user_id=user.id,
            task_id=task.id,
            comment_id=comment_id,
            kind=kind,
            actor_id=auth.user.id,
            actor_kind=auth.kind,
            agent_name=auth.agent,
            text=_excerpt(task, text),
            created_at=utcnow(),
            email_state="pending" if not user.is_bot and wants_email(user, kind) else "skipped",
        )
        db.add(row)
        out.append(row)
    return out


def leads(db: Session) -> list[User]:
    return [u for u in db.scalars(select(User).where(User.is_active.is_(True))) if u.is_lead and not u.is_bot]


def assignees(task: Task) -> list[User]:
    return [u for u in (task.assignee_1, task.assignee_2) if u is not None]


def by_handles(db: Session, handles: set[str]) -> list[User]:
    if not handles:
        return []
    return list(db.scalars(select(User).where(User.handle.in_(sorted(handles)))))
