"""Pydantic request/response models."""

from __future__ import annotations

import re
from datetime import date, datetime
from typing import Any

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
    # The subtask made when someone took this part, and whether the caller may take it.
    subtask_id: int | None = None
    subtask: "TaskRef | None" = None
    can_take: bool = False
    take_block_text: str | None = None


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


def _check_audience(v):
    from app.models import AUDIENCES

    if v is None:
        return v
    v = v.strip().lower()
    if v == "":
        return ""
    if v not in AUDIENCES:
        raise ValueError(f"audience: one of {', '.join(AUDIENCES)}")
    return v


def _check_requested(v):
    from app.models import REQUESTERS

    if v is None:
        return v
    v = v.strip().lower()
    if v and v not in REQUESTERS:
        raise ValueError(f"requested_by: one of {', '.join(REQUESTERS)}")
    return v


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
    audience: str | None = None
    requested_by: str | None = None
    blocked_by: list[int] = []


class SplitPart(BaseModel):
    side: Side
    title: str | None = Field(default=None, max_length=200)
    assignee_id: int | None = None
    points: int | None = None
    description: str | None = Field(default=None, max_length=20_000)
    criteria: list[str] = Field(default_factory=list, max_length=30)
    # Parent criteria (by number) this part carries: their text is copied in, and each one
    # not yet linked points at this part, so approving the part marks it met.
    parts_from: list[int] = Field(default_factory=list, max_length=30)
    # Text put before each copied criterion, e.g. "API half: ".
    parts_prefix: dict[int, str] = Field(default_factory=dict)

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


AREA_SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]{1,58}$")


class AreaBrief(ORMModel):
    id: int
    slug: str
    name: str


class AreaOut(AreaBrief):
    description: str | None = None
    aliases: list[str] = []
    parent: str | None = None  # parent slug
    merged_into: str | None = None
    created_at: datetime
    open_count: int = 0
    total_count: int = 0
    # The tree: where this area sits and what is under it. Counts below include sub-areas.
    parent_name: str | None = None
    depth: int = 0
    path: list[str] = []
    children: list[str] = []
    children_count: int = 0
    subtree_open: int = 0
    subtree_total: int = 0
    # Filled with ?tree=true: the sub-areas, nested.
    subareas: list["AreaOut"] = []


def _clean_aliases(v):
    if v is None:
        return v
    out = []
    for a in v:
        a = " ".join((a or "").split())
        if not a:
            continue
        if len(a) > 60:
            raise ValueError("an alias is at most 60 characters")
        if a.lower() not in [x.lower() for x in out]:
            out.append(a)
    if len(out) > 15:
        raise ValueError("at most 15 aliases")
    return out


class AreaCreate(BaseModel):
    name: str = Field(min_length=2, max_length=120)
    # Made from the name when left out; give one when the name is not in Latin letters.
    slug: str | None = None
    description: str | None = Field(default=None, max_length=1_000)
    aliases: list[str] = Field(default_factory=list)
    parent: str | None = None
    # The hub refuses a name close to an existing area unless this is true.
    confirm_new: bool = False

    _aliases = field_validator("aliases")(staticmethod(_clean_aliases))

    @field_validator("slug")
    @classmethod
    def _slug(cls, v):
        if v is not None and not AREA_SLUG_RE.match(v):
            raise ValueError("slug: lowercase letters, digits and dashes, 2 to 59 characters")
        return v


class AreaUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=2, max_length=120)
    description: str | None = Field(default=None, max_length=1_000)
    aliases: list[str] | None = None
    parent: str | None = None  # slug; "" clears

    _aliases = field_validator("aliases")(staticmethod(_clean_aliases))


class AreaMerge(BaseModel):
    into: str  # slug of the area to keep


class AreaSuggestion(BaseModel):
    area: AreaBrief
    score: int


