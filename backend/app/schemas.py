"""Pydantic request/response models."""

from __future__ import annotations

import re
from datetime import datetime

from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator, model_validator

from app.models import (
    DEFAULT_POINTS,
    POINT_VALUES,
    ActorKind,
    CommentKind,
    CriterionState,
    DeployState,
    EventType,
    GitLinkKind,
    AccessRole,
    AccountType,
    DocKind,
    LinkKind,
    Priority,
    TaskKind,
    Role,
    Side,
    TaskStatus,
)


class ORMModel(BaseModel):
    model_config = ConfigDict(from_attributes=True)


HANDLE_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{1,39}$")
TAG_RE = re.compile(r"^[\w:./-]{1,60}$", re.UNICODE)


def _clean_list(values: list[str] | None, *, pattern: re.Pattern[str], what: str, limit: int) -> list[str] | None:
    if values is None:
        return None
    out: list[str] = []
    for raw in values:
        v = raw.strip()
        if not v:
            continue
        if not pattern.match(v):
            raise ValueError(f"invalid {what}: {v!r}")
        if v not in out:
            out.append(v)
    if len(out) > limit:
        raise ValueError(f"at most {limit} {what}s")
    return out


def _check_handle(v: str | None) -> str | None:
    if v is None:
        return None
    v = v.strip().lower()
    if not v:
        return None
    if not HANDLE_RE.match(v):
        raise ValueError("handle: 2 to 40 characters, lowercase letters, digits, '-' or '_'")
    return v


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
    # Older single-role view, kept in step with `roles`.
    role: Role
    roles: list[AccessRole] = Field(default_factory=list, validation_alias="effective_roles")
    account_type: AccountType = AccountType.person
    is_active: bool
    created_at: datetime
    handle: str | None = None
    sides: list[Side] = []
    email_notifications: bool = True


class UserBrief(ORMModel):
    """The few fields shown next to a comment or a claim."""

    id: int
    name: str
    handle: str | None = None


# --- user management (leader only) ------------------------------------------

MIN_PASSWORD_LENGTH = 8


class UserAdminOut(UserOut):
    """A user row for the management screen, with the context the leader needs
    before deactivating somebody."""

    github_login: str | None = None
    wip_limit: int = 2
    open_task_count: int = 0


class _ProfileFields(BaseModel):
    handle: str | None = None
    github_login: str | None = Field(default=None, max_length=80)
    sides: list[Side] | None = None
    wip_limit: int | None = Field(default=None, ge=1, le=10)

    _check_handle = field_validator("handle")(staticmethod(_check_handle))


