"""Your notifications, your email settings, a test email, and (admins) the
sender's status."""

from __future__ import annotations

from datetime import timedelta

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy import func, select, update

from app import mailer, ratelimit
from app.config import settings
from app.deps import AuthCtx, CurrentUser, DbSession, require_admin, require_human
from app.models import DEFAULT_EMAIL_KINDS, ActorKind, Notification, NotifyKind, User, utcnow
from app.notify import LEAD_ONLY_KINDS

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
    text: str | None
    created_at: object
    read_at: object | None
    email_state: str


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
        text=n.text,
        created_at=n.created_at,
        read_at=n.read_at,
        email_state=n.email_state,
    )


@router.get("", response_model=list[NotificationOut])
def list_notifications(
    user: CurrentUser,
    db: DbSession,
    unread: bool = False,
    limit: int = Query(default=50, ge=1, le=200),
) -> list[NotificationOut]:
    stmt = select(Notification).where(Notification.user_id == user.id)
    if unread:
        stmt = stmt.where(Notification.read_at.is_(None))
    rows = db.scalars(stmt.order_by(Notification.id.desc()).limit(limit)).unique()
    return [_out(n) for n in rows]


@router.get("/count")
def unread_count(user: CurrentUser, db: DbSession) -> dict[str, int]:
    n = db.scalar(
        select(func.count(Notification.id)).where(
            Notification.user_id == user.id, Notification.read_at.is_(None)
        )
    )
    return {"unread": n or 0}


@router.post("/read")
def mark_read(payload: ReadRequest, user: CurrentUser, db: DbSession) -> dict[str, int]:
    stmt = update(Notification).where(
        Notification.user_id == user.id, Notification.read_at.is_(None)
    )
    if not payload.all:
        if not payload.ids:
            return {"marked": 0}
        stmt = stmt.where(Notification.id.in_(payload.ids))
    result = db.execute(stmt.values(read_at=utcnow()))
    db.commit()
    return {"marked": result.rowcount or 0}


def _available(user: User) -> list[NotifyKind]:
    return [k for k in NotifyKind if user.is_lead or k not in LEAD_ONLY_KINDS]


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
