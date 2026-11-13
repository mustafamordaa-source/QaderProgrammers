"""ORM models: users, tasks, the append-only task_events audit log, and the
agent-hub tables (comments, acceptance criteria, git links, API tokens)."""

from __future__ import annotations

import enum
from datetime import datetime, timezone

from sqlalchemy import (
    DDL,
    JSON,
    Boolean,
    CheckConstraint,
    DateTime,
    Enum,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    event,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base


def utcnow() -> datetime:
    """Naive UTC timestamp. Everything in the DB is UTC; the client localises."""
    return datetime.now(timezone.utc).replace(tzinfo=None)


class Role(str, enum.Enum):
    leader = "leader"
    # Shown as "Member" in the UI. The stored value stays "programmer" so
    # existing rows need no data migration.
    programmer = "programmer"
    # Read-only account, for example for a manager who follows the board.
    viewer = "viewer"


class Side(str, enum.Enum):
    """Which part of the work a task (or a person) covers."""

    fe = "fe"
    be = "be"
    mobile = "mobile"
    content = "content"
    infra = "infra"
    qa = "qa"
    other = "other"


class ActorKind(str, enum.Enum):
    """Who made a change. The server sets it from the auth type, never from the
    request body: a browser login is a human, an API token is an agent, a
    webhook or timer is the system."""

    human = "human"
    agent = "agent"
    system = "system"


class Priority(str, enum.Enum):
    low = "low"
    medium = "medium"
    high = "high"
    urgent = "urgent"


# Difficulty is estimated on a Fibonacci scale. The widening gaps are the point:
# they remove the argument over whether something is a 6 or a 7, and force a
# genuinely large task into a bucket of its own instead of being squashed into
# the top of a linear scale. Distinct from `priority`, which is urgency.
POINT_VALUES: tuple[int, ...] = (1, 2, 3, 5, 8, 13)
DEFAULT_POINTS = 3


class TaskStatus(str, enum.Enum):
    # Filed by a machine (or a member's agent) and waiting for the leader.
    proposed = "proposed"
    backlog = "backlog"
    to_do = "to_do"
    in_progress = "in_progress"
    in_review = "in_review"
    blocked = "blocked"
    needs_confirm = "needs_confirm"
    done = "done"
    dropped = "dropped"
    # Legacy values. Old event rows carry them and the event log is
    # append-only, so they stay readable. No transition can enter them; the
    # 0002 migration moved every live task to `in_progress` plus `side`.
    in_progress_front = "in_progress_front"
    in_progress_back = "in_progress_back"


LEGACY_IN_PROGRESS: frozenset[TaskStatus] = frozenset(
    {TaskStatus.in_progress_front, TaskStatus.in_progress_back}
)
CLOSED_STATUSES: frozenset[TaskStatus] = frozenset({TaskStatus.done, TaskStatus.dropped})


def normalise_status(value: TaskStatus) -> TaskStatus:
    """Fold the legacy in-progress values into `in_progress`."""
    return TaskStatus.in_progress if value in LEGACY_IN_PROGRESS else value


class DeployState(str, enum.Enum):
    none = "none"
    staging = "staging"
    production = "production"


class CommentKind(str, enum.Enum):
    note = "note"
    question = "question"
    answer = "answer"
    decision = "decision"
    review = "review"
    handback = "handback"


class CriterionState(str, enum.Enum):
    open = "open"
    met = "met"
    dropped = "dropped"


class GitLinkKind(str, enum.Enum):
    branch = "branch"
    pr = "pr"
    commit = "commit"


class EventType(str, enum.Enum):
    created = "created"
    status_changed = "status_changed"
    rejected = "rejected"
    approved = "approved"
    closed = "closed"
    # Agent-hub events. The KPI layer reads only the five above.
    claimed = "claimed"
    released = "released"
    assigned = "assigned"
    field_changed = "field_changed"
    commented = "commented"
    question_asked = "question_asked"
    question_answered = "question_answered"
    criterion_added = "criterion_added"
    criterion_changed = "criterion_changed"
    git_linked = "git_linked"
    deployed = "deployed"
    dropped = "dropped"


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

    # Short name for questions and the CLI (`--to sara`). Unique when set.
    handle: Mapped[str | None] = mapped_column(String(40), nullable=True, unique=True)
    github_login: Mapped[str | None] = mapped_column(String(80), nullable=True)
    # Which sides this person works on, for example ["fe", "content"].
    sides: Mapped[list[str]] = mapped_column(JSON, default=list, nullable=False)
    # In-progress tasks before a claim warns. Warn-only for now.
    wip_limit: Mapped[int] = mapped_column(Integer, default=2, nullable=False)

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
    # How hard the task is, set by the leader. See POINT_VALUES.
    points: Mapped[int] = mapped_column(Integer, default=DEFAULT_POINTS, nullable=False)

    created_by: Mapped[int] = mapped_column(ForeignKey("users.id"), nullable=False)
    assignee_1_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True, index=True)
    assignee_2_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True, index=True)

    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, nullable=False, index=True)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=utcnow, onupdate=utcnow, nullable=False
    )

    # --- agent hub ---------------------------------------------------------
    side: Mapped[Side | None] = mapped_column(_str_enum(Side, "side"), nullable=True, index=True)
    tags: Mapped[list[str]] = mapped_column(JSON, default=list, nullable=False)
    # File areas the work touches, for example ["qader_backend/apps/learning"].
    areas: Mapped[list[str]] = mapped_column(JSON, default=list, nullable=False)
    # Rolling summary, rewritten by the claiming agent at each hand-back.
    summary: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Bumped on every change; writes may send expected_version.
    version: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    # Leader-only visibility.
    restricted: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    # Any member may claim a pool task, not only its assignees.
    pool: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    # Where blocked / needs_confirm return to.
    resume_status: Mapped[TaskStatus | None] = mapped_column(
        _str_enum(TaskStatus, "resume_status"), nullable=True
    )
    created_kind: Mapped[ActorKind] = mapped_column(
        _str_enum(ActorKind, "created_kind"), default=ActorKind.human, nullable=False
    )
    created_agent: Mapped[str | None] = mapped_column(String(80), nullable=True)

    claimed_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    claim_agent: Mapped[str | None] = mapped_column(String(80), nullable=True)
    claim_branch: Mapped[str | None] = mapped_column(String(200), nullable=True)
    claim_expires_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    deploy_state: Mapped[DeployState] = mapped_column(
        _str_enum(DeployState, "deploy_state"), default=DeployState.none, nullable=False
    )
    deploy_note: Mapped[str | None] = mapped_column(Text, nullable=True)
    deployed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    drop_reason: Mapped[str | None] = mapped_column(Text, nullable=True)

    creator: Mapped[User] = relationship(foreign_keys=[created_by], lazy="joined")
    assignee_1: Mapped[User | None] = relationship(foreign_keys=[assignee_1_id], lazy="joined")
    assignee_2: Mapped[User | None] = relationship(foreign_keys=[assignee_2_id], lazy="joined")
    claimer: Mapped[User | None] = relationship(foreign_keys=[claimed_by], lazy="joined")
    events: Mapped[list[TaskEvent]] = relationship(
        back_populates="task", order_by="TaskEvent.timestamp"
    )
    comments: Mapped[list[Comment]] = relationship(
        back_populates="task", order_by="Comment.id", cascade="all, delete-orphan"
    )
    criteria: Mapped[list[Criterion]] = relationship(
        back_populates="task", order_by="Criterion.n", cascade="all, delete-orphan"
    )
    git_links: Mapped[list[GitLink]] = relationship(
        back_populates="task", order_by="GitLink.id", cascade="all, delete-orphan"
    )

    __table_args__ = (
        # The same person must not occupy both assignee slots.
        CheckConstraint(
            "assignee_2_id IS NULL OR assignee_1_id IS NULL OR assignee_1_id != assignee_2_id",
            name="ck_tasks_distinct_assignees",
        ),
        CheckConstraint(
            "points IN (%s)" % ", ".join(str(value) for value in POINT_VALUES),
            name="ck_tasks_points_on_scale",
        ),
    )

    @property
    def assignee_ids(self) -> list[int]:
        return [uid for uid in (self.assignee_1_id, self.assignee_2_id) if uid is not None]

    def claim_is_live(self, now: datetime) -> bool:
        return (
            self.claimed_by is not None
            and self.claim_expires_at is not None
            and self.claim_expires_at > now
        )

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
    actor_kind: Mapped[ActorKind] = mapped_column(
        _str_enum(ActorKind, "actor_kind"), default=ActorKind.human, nullable=False
    )
    agent_name: Mapped[str | None] = mapped_column(String(80), nullable=True)
    token_id: Mapped[int | None] = mapped_column(ForeignKey("api_tokens.id"), nullable=True)
    # Old and new values for field changes, claim details, link details.
    data: Mapped[dict | None] = mapped_column(JSON, nullable=True)

    task: Mapped[Task] = relationship(back_populates="events")
    actor: Mapped[User] = relationship(lazy="joined")

    __table_args__ = (Index("ix_task_events_task_ts", "task_id", "timestamp"),)

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return f"<TaskEvent {self.id} task={self.task_id} {self.event_type.value}>"


