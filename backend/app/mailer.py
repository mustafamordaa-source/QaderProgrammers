"""Batched email sender for notifications.

A background thread in the API process (there is one uvicorn worker) wakes
every `email_poll_seconds`. For each person whose oldest pending
notification is older than `email_batch_seconds`, it sends one email listing
everything pending for them, then marks those rows sent. Failures are
retried on later rounds up to `email_max_attempts`. Per-person and daily caps
keep the hub inside Gmail's sending limits; rows over a cap wait for the
next round.

The SMTP password comes from the server env file only.
"""

from __future__ import annotations

import logging
import smtplib
import ssl
import threading
from collections import defaultdict
from datetime import timedelta
from email.message import EmailMessage
from email.utils import formataddr, make_msgid

from sqlalchemy import func, select

from app.config import settings
from app.database import SessionLocal
from app.models import Notification, NotifyKind, User, utcnow

log = logging.getLogger("taskflow.mailer")

KIND_TEXT: dict[NotifyKind, str] = {
    NotifyKind.assigned: "assigned you",
    NotifyKind.question: "asked you a question",
    NotifyKind.answered: "answered your question",
    NotifyKind.mention: "mentioned you",
    NotifyKind.review: "sent work for review",
    NotifyKind.rejected: "sent your work back",
    NotifyKind.approved: "approved your work",
    NotifyKind.proposal: "proposed a task",
    NotifyKind.claim_idle: "reminds you about an idle claim",
    NotifyKind.claim_freed: "freed an idle claim",
}

last_error: str | None = None


def send_message(to: str, subject: str, body: str, html: str | None = None) -> None:
    """Send one email: plain text, plus an HTML part when given. Raises on any SMTP problem."""
    msg = EmailMessage()
    msg["From"] = formataddr((settings.smtp_from_name, settings.smtp_from))
    msg["To"] = to
    msg["Subject"] = subject
    msg["Message-ID"] = make_msgid(domain=settings.smtp_from.split("@")[-1] or None)
    msg.set_content(body)
    if html:
        msg.add_alternative(html, subtype="html")
    with smtplib.SMTP(settings.smtp_host, settings.smtp_port, timeout=settings.smtp_timeout_seconds) as smtp:
        if settings.smtp_starttls:
            smtp.starttls(context=ssl.create_default_context())
        if settings.smtp_user:
            smtp.login(settings.smtp_user, settings.smtp_password)
        smtp.send_message(msg)


def _who(n: Notification) -> str:
    if n.actor is None:
        return "The hub"
    name = n.actor.name
    return f"{name} (agent {n.agent_name})" if n.agent_name else name


def _status_line(task) -> str:
    bits = [task.status.value.replace("_", " "), task.priority.value]
    if task.side:
        bits.append(task.side.value)
    if task.area:
        bits.append(task.area.slug)
    if task.audience:
        bits.append(f"for {task.audience}")
    return " · ".join(bits)


def _replies_to(n: Notification) -> str | None:
    """'@sara: first words…' for the comment this one answers, if any."""
    if not n.comment_id:
        return None
    comment = next((c for c in n.task.comments if c.id == n.comment_id), None)
    if comment is None or not comment.parent_id:
        return None
    parent = next((c for c in n.task.comments if c.id == comment.parent_id), None)
    if parent is None:
        return None
    body = " ".join(parent.body.split())
    return f"@{parent.author.handle or parent.author.name}: {body[:197] + '...' if len(body) > 200 else body}"


def _kind_text(n: Notification) -> str:
    return KIND_TEXT.get(n.kind, n.kind.value.replace("_", " "))


def compose(user: User, rows: list[Notification]) -> tuple[str, str]:
    """Subject and plain-text body (see compose_html for the HTML part)."""
    base = settings.hub_base_url.rstrip("/")
    if len(rows) == 1:
        n = rows[0]
        title = "" if n.task.restricted else f" {n.task.title}"
        subject = f"[Team hub] {_who(n)} {_kind_text(n)}: HUB-{n.task_id}{title}"[:180]
    else:
        subject = f"[Team hub] {len(rows)} updates for you"
    lines = [f"Hi {user.name},", ""]
    for n in rows:
        task = n.task
        if task.restricted:
            lines.append(f"- {_who(n)} {_kind_text(n)} on HUB-{task.id}")
            lines.append("  (Restricted task: open it in the hub to read the details.)")
        else:
            lines.append(f"- {_who(n)} {_kind_text(n)} on HUB-{task.id}: {task.title}")
            lines.append(f"  {_status_line(task)}")
            reply = _replies_to(n)
            if reply:
                lines.append(f"  In reply to {reply}")
            if n.text:
                lines += ["  > " + line for line in n.text.splitlines() or [""]]
        lines.append(f"  {base}/t/{task.id}")
        lines.append("")
    lines += [
        "Change which emails you get on the Settings page:",
        f"{base}/settings",
    ]
    return subject, "\n".join(lines)


