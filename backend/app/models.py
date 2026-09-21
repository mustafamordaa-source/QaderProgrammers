"""ORM models: users, tasks and the append-only task_events audit log."""

from __future__ import annotations

import enum
from datetime import datetime, timezone

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    DateTime,
    Enum,
    ForeignKey,
    Index,
    String,
    Text,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base


def utcnow() -> datetime:
    """Naive UTC timestamp. Everything in the DB is UTC; the client localises."""
    return datetime.now(timezone.utc).replace(tzinfo=None)


class Role(str, enum.Enum):
    leader = "leader"
    programmer = "programmer"


class Priority(str, enum.Enum):
    low = "low"
    medium = "medium"
    high = "high"
    urgent = "urgent"


class TaskStatus(str, enum.Enum):
    to_do = "to_do"
    in_progress_front = "in_progress_front"
    in_progress_back = "in_progress_back"
    in_review = "in_review"
    done = "done"


class EventType(str, enum.Enum):
    created = "created"
    status_changed = "status_changed"
    rejected = "rejected"
    approved = "approved"
    closed = "closed"


# Store enums as their string values rather than the Python member names, so the
# SQLite rows stay readable and match the API payloads exactly.
def _str_enum(enum_cls: type[enum.Enum], name: str) -> Enum:
    return Enum(enum_cls, name=name, values_callable=lambda e: [m.value for m in e])


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    email: Mapped[str] = mapped_column(String(255), unique=True, nullable=False, index=True)
    password_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    role: Mapped[Role] = mapped_column(_str_enum(Role, "role"), nullable=False)
    # Accounts are deactivated, never deleted: tasks and every row in the
    # append-only event log reference users, so removing one would either fail
    # on the foreign key or destroy the history the KPIs are computed from.
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, nullable=False)

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return f"<User {self.id} {self.email} {self.role.value}>"


class Task(Base):
    __tablename__ = "tasks"

    id: Mapped[int] = mapped_column(primary_key=True)
    title: Mapped[str] = mapped_column(String(200), nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    priority: Mapped[Priority] = mapped_column(
        _str_enum(Priority, "priority"), default=Priority.medium, nullable=False
    )
    status: Mapped[TaskStatus] = mapped_column(
        _str_enum(TaskStatus, "task_status"), default=TaskStatus.to_do, nullable=False, index=True
    )
    due_date: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    created_by: Mapped[int] = mapped_column(ForeignKey("users.id"), nullable=False)
    assignee_1_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True, index=True)
    assignee_2_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True, index=True)

    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, nullable=False, index=True)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=utcnow, onupdate=utcnow, nullable=False
    )

    creator: Mapped[User] = relationship(foreign_keys=[created_by], lazy="joined")
    assignee_1: Mapped[User | None] = relationship(foreign_keys=[assignee_1_id], lazy="joined")
    assignee_2: Mapped[User | None] = relationship(foreign_keys=[assignee_2_id], lazy="joined")
    events: Mapped[list[TaskEvent]] = relationship(
        back_populates="task", cascade="all, delete-orphan", order_by="TaskEvent.timestamp"
    )

    # The same person must not occupy both assignee slots.
    __table_args__ = (
        CheckConstraint(
            "assignee_2_id IS NULL OR assignee_1_id IS NULL OR assignee_1_id != assignee_2_id",
            name="ck_tasks_distinct_assignees",
        ),
    )

    @property
    def assignee_ids(self) -> list[int]:
        return [uid for uid in (self.assignee_1_id, self.assignee_2_id) if uid is not None]

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return f"<Task {self.id} {self.status.value!r} {self.title!r}>"


class TaskEvent(Base):
    """Append-only audit log. Every KPI in the system is derived from these rows."""

    __tablename__ = "task_events"

    id: Mapped[int] = mapped_column(primary_key=True)
    task_id: Mapped[int] = mapped_column(ForeignKey("tasks.id"), nullable=False, index=True)
    actor_id: Mapped[int] = mapped_column(ForeignKey("users.id"), nullable=False, index=True)
    event_type: Mapped[EventType] = mapped_column(_str_enum(EventType, "event_type"), nullable=False)
    from_status: Mapped[TaskStatus | None] = mapped_column(
        _str_enum(TaskStatus, "from_status"), nullable=True
    )
    to_status: Mapped[TaskStatus | None] = mapped_column(
        _str_enum(TaskStatus, "to_status"), nullable=True
    )
    comment: Mapped[str | None] = mapped_column(Text, nullable=True)
    timestamp: Mapped[datetime] = mapped_column(DateTime, default=utcnow, nullable=False, index=True)

    task: Mapped[Task] = relationship(back_populates="events")
    actor: Mapped[User] = relationship(lazy="joined")

    __table_args__ = (Index("ix_task_events_task_ts", "task_id", "timestamp"),)

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return f"<TaskEvent {self.id} task={self.task_id} {self.event_type.value}>"
