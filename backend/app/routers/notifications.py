"""Your notifications, your email settings, a test email, and (admins) the
sender's status."""

from __future__ import annotations

from datetime import timedelta

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy import and_, func, select, update

from app import mailer, ratelimit
from app.config import settings
from app.deps import AuthCtx, CurrentUser, DbSession, require_admin, require_human
from app.models import DEFAULT_EMAIL_KINDS, ActorKind, Notification, NotifyKind, User, utcnow
from app.notify import CLAIM_KINDS, LEAD_ONLY_KINDS
from app.paging import Page, count_rows

router = APIRouter(prefix="/notifications", tags=["notifications"])


class NotificationOut(BaseModel):
    id: int
    task_id: int
    task_title: str
    task_status: str
    comment_id: int | None = None
    # For a question: still waiting for an answer?
    question_open: bool | None = None
    kind: NotifyKind
    actor: str | None
    actor_kind: ActorKind
    agent_name: str | None
    # Set on a row for one agent of a shared bot.
    for_agent: str | None = None
    text: str | None
    created_at: object
    read_at: object | None
    email_state: str
    # With ?expand=task,thread: everything needed to act without another call.
    task: dict | None = None
    thread: dict | None = None
    actions: list[dict] = []


class ReadRequest(BaseModel):
    ids: list[int] = Field(default_factory=list, max_length=500)
    all: bool = False


class Preferences(BaseModel):
    email_notifications: bool
    notify_kinds: list[NotifyKind]
    notify_address: EmailStr | None = None
    login_email: EmailStr | None = None
    available_kinds: list[NotifyKind] = []
    email_enabled_on_server: bool = False


class PreferencesUpdate(BaseModel):
    email_notifications: bool | None = None
    notify_kinds: list[NotifyKind] | None = None
    # Empty string clears it (emails then go to the login email).
    notify_address: EmailStr | str | None = None


def _own(user: User):
    """The caller's rows: a token bound to an agent reads that agent's rows only;
    a web login and an unbound token read the plain rows."""
    if user.bound_agent:
        return and_(Notification.user_id == user.id, Notification.for_agent == user.bound_agent)
    return and_(Notification.user_id == user.id, Notification.for_agent.is_(None))


def _question_open(n: Notification) -> bool | None:
    if n.kind is not NotifyKind.question or n.comment_id is None:
        return None
    comment = next((c for c in n.task.comments if c.id == n.comment_id), None)
    return comment is not None and comment.resolved_at is None


def _out(n: Notification) -> NotificationOut:
    return NotificationOut(
        id=n.id,
        task_id=n.task_id,
        task_title=n.task.title,
        task_status=n.task.status.value,
        comment_id=n.comment_id,
        question_open=_question_open(n),
        kind=n.kind,
        actor=(n.actor.handle or n.actor.name) if n.actor else None,
        actor_kind=n.actor_kind,
        agent_name=n.agent_name,
        for_agent=n.for_agent,
        text=n.text,
        created_at=n.created_at,
        read_at=n.read_at,
        email_state=n.email_state,
    )


@router.get("", response_model=list[NotificationOut])
def list_notifications(
    user: CurrentUser,
    db: DbSession,
    response: Response,
    paging: Page,
    unread: bool = False,
    limit: int = Query(default=50, ge=1, le=200, description="Used only when neither page nor page_size is sent"),
    expand: str | None = Query(default=None, max_length=40,
                               description="task, thread (comma list): add the task snapshot, the comment "
                                           "thread and suggested commands to each row"),
    order: str = Query(default="desc", pattern=r"^(asc|desc)$",
                       description="desc (default): newest first; asc: oldest first, so page 1 holds the oldest"),
) -> list[NotificationOut]:
    wanted = {x.strip() for x in (expand or "").split(",") if x.strip()}
    stmt = select(Notification).where(_own(user))
    if wanted:
        from sqlalchemy.orm import selectinload

        from app.models import Task

        stmt = stmt.options(
            selectinload(Notification.task).selectinload(Task.comments),
            selectinload(Notification.task).selectinload(Task.criteria),
            selectinload(Notification.task).selectinload(Task.incoming_links),
        )
    if unread:
        stmt = stmt.where(Notification.read_at.is_(None))
    by_id = Notification.id.asc() if order == "asc" else Notification.id.desc()
    if paging.on:
        paging.set_headers(response, count_rows(db, stmt))
        stmt = paging.window(stmt.order_by(by_id))
    else:
        stmt = stmt.order_by(by_id).limit(limit)
    from app.routers.tasks import _can_see

    rows = db.scalars(stmt).unique()
    out = []
    for n in rows:
        row = _out(n)
        if not _can_see(n.task, user):
            # Lost access since (unassigned, or the task became restricted): keep the row, not its content.
            row.text = None
            row.task_title = f"HUB-{n.task_id}"
        elif wanted:
            _expand(row, n, user, wanted)
        out.append(row)
    return out