def compose_html(user: User, rows: list[Notification]) -> str:
    """The HTML part: the same content as `compose`, escaped, with a button per task."""
    from html import escape

    base = settings.hub_base_url.rstrip("/")
    parts = [f'<div style="font-family:Arial,sans-serif;font-size:14px;color:#1f2937;max-width:640px">',
             f"<p>Hi {escape(user.name)},</p>"]
    for n in rows:
        task = n.task
        parts.append('<div style="border:1px solid #e5e7eb;border-radius:8px;padding:12px;margin:12px 0">')
        title = "" if task.restricted else f': <span dir="auto">{escape(task.title)}</span>'
        parts.append(f"<p style=\"margin:0 0 4px\"><b>{escape(_who(n))}</b> {escape(_kind_text(n))} on "
                     f"<b>HUB-{task.id}</b>{title}</p>")
        if not task.restricted:
            parts.append(f'<p style="margin:0 0 8px;color:#6b7280;font-size:12px">{escape(_status_line(task))}</p>')
        if task.restricted:
            parts.append('<p style="margin:0 0 8px;color:#6b7280">Restricted task: open it in the hub to read the details.</p>')
        else:
            reply = _replies_to(n)
            if reply:
                parts.append(f'<p style="margin:0 0 6px;color:#6b7280;font-size:12px" dir="auto">In reply to {escape(reply)}</p>')
            if n.text:
                parts.append('<blockquote dir="auto" style="margin:0 0 8px;padding:6px 10px;border-left:3px solid #d1d5db;'
                             f'white-space:pre-wrap">{escape(n.text)}</blockquote>')
        parts.append(f'<a href="{escape(base)}/t/{task.id}" style="display:inline-block;padding:6px 12px;'
                     'background:#2563eb;color:#fff;border-radius:6px;text-decoration:none">Open the task</a>')
        parts.append("</div>")
    parts.append(f'<p style="color:#6b7280;font-size:12px">Change which emails you get on the '
                 f'<a href="{escape(base)}/settings">Settings page</a>.</p></div>')
    return "".join(parts)


def _sent_since(db, since, user_id: int | None = None) -> int:
    stmt = select(func.count(Notification.id)).where(
        Notification.email_state == "sent", Notification.emailed_at >= since
    )
    if user_id is not None:
        stmt = stmt.where(Notification.user_id == user_id)
    return db.scalar(stmt) or 0


def run_once(now=None, session_factory=None) -> int:
    """One sending round. Returns the number of emails sent."""
    global last_error
    if not settings.email_enabled:
        return 0
    now = now or utcnow()
    db = (session_factory or SessionLocal)()
    sent = 0
    try:
        pending = list(
            db.scalars(
                select(Notification)
                .where(Notification.email_state == "pending")
                .order_by(Notification.created_at)
            )
        )
        by_user: dict[int, list[Notification]] = defaultdict(list)
        for n in pending:
            by_user[n.user_id].append(n)

        day_left = settings.email_max_per_day - _sent_since(db, now - timedelta(days=1))
        for user_id, rows in by_user.items():
            if day_left <= 0:
                break
            if rows[0].created_at > now - timedelta(seconds=settings.email_batch_seconds):
                continue  # still collecting a batch
            user = rows[0].user
            if not user.is_active or not user.email_notifications or user.is_bot:
                for n in rows:
                    n.email_state = "skipped"
                continue
            if _sent_since(db, now - timedelta(hours=1), user.id) >= settings.email_max_per_user_hour:
                continue
            from app.routers.tasks import _can_see

            hidden = [n for n in rows if not _can_see(n.task, user)]
            for n in hidden:
                n.email_state = "skipped"
            rows = [n for n in rows if n not in hidden][:25]
            if not rows:
                continue
            subject, body = compose(user, rows)
            try:
                send_message(user.notify_address or user.email, subject, body, compose_html(user, rows))
            except Exception as exc:  # noqa: BLE001 - any SMTP failure is retried
                last_error = f"{type(exc).__name__}: {exc}"[:300]
                log.warning("email to user %s failed: %s", user.id, last_error)
                for n in rows:
                    n.email_attempts += 1
                    n.email_error = last_error
                    if n.email_attempts >= settings.email_max_attempts:
                        n.email_state = "failed"
                continue
            for n in rows:
                n.email_state = "sent"
                n.emailed_at = now
                n.email_error = None
            sent += 1
            day_left -= len(rows)
        db.commit()
    finally:
        db.close()
    return sent


class Sender:
    """The background thread. Started and stopped with the app."""

    def __init__(self) -> None:
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def start(self) -> bool:
        if settings.email_sender == "off" or not settings.email_enabled:
            return False
        self._thread = threading.Thread(target=self._loop, name="email-sender", daemon=True)
        self._thread.start()
        log.info("email sender started")
        return True

    def stop(self) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=5)

    def _loop(self) -> None:
        while not self._stop.wait(settings.email_poll_seconds):
            try:
                run_once()
            except Exception:  # noqa: BLE001 - keep the loop alive
                log.exception("email round failed")


sender = Sender()