class SimilarRequest(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    description: str | None = Field(default=None, max_length=20_000)
    criteria: list[str] = Field(default_factory=list, max_length=30)
    area: str | None = None
    # Leave these out of the comparison (the task itself, its parent).
    exclude_id: int | None = None
    parent_id: int | None = None
    limit: int = Field(default=5, ge=1, le=20)


class SimilarMatch(BaseModel):
    id: int
    title: str
    status: TaskStatus
    kind: TaskKind
    area: AreaBrief | None = None
    score: int
    same_area: bool = False
    # duplicate (90+), related (75+), similar (50+)
    band: str


class SimilarOut(BaseModel):
    matches: list[SimilarMatch] = []
    suggested_areas: list[AreaSuggestion] = []


class DecisionQuestion(BaseModel):
    comment_id: int
    to: str | None = None
    author: str | None = None
    text: str
    at: datetime


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
    # True when anyone on its side may claim it (no assignee, not restricted, not assign-only).
    pool: bool = False
    assign_only: bool = False
    audience: str | None = None
    requested_by: str | None = None
    requested_by_name: str | None = None
    requested_at: date | None = None
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
    area: AreaBrief | None = None
    # Filled by the router.
    criteria_total: int = 0
    criteria_open: int = 0
    open_questions: int = 0
    blocked_by: list[int] = []
    children_total: int = 0
    children_open: int = 0
    # Filled only by GET /tasks?awaiting_decision=true: the open questions
    # that make the task wait on the caller (or on a lead).
    decision_questions: list[DecisionQuestion] = []
    # For the caller: can they claim it now, and if not, why (code + sentence).
    claimable: bool = False
    claim_block: str | None = None
    claim_block_text: str | None = None
    # For the caller: may they set who works on it (leads always; members on open or own tasks).
    can_assign: bool = False
    # Only the side rule stops the caller: a cross_side_reason would let them claim it.
    cross_side_ok: bool = False
    # planned = to_do, backlog = backlog; null for other statuses.
    lane: str | None = None
    # Everyone on the task, including people working through its subtasks.
    people: list["PersonOn"] = []
    parts_total: int = 0
    parts_taken: int = 0


class PersonOn(BaseModel):
    handle: str
    name: str
    # assignee, claim (holds the task itself) or part (holds a subtask made from a part).
    role: str
    task_id: int
    part: int | None = None


class TakePartRequest(BaseModel):
    ttl_hours: float | None = Field(default=None, gt=0)
    agent: str | None = Field(default=None, max_length=80)
    # Lets a member take another side's task when it is a simple change they can test.
    cross_side_reason: str | None = Field(default=None, min_length=10, max_length=500)


class FacetsOut(BaseModel):
    total: int
    status: dict[str, int]
    priority: dict[str, int]
    kind: dict[str, int]
    side: dict[str, int]
    area: dict[str, int]
    lane: dict[str, int]
    claimable: int
    subtasks: int
    audience: dict[str, int] = {}
    # Per area: matching tasks in it or any area below it.
    area_tree: dict[str, int] = {}
    requested_by: dict[str, int] = {}


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
    # Filled on create: tasks that look alike, the areas the text fits, and
    # whether the hub picked the area itself.
    similar: list[SimilarMatch] = []
    suggested_areas: list[AreaSuggestion] = []
    area_auto: bool = False


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
    # Only a lead's chosen assignee takes it (leads only).
    assign_only: bool | None = None
    # Who the problem reaches; "" clears it.
    audience: str | None = None
    # Who asked for it (leads only); "" clears it.
    requested_by: str | None = None
    requested_by_name: str | None = Field(default=None, max_length=80)
    requested_at: date | None = None

    @field_validator("requested_by")
    @classmethod
    def _requested(cls, v):
        return _check_requested(v)

    @field_validator("requested_at", mode="before")
    @classmethod
    def _requested_at(cls, v):
        return None if v == "" else v

    @field_validator("audience")
    @classmethod
    def _audience(cls, v):
        return _check_audience(v)
    # Product area slug (GET /areas lists them); "" clears it.
    area: str | None = None

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
    # Compare with existing tasks first (on by default; off for bulk imports).
    check_similar: bool = True
    # Required to create a task that scores 90+ against another: why it differs.
    duplicate_reason: str | None = Field(default=None, max_length=500)
    # With no area given, use the best suggestion when it is clear enough.
    auto_area: bool = True

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


class ImportTask(BaseModel):
    """One task of a bulk import. `external_key` is the caller's stable id; the
    hub keeps it as the fingerprint `ext:<key>` and updates that task on a
    later import instead of adding a copy."""

    external_key: str = Field(pattern=r"^[\w:./@#-]{1,190}$")
    title: str = Field(min_length=1, max_length=200)
    description: str | None = Field(default=None, max_length=20_000)
    kind: TaskKind = TaskKind.task
    priority: Priority = Priority.medium
    side: Side | None = None
    # Area slug, name or alias. The area must exist (POST /areas adds one).
    area: str | None = Field(default=None, max_length=60)
    tags: list[str] = Field(default_factory=list)
    criteria: list[str] = Field(default_factory=list, max_length=30)
    # Effort on the hub's scale (1, 2, 3, 5, 8, 13); left out, new tasks get the default.
    points: int | None = None
    restricted: bool = False
    # Sensitive work a lead assigns by hand.
    assign_only: bool = False
    audience: str | None = None
    requested_by: str | None = None
    requested_by_name: str | None = Field(default=None, max_length=80)
    requested_at: date | None = None

    @field_validator("requested_by")
    @classmethod
    def _requested(cls, v):
        return _check_requested(v)

    @field_validator("requested_at", mode="before")
    @classmethod
    def _requested_at(cls, v):
        return None if v == "" else v

    @field_validator("audience")
    @classmethod
    def _audience(cls, v):
        return _check_audience(v)
    # Used on create only; a later import never moves the task.
    status: TaskStatus = TaskStatus.backlog
    # A question for a lead. It parks the task in needs_confirm until answered.
    question: str | None = Field(default=None, max_length=20_000)
    question_to: str | None = Field(default=None, max_length=40)

    @field_validator("title")
    @classmethod
    def _strip_title(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("title must not be blank")
        return v

    @field_validator("tags")
    @classmethod
    def _tags(cls, v):
        return _clean_list(v, pattern=TAG_RE, what="tag", limit=12)

    @field_validator("criteria")
    @classmethod
    def _criteria(cls, v: list[str]) -> list[str]:
        out = [c.strip() for c in v if c and c.strip()]
        for c in out:
            if len(c) > 1_000:
                raise ValueError("a criterion is at most 1,000 characters")
        return out

    @field_validator("status")
    @classmethod
    def _create_status(cls, v: TaskStatus) -> TaskStatus:
        if v not in CREATE_STATUSES:
            raise ValueError("an imported task starts in proposed, backlog or to_do")
        return v

    @model_validator(mode="after")
    def _question_needs_a_person(self):
        self.question = (self.question or "").strip() or None
        self.question_to = (self.question_to or "").strip() or None
        if self.question and not self.question_to:
            raise ValueError("question needs question_to: the handle of the person asked")
        if self.question_to and not self.question:
            raise ValueError("question_to needs question: the text to ask")
        return self

    _check_points = field_validator("points")(staticmethod(_validate_points))

class ImportRequest(BaseModel):
    # Validate and report without writing anything.
    dry_run: bool = False
    # Each entry is checked on its own, so one bad task does not fail the rest.
    tasks: list[dict[str, Any]] = Field(min_length=1)


class ImportResult(BaseModel):
    external_key: str | None = None
    action: str  # created | updated | unchanged | error
    id: int | None = None
    error: str | None = None


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
    # Lets a member take another side's task when it is a simple change they can test.
    cross_side_reason: str | None = Field(default=None, min_length=10, max_length=500)


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
    audience: str | None = None
    # The product area's slug (its path is in GET /areas).
    area: str | None = None
    requested_by: str | None = None
    requested_by_name: str | None = None
    cross_side_ok: bool = False
    # For the caller: can they claim it, and if not, why (code + sentence).
    claimable: bool = False
    claim_block: str | None = None
    claim_block_text: str | None = None
    # Everyone on it, e.g. "@sara part 2 via HUB-31", and "n/m taken" for its parts.
    people: list[str] = []
    parts: str = ""


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
CriterionOut.model_rebuild()
TaskOut.model_rebuild()
AreaOut.model_rebuild()