def _snapshot(task, user) -> dict:
    from app.routers.tasks import _part_holder

    now = utcnow()
    claim = None
    if task.claim_is_live(now) and task.claimer:
        who = task.claimer.handle or task.claimer.name
        if task.claim_agent:
            who = f"{who}/{task.claim_agent}"
        claim = f"{who} until {task.claim_expires_at:%Y-%m-%d %H:%M}Z"
    taken = sum(1 for c in task.criteria if _part_holder(c) is not None)
    return {
        "id": task.id,
        "key": f"HUB-{task.id}",
        "title": task.title,
        "status": task.status.value,
        "priority": task.priority.value,
        "kind": task.kind.value,
        "side": task.side.value if task.side else None,
        "area": task.area.slug if task.area else None,
        "audience": task.audience,
        "requested_by": task.requested_by,
        "restricted": task.restricted,
        "assign_only": task.assign_only,
        "claim": claim,
        "assignees": [u.handle or u.name for u in (task.assignee_1, task.assignee_2) if u],
        "parts": f"{taken}/{len(task.criteria)} taken",
        "open_questions": sum(1 for c in task.comments if c.kind.value == "question" and c.resolved_at is None),
        "blocked_by": task.open_blockers(),
    }


def _cut(text: str | None, n: int) -> str | None:
    if text is None:
        return None
    return text if len(text) <= n else text[: n - 3] + "..."


def _expand(row: NotificationOut, n: Notification, user: User, wanted: set[str]) -> None:
    task = n.task
    key = f"HUB-{task.id}"
    if "task" in wanted:
        row.task = _snapshot(task, user)
    comment = next((c for c in task.comments if c.id == n.comment_id), None) if n.comment_id else None
    if "thread" in wanted and comment is not None:
        parent = next((c for c in task.comments if c.id == comment.parent_id), None) if comment.parent_id else None
        row.thread = {
            "comment": {
                "id": comment.id,
                "kind": comment.kind.value,
                "author": comment.author.handle or comment.author.name,
                "author_kind": comment.actor_kind.value,
                "agent_name": comment.agent_name,
                "body": _cut(comment.body, 4000),
                "created_at": comment.created_at,
                "resolved": comment.resolved_at is not None,
            },
            "replies_to": {
                "id": parent.id,
                "author": parent.author.handle or parent.author.name,
                "body": _cut(parent.body, 1000),
            } if parent else None,
        }
    actions = []
    if n.kind is NotifyKind.question and comment is not None and comment.resolved_at is None:
        actions.append({"label": "Answer", "command": f"qhub answer {task.id} {comment.id} --body-file reply.md"})
    elif comment is not None:
        actions.append({"label": "Reply", "command": f"qhub comment {task.id} --reply-to {comment.id} --body-file reply.md"})
    if n.kind in (NotifyKind.assigned, NotifyKind.claim_freed) and task.status.value in ("backlog", "to_do"):
        actions.append({"label": "Claim", "command": f"qhub claim {key}"})
    if n.kind is NotifyKind.claim_idle:
        actions.append({"label": "Post progress", "command": f'qhub comment {task.id} "progress: ..."'})
        actions.append({"label": "Release", "command": f"qhub release {key}"})
    if n.kind is NotifyKind.review:
        actions.append({"label": "Review", "command": f"qhub show {key} --full"})
    actions.append({"label": "Open", "command": f"qhub show {key}"})
    actions.append({"label": "Mark read", "command": f"qhub notifications read {n.id}"})
    row.actions = actions