class UserCreate(_ProfileFields):
    name: str = Field(min_length=1, max_length=120)
    email: EmailStr
    # Required for a person; a bot gets a random one it never uses.
    password: str | None = Field(default=None, min_length=MIN_PASSWORD_LENGTH, max_length=128)
    roles: list[AccessRole] | None = None
    # Older clients send one role; `roles` wins when both are present.
    role: Role | None = None
    account_type: AccountType = AccountType.person

    @field_validator("name")
    @classmethod
    def _strip_name(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("name must not be blank")
        return v


class UserUpdate(_ProfileFields):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    email: EmailStr | None = None
    roles: list[AccessRole] | None = None
    role: Role | None = None
    is_active: bool | None = None

    @field_validator("name")
    @classmethod
    def _strip_name(cls, v: str | None) -> str | None:
        if v is None:
            return v
        v = v.strip()
        if not v:
            raise ValueError("name must not be blank")
        return v


class PasswordReset(BaseModel):
    password: str = Field(min_length=MIN_PASSWORD_LENGTH, max_length=128)


# --- API tokens -------------------------------------------------------------


class ApiTokenCreate(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    scopes: list[str] | None = None
    expires_days: int = Field(default=30, ge=1)


class ApiTokenOut(ORMModel):
    id: int
    name: str
    prefix: str
    scopes: list[str]
    created_at: datetime
    expires_at: datetime
    last_used_at: datetime | None
    revoked_at: datetime | None


class ApiTokenCreated(ApiTokenOut):
    # Shown once. Only a hash is stored.
    token: str


# --- tasks ------------------------------------------------------------------


def _validate_points(value: int | None) -> int | None:
    if value is not None and value not in POINT_VALUES:
        allowed = ", ".join(str(v) for v in POINT_VALUES)
        raise ValueError(f"points must be one of: {allowed}")
    return value


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
    actor_kind: ActorKind = ActorKind.human
    agent_name: str | None = None
    data: dict | None = None


class CommentOut(ORMModel):
    id: int
    task_id: int
    author: UserBrief
    actor_kind: ActorKind
    agent_name: str | None
    kind: CommentKind
    body: str
    parent_id: int | None
    to_user: UserBrief | None = None
    resolved_at: datetime | None
    created_at: datetime
    # Filled on create only: handles the hub notified.
    notified: list[str] = []


class CriterionOut(ORMModel):
    id: int
    n: int
    text: str
    state: CriterionState
    evidence: str | None
    checked_by: int | None
    checked_kind: ActorKind | None
    checked_at: datetime | None


class GitLinkOut(ORMModel):
    id: int
    repo: str
    kind: GitLinkKind
    ref: str
    url: str | None
    title: str | None
    state: str | None
    base_ref: str | None = None
    merged_at: datetime | None = None
    actor_kind: ActorKind
    created_at: datetime
    updated_at: datetime


class TaskRef(ORMModel):
    id: int
    title: str
    status: TaskStatus
    kind: TaskKind = TaskKind.task
    # Who is on it: filled for subtasks so the parent shows the roster.
    side: Side | None = None
    assignees: list[str] = []
    claim_holder: str | None = None
    pool: bool = False


class SplitPart(BaseModel):
    side: Side
    title: str | None = Field(default=None, max_length=200)
    assignee_id: int | None = None
    points: int | None = None
    description: str | None = Field(default=None, max_length=20_000)
    criteria: list[str] = Field(default_factory=list, max_length=30)

    _check_points = field_validator("points")(staticmethod(lambda v: _validate_points(v)))


class SplitOrder(BaseModel):
    # The part on side `before` blocks the part on side `after`.
    before: Side
    after: Side


class SplitRequest(BaseModel):
    parts: list[SplitPart] = Field(min_length=1, max_length=8)
    order: list[SplitOrder] = Field(default_factory=list, max_length=8)

    @model_validator(mode="after")
    def _one_part_per_side(self):
        sides = [p.side for p in self.parts]
        if len(sides) != len(set(sides)):
            raise ValueError("one part per side")
        for o in self.order:
            if o.before not in sides or o.after not in sides or o.before == o.after:
                raise ValueError("order: both sides must be parts, and different")
        return self


class TaskLinkOut(BaseModel):
    id: int
    kind: LinkKind
    # "outgoing": this task -> other; "incoming": other -> this task.
    direction: str
    # Reads as a sentence: "this task blocks #12", "#9 blocks this task".
    label: str
    other: TaskRef
    created_at: datetime


class TaskLinkCreate(BaseModel):
    kind: LinkKind
    to_task_id: int


class TemplateOut(BaseModel):
    kind: TaskKind
    label: str
    skeleton: str
    required: list[str]
    criteria: list[str]


class TaskOut(ORMModel):
    id: int
    title: str
    description: str | None
    priority: Priority
    points: int
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

    side: Side | None = None
    tags: list[str] = []
    areas: list[str] = []
    summary: str | None = None
    version: int = 1
    restricted: bool = False
    pool: bool = False
    resume_status: TaskStatus | None = None
    created_kind: ActorKind = ActorKind.human
    created_agent: str | None = None
    claimed_by: int | None = None
    claimer: UserBrief | None = None
    claim_agent: str | None = None
    claim_branch: str | None = None
    claim_expires_at: datetime | None = None
    deploy_state: DeployState = DeployState.none
    deploy_note: str | None = None
    deployed_at: datetime | None = None
    drop_reason: str | None = None
    kind: TaskKind = TaskKind.task
    parent_id: int | None = None
    fingerprint: str | None = None
    # Filled by the router.
    criteria_total: int = 0
    criteria_open: int = 0
    open_questions: int = 0
    blocked_by: list[int] = []
    children_total: int = 0
    children_open: int = 0


class TaskDetailOut(TaskOut):
    events: list[TaskEventOut] = []
    comments: list[CommentOut] = []
    criteria: list[CriterionOut] = []
    git_links: list[GitLinkOut] = []
    docs: list["DocMeta"] = []
    files: list["FileOut"] = []
    context: list["ContextOut"] = []
    parent: "TaskRef | None" = None
    children: list["TaskRef"] = []
    links: list["TaskLinkOut"] = []
    # Set when a create matched an open task by fingerprint.
    duplicate_of_existing: bool = False


class ClaimOut(TaskOut):
    warnings: list[str] = []


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


class _TaskHubFields(BaseModel):
    side: Side | None = None
    tags: list[str] | None = None
    areas: list[str] | None = None
    summary: str | None = Field(default=None, max_length=4_000)
    restricted: bool | None = None
    pool: bool | None = None

    @field_validator("tags")
    @classmethod
    def _tags(cls, v):
        return _clean_list(v, pattern=TAG_RE, what="tag", limit=12)

    @field_validator("areas")
    @classmethod
    def _areas(cls, v):
        return _clean_list(v, pattern=re.compile(r"^[\w./-]{1,200}$"), what="area", limit=12)


CREATE_STATUSES = {TaskStatus.proposed, TaskStatus.backlog, TaskStatus.to_do}


class TaskCreate(_TaskHubFields, _AssigneeValidatorMixin):
    title: str = Field(min_length=1, max_length=200)
    description: str | None = Field(default=None, max_length=20_000)
    priority: Priority = Priority.medium
    points: int = DEFAULT_POINTS
    due_date: datetime | None = None
    assignee_1_id: int | None = None
    assignee_2_id: int | None = None
    # Leaders choose; members always create into backlog.
    status: TaskStatus = TaskStatus.to_do
    # Acceptance criteria, one line each. Empty: the kind's template criteria.
    criteria: list[str] = Field(default_factory=list, max_length=30)
    kind: TaskKind = TaskKind.task
    use_template: bool = True
    parent_id: int | None = None
    fingerprint: str | None = Field(default=None, max_length=200, pattern=r"^[\w:./@#-]{3,200}$")

    _check_points = field_validator("points")(staticmethod(_validate_points))

    @field_validator("title")
    @classmethod
    def _strip_title(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("title must not be blank")
        return v

    @field_validator("status")
    @classmethod
    def _create_status(cls, v: TaskStatus) -> TaskStatus:
        if v not in CREATE_STATUSES:
            raise ValueError("a new task starts in proposed, backlog or to_do")
        return v

    @field_validator("criteria")
    @classmethod
    def _criteria(cls, v: list[str]) -> list[str]:
        out = [c.strip() for c in v if c and c.strip()]
        for c in out:
            if len(c) > 1_000:
                raise ValueError("a criterion is at most 1,000 characters")
        return out


class TaskUpdate(_TaskHubFields):
    """Edit a task's fields. Leaders edit everything; assignees edit summary,
    tags and areas of their own tasks."""

    title: str | None = Field(default=None, min_length=1, max_length=200)
    description: str | None = Field(default=None, max_length=20_000)
    priority: Priority | None = None
    points: int | None = None
    due_date: datetime | None = None
    kind: TaskKind | None = None
    # 0 clears it.
    parent_id: int | None = None
    expected_version: int | None = None

    _check_points = field_validator("points")(staticmethod(_validate_points))


class TaskAssign(_AssigneeValidatorMixin):
    assignee_1_id: int | None = None
    assignee_2_id: int | None = None


class StatusChangeRequest(BaseModel):
    status: TaskStatus
    comment: str | None = Field(default=None, max_length=2_000)
    expected_version: int | None = None


class RejectRequest(BaseModel):
    to_status: TaskStatus = TaskStatus.in_progress
    comment: str = Field(min_length=1, max_length=2_000)

    @field_validator("comment")
    @classmethod
    def _require_comment(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("A rejection comment is required")
        return v


class ClaimRequest(BaseModel):
    branch: str | None = Field(default=None, max_length=200)
    ttl_hours: float | None = Field(default=None, gt=0)
    # A browser user claiming for themselves may name the agent here; with an
    # API token the X-Agent header wins.
    agent: str | None = Field(default=None, max_length=80)


class CommentCreate(BaseModel):
    kind: CommentKind = CommentKind.note
    body: str = Field(min_length=1, max_length=20_000)
    parent_id: int | None = None
    # For questions: the person asked, by handle or user id.
    to: str | None = Field(default=None, max_length=40)
    # A question that blocks work moves the task to needs_confirm.
    wait: bool = False


class CriterionCreate(BaseModel):
    text: str = Field(min_length=1, max_length=1_000)


class CriterionUpdate(BaseModel):
    state: CriterionState | None = None
    evidence: str | None = Field(default=None, max_length=4_000)
    text: str | None = Field(default=None, min_length=1, max_length=1_000)


class GitLinkCreate(BaseModel):
    repo: str = Field(min_length=3, max_length=200, pattern=r"^[\w.-]+/[\w.-]+$")
    kind: GitLinkKind
    ref: str = Field(min_length=1, max_length=200)
    url: str | None = Field(default=None, max_length=500, pattern=r"^https://")
    title: str | None = Field(default=None, max_length=300)
    state: str | None = Field(default=None, pattern=r"^(open|merged|closed)$")

    @model_validator(mode="after")
    def _check_ref(self):
        if self.kind is GitLinkKind.commit and not re.fullmatch(r"[0-9a-f]{7,40}", self.ref):
            raise ValueError("a commit ref is a hex hash (7 to 40 characters)")
        if self.kind is GitLinkKind.pr and not self.ref.isdigit():
            raise ValueError("a PR ref is its number")
        return self


class DeployUpdate(BaseModel):
    state: DeployState
    note: str | None = Field(default=None, max_length=2_000)


class TaskBrief(BaseModel):
    """What an agent needs before it works on a task, capped near 2 KB."""

    id: int
    title: str
    status: TaskStatus
    side: Side | None
    priority: Priority
    points: int
    version: int
    tags: list[str]
    areas: list[str]
    assignees: list[str]
    claim: str | None
    summary: str | None
    description: str | None
    criteria: list[str]
    open_questions: list[str]
    last_handback: str | None
    git: list[str]
    deploy: str
    docs: list[str] = []
    context: list[str] = []
    files: list[str] = []
    kind: str = "task"
    parent: str | None = None
    children: list[str] = []
    blocked_by: list[str] = []
    links: list[str] = []
    truncated: bool


SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,59}$")
MAX_DOC_CHARS = 200_000


class DocVersionMeta(ORMModel):
    n: int
    title: str
    note: str | None
    author: UserBrief
    actor_kind: ActorKind
    agent_name: str | None
    created_at: datetime
    size: int = 0


class DocMeta(ORMModel):
    id: int
    slug: str
    title: str
    kind: DocKind
    current_version: int
    created_at: datetime
    updated_at: datetime
    last_author: str | None = None
    last_actor_kind: ActorKind | None = None


class DocOut(DocMeta):
    version: int
    body: str
    note: str | None = None
    version_author: UserBrief | None = None
    version_actor_kind: ActorKind | None = None
    version_agent_name: str | None = None
    version_created_at: datetime | None = None


class DocCreate(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    slug: str | None = Field(default=None, max_length=60)
    kind: DocKind = DocKind.notes
    body: str = Field(default="", max_length=MAX_DOC_CHARS)
    note: str | None = Field(default=None, max_length=300)

    @field_validator("slug")
    @classmethod
    def _slug(cls, v):
        if v is not None and not SLUG_RE.match(v):
            raise ValueError("slug: lowercase letters, digits and '-', up to 60")
        return v


class DocSave(BaseModel):
    body: str = Field(max_length=MAX_DOC_CHARS)
    # The version you edited. A newer save in between gets 409.
    base_version: int = Field(ge=1)
    title: str | None = Field(default=None, min_length=1, max_length=200)
    kind: DocKind | None = None
    note: str | None = Field(default=None, max_length=300)


class FileOut(ORMModel):
    id: int
    name: str
    mime: str
    size: int
    sha256: str
    note: str | None
    uploaded_by: int
    uploader: UserBrief | None = None
    actor_kind: ActorKind
    agent_name: str | None
    created_at: datetime


class ContextOut(ORMModel):
    id: int
    kind: str
    repo: str | None
    path: str | None
    ref: str | None
    commit: str | None
    url: str | None
    title: str
    summary: str | None
    added_by: int
    adder: UserBrief | None = None
    actor_kind: ActorKind
    agent_name: str | None = None
    created_at: datetime


class ContextCreate(BaseModel):
    kind: str = Field(pattern=r"^(repo_path|url)$")
    repo: str | None = Field(default=None, max_length=200, pattern=r"^[\w.-]+/[\w.-]+$")
    path: str | None = Field(default=None, max_length=400)
    ref: str | None = Field(default=None, max_length=200)
    commit: str | None = Field(default=None, pattern=r"^[0-9a-f]{7,40}$")
    url: str | None = Field(default=None, max_length=500)
    title: str = Field(min_length=1, max_length=200)
    summary: str | None = Field(default=None, max_length=2_000)


class DocsIndexItem(BaseModel):
    """One thing an agent can read: a hub document or a linked repo file/page."""

    kind: str  # hub_doc | repo_path | url
    title: str
    summary: str | None = None
    task_id: int
    task_title: str
    repo: str | None = None
    path: str | None = None
    ref: str | None = None
    url: str | None = None
    slug: str | None = None
    version: int | None = None
    updated_at: datetime


class TriageRequest(BaseModel):
    task_ids: list[int] = Field(min_length=1, max_length=100)
    to: TaskStatus
    reason: str | None = Field(default=None, max_length=2_000)
    assignee_1_id: int | None = None
    priority: Priority | None = None
    side: Side | None = None

    @field_validator("to")
    @classmethod
    def _to(cls, v: TaskStatus) -> TaskStatus:
        if v not in {TaskStatus.backlog, TaskStatus.to_do, TaskStatus.dropped}:
            raise ValueError("triage moves tasks to backlog, to_do or dropped")
        return v


class TriageResult(BaseModel):
    id: int
    ok: bool
    status: TaskStatus | None = None
    error: str | None = None


class InboxItem(BaseModel):
    task_id: int
    task_title: str
    reason: str
    comment_id: int | None = None
    author: str | None = None
    text: str | None = None
    at: datetime


# --- KPI --------------------------------------------------------------------


class SpeedKpi(BaseModel):
    avg_cycle_time_hours: float | None
    median_cycle_time_hours: float | None
    avg_time_in_status_hours: dict[str, float | None]
    # Keyed by ISO week ("2026-W12") of the closing event, for the trend chart.
    avg_cycle_time_per_week: dict[str, float]
    # Total cycle hours divided by total points — a weighted rate, so hard work
    # is not penalised for taking longer. See the note in kpi/service.py.
    hours_per_point: float | None


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
    # Difficulty-weighted counterparts of the figures above.
    points_completed: int
    points_per_week: dict[str, int]
    points_per_month: dict[str, int]
    open_points_by_status: dict[str, int]
    open_points_total: int
    avg_points_per_task: float | None


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

TaskDetailOut.model_rebuild()
ClaimOut.model_rebuild()