# The log is append-only by rule; these triggers make SQLite enforce it. The
# 0002 migration creates the same triggers on an existing database.
APPEND_ONLY_TRIGGERS: tuple[str, ...] = (
    "CREATE TRIGGER IF NOT EXISTS task_events_no_update BEFORE UPDATE ON task_events "
    "BEGIN SELECT RAISE(ABORT, 'task_events is append-only'); END",
    "CREATE TRIGGER IF NOT EXISTS task_events_no_delete BEFORE DELETE ON task_events "
    "BEGIN SELECT RAISE(ABORT, 'task_events is append-only'); END",
)
for _sql in APPEND_ONLY_TRIGGERS:
    event.listen(TaskEvent.__table__, "after_create", DDL(_sql).execute_if(dialect="sqlite"))


class ApiToken(Base):
    """Personal API token for agents. Only a SHA-256 of the secret is stored."""

    __tablename__ = "api_tokens"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(80), nullable=False)
    prefix: Mapped[str] = mapped_column(String(16), nullable=False, unique=True)
    secret_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    scopes: Mapped[list[str]] = mapped_column(JSON, default=list, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    last_used_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    user: Mapped[User] = relationship(lazy="joined")


class Comment(Base):
    __tablename__ = "comments"

    id: Mapped[int] = mapped_column(primary_key=True)
    task_id: Mapped[int] = mapped_column(ForeignKey("tasks.id"), nullable=False, index=True)
    author_id: Mapped[int] = mapped_column(ForeignKey("users.id"), nullable=False)
    actor_kind: Mapped[ActorKind] = mapped_column(
        _str_enum(ActorKind, "comment_actor_kind"), default=ActorKind.human, nullable=False
    )
    agent_name: Mapped[str | None] = mapped_column(String(80), nullable=True)
    kind: Mapped[CommentKind] = mapped_column(
        _str_enum(CommentKind, "comment_kind"), default=CommentKind.note, nullable=False
    )
    body: Mapped[str] = mapped_column(Text, nullable=False)
    # One level of threading: replies point at a top-level comment.
    parent_id: Mapped[int | None] = mapped_column(ForeignKey("comments.id"), nullable=True)
    # A question is addressed to one person.
    to_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True, index=True)
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    resolved_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, nullable=False)

    task: Mapped[Task] = relationship(back_populates="comments")
    author: Mapped[User] = relationship(foreign_keys=[author_id], lazy="joined")
    to_user: Mapped[User | None] = relationship(foreign_keys=[to_user_id], lazy="joined")