@router.get("/count")
def unread_count(user: CurrentUser, db: DbSession) -> dict[str, int]:
    n = db.scalar(
        select(func.count(Notification.id)).where(_own(user), Notification.read_at.is_(None))
    )
    return {"unread": n or 0}


@router.post("/read")
def mark_read(payload: ReadRequest, user: CurrentUser, db: DbSession) -> dict[str, int]:
    stmt = update(Notification).where(_own(user), Notification.read_at.is_(None))
    if not payload.all:
        if not payload.ids:
            return {"marked": 0}
        stmt = stmt.where(Notification.id.in_(payload.ids))
    result = db.execute(stmt.values(read_at=utcnow()))
    db.commit()
    return {"marked": result.rowcount or 0}


def _available(user: User) -> list[NotifyKind]:
    return [k for k in NotifyKind if (user.is_lead or k not in LEAD_ONLY_KINDS) and k not in CLAIM_KINDS]


def _prefs(user: User) -> Preferences:
    return Preferences(
        email_notifications=user.email_notifications,
        notify_kinds=[NotifyKind(k) for k in (user.notify_kinds or DEFAULT_EMAIL_KINDS)],
        notify_address=user.notify_address,
        login_email=user.email,
        available_kinds=_available(user),
        email_enabled_on_server=settings.email_enabled,
    )


@router.get("/preferences", response_model=Preferences)
def get_preferences(user: CurrentUser) -> Preferences:
    return _prefs(user)


@router.patch("/preferences", response_model=Preferences)
def set_preferences(
    payload: PreferencesUpdate,
    db: DbSession,
    auth=Depends(require_human),
) -> Preferences:
    """Change your own email settings. Browser login only."""
    user = auth.user
    if payload.email_notifications is not None:
        user.email_notifications = payload.email_notifications
    if payload.notify_kinds is not None:
        user.notify_kinds = sorted({k.value for k in payload.notify_kinds})
    if payload.notify_address is not None:
        address = str(payload.notify_address).strip().lower()
        if address and "@" not in address:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="notify_address: not an email")
        user.notify_address = address or None
    db.commit()
    db.refresh(user)
    return _prefs(user)


@router.post("/test")
def send_test(db: DbSession, auth=Depends(require_human)) -> dict[str, str]:
    """Send yourself a test email now, to check the address and the server's
    SMTP settings. Three per hour."""
    if not settings.email_enabled:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Email is not set up on the server")
    ratelimit.hit(f"test-email:{auth.user.id}", 3, window_seconds=3600)
    to = auth.user.notify_address or auth.user.email
    try:
        mailer.send_message(
            to,
            "[Team hub] Test email",
            f"Hi {auth.user.name},\n\nEmail notifications from the team hub reach this address.\n\n"
            f"{settings.hub_base_url.rstrip('/')}/settings\n",
        )
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"The mail server refused it: {type(exc).__name__}",
        ) from None
    return {"sent_to": to}


@router.get("/status")
def sender_status(db: DbSession, admin: User = Depends(require_admin)) -> dict:
    """Is email on, and how is it going. Never shows the password."""
    def count(state: str) -> int:
        return db.scalar(select(func.count(Notification.id)).where(Notification.email_state == state)) or 0

    since = utcnow() - timedelta(days=1)
    return {
        "email_enabled": settings.email_enabled,
        "sender_running": mailer.sender._thread is not None and mailer.sender._thread.is_alive(),
        "smtp_host": settings.smtp_host or None,
        "from": settings.smtp_from or None,
        "pending": count("pending"),
        "failed": count("failed"),
        "sent_last_24h": db.scalar(
            select(func.count(Notification.id)).where(
                Notification.email_state == "sent", Notification.emailed_at >= since
            )
        ) or 0,
        "daily_cap": settings.email_max_per_day,
        "last_error": mailer.last_error,
    }
