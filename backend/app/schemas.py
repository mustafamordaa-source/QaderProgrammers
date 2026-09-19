"""Pydantic request/response models."""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator, model_validator

from app.models import EventType, Priority, Role, TaskStatus


class ORMModel(BaseModel):
    model_config = ConfigDict(from_attributes=True)


# --- auth -------------------------------------------------------------------


class LoginRequest(BaseModel):
    email: EmailStr
    password: str = Field(min_length=1)


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: "UserOut"


class UserOut(ORMModel):
    id: int
    name: str
    email: EmailStr
    role: Role
    created_at: datetime


# --- tasks ------------------------------------------------------------------


class TaskEventOut(ORMModel):
    id: int
    task_id: int
    actor_id: int
    actor: UserOut | None = None
    event_type: EventType
    from_status: TaskStatus | None
    to_status: TaskStatus | None
    comment: str | None
    timestamp: datetime


class TaskOut(ORMModel):
    id: int
    title: str
    description: str | None
    priority: Priority
    status: TaskStatus
    due_date: datetime | None
    created_by: int
    creator: UserOut | None = None
    assignee_1_id: int | None
    assignee_2_id: int | None
    assignee_1: UserOut | None = None
    assignee_2: UserOut | None = None
    created_at: datetime
    updated_at: datetime


class TaskDetailOut(TaskOut):
    events: list[TaskEventOut] = []


class _AssigneeValidatorMixin(BaseModel):
    @model_validator(mode="after")
    def _check_assignees(self):
        a1 = getattr(self, "assignee_1_id", None)
        a2 = getattr(self, "assignee_2_id", None)
        if a2 is not None and a1 is None:
            raise ValueError("assignee_2_id requires assignee_1_id to be set")
        if a1 is not None and a1 == a2:
            raise ValueError("A task cannot be assigned to the same person twice")
        return self


class TaskCreate(_AssigneeValidatorMixin):
    title: str = Field(min_length=1, max_length=200)
    description: str | None = Field(default=None, max_length=10_000)
    priority: Priority = Priority.medium
    due_date: datetime | None = None
    assignee_1_id: int | None = None
    assignee_2_id: int | None = None

    @field_validator("title")
    @classmethod
    def _strip_title(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("title must not be blank")
        return v


class TaskUpdate(BaseModel):
    """Leader-only edit of a task's descriptive fields."""

    title: str | None = Field(default=None, min_length=1, max_length=200)
    description: str | None = Field(default=None, max_length=10_000)
    priority: Priority | None = None
    due_date: datetime | None = None


class TaskAssign(_AssigneeValidatorMixin):
    assignee_1_id: int | None = None
    assignee_2_id: int | None = None


class StatusChangeRequest(BaseModel):
    status: TaskStatus
    comment: str | None = Field(default=None, max_length=2_000)


class RejectRequest(BaseModel):
    to_status: TaskStatus
    comment: str = Field(min_length=1, max_length=2_000)

    @field_validator("comment")
    @classmethod
    def _require_comment(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("A rejection comment is required")
        return v


# --- KPI --------------------------------------------------------------------


class SpeedKpi(BaseModel):
    avg_cycle_time_hours: float | None
    median_cycle_time_hours: float | None
    avg_time_in_status_hours: dict[str, float | None]


class QualityKpi(BaseModel):
    review_submissions: int
    rejections: int
    rejection_rate: float | None
    first_pass_rate: float | None


class VolumeKpi(BaseModel):
    completed_total: int
    completed_per_week: dict[str, int]
    completed_per_month: dict[str, int]
    open_by_status: dict[str, int]
    open_total: int


class OnTimeKpi(BaseModel):
    completed_with_due_date: int
    on_time: int
    on_time_rate: float | None


class KpiReport(BaseModel):
    scope: str
    user_id: int | None = None
    user_name: str | None = None
    range_start: datetime
    range_end: datetime
    speed: SpeedKpi
    quality: QualityKpi
    volume: VolumeKpi
    on_time: OnTimeKpi


class TeamKpiReport(KpiReport):
    programmers: list[KpiReport] = []


TokenResponse.model_rebuild()