class Criterion(Base):
    """One acceptance criterion: a numbered, checkable line of "done"."""

    __tablename__ = "task_criteria"

    id: Mapped[int] = mapped_column(primary_key=True)
    task_id: Mapped[int] = mapped_column(ForeignKey("tasks.id"), nullable=False, index=True)
    n: Mapped[int] = mapped_column(Integer, nullable=False)
    text: Mapped[str] = mapped_column(Text, nullable=False)
    state: Mapped[CriterionState] = mapped_column(
        _str_enum(CriterionState, "criterion_state"), default=CriterionState.open, nullable=False
    )
    evidence: Mapped[str | None] = mapped_column(Text, nullable=True)
    checked_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    checked_kind: Mapped[ActorKind | None] = mapped_column(
        _str_enum(ActorKind, "checked_kind"), nullable=True
    )
    checked_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, nullable=False)

    task: Mapped[Task] = relationship(back_populates="criteria")

    __table_args__ = (UniqueConstraint("task_id", "n", name="uq_task_criteria_n"),)


class GitLink(Base):
    __tablename__ = "git_links"

    id: Mapped[int] = mapped_column(primary_key=True)
    task_id: Mapped[int] = mapped_column(ForeignKey("tasks.id"), nullable=False, index=True)
    repo: Mapped[str] = mapped_column(String(200), nullable=False)
    kind: Mapped[GitLinkKind] = mapped_column(_str_enum(GitLinkKind, "git_link_kind"), nullable=False)
    # Branch name, PR number or full commit hash.
    ref: Mapped[str] = mapped_column(String(200), nullable=False)
    url: Mapped[str | None] = mapped_column(String(500), nullable=True)
    title: Mapped[str | None] = mapped_column(String(300), nullable=True)
    # open, merged, closed (PRs and branches).
    state: Mapped[str | None] = mapped_column(String(20), nullable=True)
    actor_kind: Mapped[ActorKind] = mapped_column(
        _str_enum(ActorKind, "git_actor_kind"), default=ActorKind.human, nullable=False
    )
    added_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, nullable=False)

    task: Mapped[Task] = relationship(back_populates="git_links")

    __table_args__ = (
        UniqueConstraint("task_id", "repo", "kind", "ref", name="uq_git_links_ref"),
    )
