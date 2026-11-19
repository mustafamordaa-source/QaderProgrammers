"""Who hears about what.

Routes call `notify(...)` inside their own transaction, so a notification
exists exactly when the change it describes was committed. Each row shows in
the person's notification list; when the person wants email for that kind,
the row is also queued (`email_state = "pending"`) for the batched sender in
`app.mailer`.

Nobody is told about their own action. Deactivated people and people who
cannot see the task are never notified. A bot hears only when someone tags
it (`@handle`) or asks it a question, never by email: its agent polls the
notification list and replies in that thread. A bot that works tasks
(`can_work`) also hears about its own work, still in the app only.

Several agents can share one bot, each with a token bound to its agent name
(`ApiToken.agent_name`). Each such agent gets its own row (`for_agent`), so
read state is per agent. Rows for a bot go to the agents that worked the task
(claimed it, handed it back), plus the plain row (`for_agent` NULL) that the
bot's unbound tokens read. When one agent of the bot acts, the bot's other
agents that worked the task hear about it; the actor never hears about itself.
"""

from __future__ import annotations

import re
from collections.abc import Iterable
from typing import TYPE_CHECKING

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import settings
from app.models import (
    DEFAULT_EMAIL_KINDS, ApiToken, CommentKind, EventType, Notification, NotifyKind, Task, TaskStatus, User, utcnow,
)

if TYPE_CHECKING:  # pragma: no cover
    from app.deps import Auth

# @handle, not inside an email address or a word.
MENTION_RE = re.compile(r"(?<![\w@.])@([a-z0-9][a-z0-9_-]{1,39})\b", re.IGNORECASE)
LEAD_ONLY_KINDS = {NotifyKind.review, NotifyKind.proposal}
# The only kinds a bot receives: the ones that ask it to reply.
BOT_KINDS = {NotifyKind.mention, NotifyKind.question}
# A bot that works tasks also hears about the work it holds.
WORKER_BOT_KINDS = BOT_KINDS | {
    NotifyKind.assigned, NotifyKind.answered, NotifyKind.rejected, NotifyKind.approved,
    NotifyKind.claim_idle, NotifyKind.claim_freed,
}
# Sent by the hub about a person's own claims; not a setting.
CLAIM_KINDS = {NotifyKind.claim_idle, NotifyKind.claim_freed}


def mentioned_handles(text: str | None) -> set[str]:
    return {m.lower() for m in MENTION_RE.findall(text or "")}


def wants_email(user: User, kind: NotifyKind) -> bool:
    if not user.email_notifications or not settings.email_enabled:
        return False
    if kind in CLAIM_KINDS:
        # About work the person holds: always sent while email is on.
        return True
    kinds = user.notify_kinds or list(DEFAULT_EMAIL_KINDS)
    return kind.value in kinds


def _excerpt(task: Task, text: str | None) -> str | None:
    """The text a notification keeps: the whole comment up to 2,000 characters.
    Email leaves it out on restricted tasks (see app.mailer)."""
    if not text:
        return None
    text = text.strip()
    return text[:1997] + "..." if len(text) > 2000 else text


def bound_agents(db: Session, user: User) -> set[str]:
    """Agent names on the bot's live tokens (tokens an admin issued for one agent)."""
    if not user.is_bot:
        return set()
    now = utcnow()
    rows = db.scalars(select(ApiToken.agent_name).where(
        ApiToken.user_id == user.id, ApiToken.agent_name.is_not(None),
        ApiToken.revoked_at.is_(None), ApiToken.expires_at > now,
    ))
    return {name for name in rows if name}


def worked_agents(task: Task, user: User) -> set[str]:
    """Agents of `user` that claimed, handed back or sent this task to review."""
    names = {
        e.agent_name for e in task.events
        if e.actor_id == user.id and e.agent_name and (
            e.event_type is EventType.claimed
            or (e.event_type is EventType.status_changed and e.to_status is TaskStatus.in_review)
        )
    }
    names |= {c.agent_name for c in task.comments
              if c.author_id == user.id and c.kind is CommentKind.handback and c.agent_name}
    if task.claimed_by == user.id and task.claim_agent:
        names.add(task.claim_agent)
    return names


def _targets(db: Session, auth: "Auth", user: User, task: Task, wanted: set[str | None] | None) -> list[str | None]:
    """Which rows `user` gets: None is the plain row, a name is one agent's row."""
    bound = bound_agents(db, user)
    if user.id == auth.user.id:
        # Only an agent with its own bound token tells its siblings; the actor never hears itself.
        if not auth.user.bound_agent:
            return []
        pool = (bound if wanted is not None else bound & worked_agents(task, user)) - {auth.agent}
        if wanted is not None:
            pool &= {w for w in wanted if w}
        return sorted(pool)
    if not bound:
        return [None]
    if wanted is not None:
        picked = sorted(w for w in wanted if w in bound)
        return picked or [None]
    return [None, *sorted(bound & worked_agents(task, user))]


def notify(
    db: Session,
    auth: "Auth",
    *,
    users: Iterable[User | None],
    task: Task,
    kind: NotifyKind,
    text: str | None = None,
    comment_id: int | None = None,
    agents: dict[int, set[str | None]] | None = None,
) -> list[Notification]:
    """`agents` narrows a bot recipient to some of its agents: {user_id: {"cs-agent-a"}}."""
    from app.routers.tasks import _can_see  # visibility rules live with the routes

    out: list[Notification] = []
    seen: set[int] = set()
    for user in users:
        if user is None or user.id in seen:
            continue
        seen.add(user.id)
        if not user.is_active:
            continue
        same = user.id == auth.user.id
        if same and not (user.is_bot and auth.user.bound_agent):
            continue
        bot_kinds = WORKER_BOT_KINDS if user.is_worker_bot else BOT_KINDS
        if user.is_bot and (kind not in bot_kinds or (auth.user.is_bot and not same)):
            continue
        if kind in LEAD_ONLY_KINDS and not user.is_lead:
            continue
        if not _can_see(task, user):
            continue
        for for_agent in _targets(db, auth, user, task, (agents or {}).get(user.id)):
            row = Notification(
                user_id=user.id,
                for_agent=for_agent,
                task_id=task.id,
                comment_id=comment_id,
                kind=kind,
                actor_id=auth.user.id,
                actor_kind=auth.kind,
                agent_name=auth.agent,
                text=_excerpt(task, text),
                created_at=utcnow(),
                email_state=("pending" if for_agent is None and not user.is_bot and wants_email(user, kind)
                             else "skipped"),
            )
            row.user = user
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
