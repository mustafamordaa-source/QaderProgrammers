"""Task routes: CRUD, assignment, status transitions, claims, comments,
acceptance criteria, git links, deploy state, the agent brief and the inbox.

Who may do what:

- leader: everything;
- member ("programmer"): reads every task except restricted ones and other
  people's proposals; works on (moves, edits summary/tags/areas, criteria,
  links, deploy state) tasks assigned to them, or pool tasks they claimed;
  creates tasks into backlog;
- viewer: reads, nothing else.

A personal API token acts for its owner with the same rights, narrowed by the
token's scopes.
"""

from __future__ import annotations

import re
from datetime import timedelta

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import and_, func, or_, select, update
from sqlalchemy.orm import Session, selectinload

from app import lint
from app.config import settings
from app.deps import Auth, AuthCtx, DbSession, require_leader, require_scope
from app.events import record
from app.models import (
    CLOSED_STATUSES,
    AccountType,
    ActorKind,
    Comment,
    CommentKind,
    Criterion,
    CriterionState,
    DeployState,
    EventType,
    GitLink,
    Role,
    Task,
    TaskDoc,
    TaskEvent,
    TaskStatus,
    User,
    utcnow,
)
from app.schemas import (
    ClaimOut,
    ClaimRequest,
    ContextOut,
    FileOut,
    TriageRequest,
    TriageResult,
    CommentCreate,
    CommentOut,
    CriterionCreate,
    CriterionOut,
    CriterionUpdate,
    DeployUpdate,
    GitLinkCreate,
    GitLinkOut,
    InboxItem,
    RejectRequest,
    StatusChangeRequest,
    TaskAssign,
    TaskBrief,
    TaskCreate,
    TaskDetailOut,
    TaskEventOut,
    TaskOut,
    TaskUpdate,
)
from app.transitions import PARKABLE, PARKING, TransitionError, check_rejection, check_transition

router = APIRouter(prefix="/tasks", tags=["tasks"])

S = TaskStatus

# Headings a hand-back must carry. The full template is in the agent skill.
HANDBACK_REQUIRED = ("Summary:", "Checks run:", "Left:")


# --- helpers ------------------------------------------------------------------


def _not_found() -> HTTPException:
    # 404 rather than 403: don't reveal that a task exists.
    return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Task not found")


def _get_task_or_404(db: Session, task_id: int) -> Task:
    task = db.scalar(
        select(Task)
        .where(Task.id == task_id)
        .options(
            selectinload(Task.events),
            selectinload(Task.comments),
            selectinload(Task.criteria),
            selectinload(Task.git_links),
            selectinload(Task.docs).selectinload(TaskDoc.versions),
            selectinload(Task.files),
            selectinload(Task.context),
        )
    )
    if task is None:
        raise _not_found()
    return task


def _can_see(task: Task, user: User) -> bool:
    if user.is_lead:
        return True
    if task.restricted:
        # Restricted work stays between the leads and the people on it.
        return user.id in task.assignee_ids
    if task.status is S.proposed:
        return task.created_by == user.id
    return True


def _assert_visible(task: Task, user: User) -> None:
    if not _can_see(task, user):
        raise _not_found()


def _visible_filter(user: User):
    """SQL filter matching `_can_see` for list queries."""
    if user.is_lead:
        return None
    assigned = or_(Task.assignee_1_id == user.id, Task.assignee_2_id == user.id)
    return and_(
        or_(Task.restricted.is_(False), assigned),
        or_(Task.status != S.proposed, Task.created_by == user.id),
    )


def _is_worker(task: Task, user: User) -> bool:
    """May this person work on the task (not just read it)?"""
    if user.is_lead:
        return True
    if user.is_read_only:
        return False
    if user.id in task.assignee_ids:
        return True
    return task.pool and task.claimed_by == user.id and task.claim_is_live(utcnow())


def _assert_worker(task: Task, user: User) -> None:
    if not _is_worker(task, user):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You can only change tasks assigned to you (or pool tasks you claimed)",
        )


def _assert_not_viewer(user: User) -> None:
    if user.is_read_only:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Viewer accounts are read-only")


def _check_version(task: Task, expected: int | None) -> None:
    if expected is not None and expected != task.version:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=(
                f"Task changed since you read it (your version {expected}, now {task.version}). "
                "Read it again and retry."
            ),
        )


def _touch(task: Task) -> None:
    task.version = (task.version or 1) + 1
    task.updated_at = utcnow()


def _clear_claim(task: Task) -> None:
    task.claimed_by = None
    task.claim_agent = None
    task.claim_expires_at = None


def _counts(task: Task) -> tuple[int, int, int]:
    total = len(task.criteria)
    open_ = sum(1 for c in task.criteria if c.state is CriterionState.open)
    questions = sum(
        1 for c in task.comments if c.kind is CommentKind.question and c.resolved_at is None
    )
    return total, open_, questions


def _out(task: Task, model=TaskOut, **extra):
    row = model.model_validate(task)
    row.criteria_total, row.criteria_open, row.open_questions = _counts(task)
    for key, value in extra.items():
        setattr(row, key, value)
    return row


def _detail(task: Task) -> TaskDetailOut:
    from app.routers.docs import doc_meta

    row = _out(task, TaskDetailOut)
    row.docs = [doc_meta(d) for d in task.docs]
    row.files = [FileOut.model_validate(f) for f in task.files if f.removed_at is None]
    row.context = [ContextOut.model_validate(c) for c in task.context]
    return row


def _validate_assignees(db: Session, assignee_1_id: int | None, assignee_2_id: int | None) -> None:
    for field, uid in (("assignee_1_id", assignee_1_id), ("assignee_2_id", assignee_2_id)):
        if uid is None:
            continue
        assignee = db.get(User, uid)
        if assignee is None:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=f"{field}: user {uid} does not exist",
            )
        if assignee.is_bot or not assignee.is_member:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=f"{field}: tasks can only be assigned to members",
            )
        if not assignee.is_active:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=f"{field}: {assignee.name}'s account is deactivated",
            )


def _resolve_person(db: Session, ref: str) -> User:
    ref = ref.strip().lstrip("@")
    user = db.get(User, int(ref)) if ref.isdigit() else db.scalar(
        select(User).where(User.handle == ref.lower())
    )
    if user is None or not user.is_active:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"No active person with handle or id '{ref}'",
        )
    return user


def _open_criteria_numbers(task: Task) -> list[int]:
    return [c.n for c in task.criteria if c.state is CriterionState.open]


def _last_claim_time(task: Task):
    times = [e.timestamp for e in task.events if e.event_type is EventType.claimed]
    return max(times) if times else None


def _has_handback_since(task: Task, since) -> bool:
    return any(
        c.kind is CommentKind.handback and (since is None or c.created_at >= since)
        for c in task.comments
    )


def _unpark_if_clear(db: Session, auth: Auth, task: Task) -> None:
    """Return a needs_confirm task to where it was once no question is open."""
    if task.status is not S.needs_confirm:
        return
    if any(c.kind is CommentKind.question and c.resolved_at is None for c in task.comments):
        return
    target = task.resume_status or S.to_do
    record(
        db,
        auth,
        task_id=task.id,
        event_type=EventType.status_changed,
        from_status=task.status,
        to_status=target,
        comment="Every open question is answered",
    )
    task.status = target
    task.resume_status = None
    _touch(task)


# --- create / list / read -----------------------------------------------------


def _create_auth(auth: AuthCtx) -> Auth:
    if not (auth.has("tasks:create") or auth.has("tasks:propose")):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="This API token lacks the 'tasks:create' or 'tasks:propose' scope",
        )
    return auth


@router.post("", response_model=TaskDetailOut, status_code=status.HTTP_201_CREATED)
def create_task(
    payload: TaskCreate,
    db: DbSession,
    auth: Auth = Depends(_create_auth),
) -> TaskDetailOut:
    user = auth.user
    _assert_not_viewer(user)
    # Bots and propose-only tokens file proposals for a lead to triage.
    propose_only = user.is_bot or not auth.has("tasks:create")
    is_leader = user.is_lead and not propose_only

    if not is_leader:
        if payload.assignee_1_id or payload.assignee_2_id:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Only a leader assigns tasks; yours goes to the backlog for triage",
            )
        if payload.restricted or payload.pool:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Only a leader marks a task restricted or pool",
            )
    _validate_assignees(db, payload.assignee_1_id, payload.assignee_2_id)

    if propose_only:
        start = S.proposed
    elif is_leader:
        start = payload.status
    else:
        start = S.proposed if payload.status is S.proposed else S.backlog
    task = Task(
        title=lint.clean(payload.title, field="title"),
        description=lint.clean(payload.description, field="description"),
        summary=lint.clean(payload.summary, field="summary"),
        priority=payload.priority,
        points=payload.points,
        status=start,
        due_date=payload.due_date,
        created_by=user.id,
        assignee_1_id=payload.assignee_1_id,
        assignee_2_id=payload.assignee_2_id,
        side=payload.side,
        tags=payload.tags or [],
        areas=payload.areas or [],
        restricted=bool(payload.restricted),
        pool=bool(payload.pool),
        created_kind=auth.kind,
        created_agent=auth.agent,
    )
    db.add(task)
    db.flush()  # assign task.id before logging the event

    for n, text in enumerate(payload.criteria, start=1):
        db.add(Criterion(task_id=task.id, n=n, text=lint.clean(text, field=f"criterion {n}")))

    record(
        db,
        auth,
        task_id=task.id,
        event_type=EventType.created,
        to_status=start,
        timestamp=task.created_at,
    )
    db.commit()
    return _detail(_get_task_or_404(db, task.id))


@router.get("", response_model=list[TaskOut])
def list_tasks(
    auth: AuthCtx,
    db: DbSession,
    status_filter: TaskStatus | None = None,
    assignee_id: int | None = None,
    side: str | None = None,
    tag: str | None = None,
    mine: bool = False,
    ready: bool = Query(default=False, description="Only tasks you can claim now"),
    q: str | None = Query(default=None, max_length=100),
    include_closed: bool = True,
    created_kind: ActorKind | None = None,
    created_by: int | None = None,
    from_bots: bool = Query(default=False, description="Only tasks a bot account filed"),
    limit: int = Query(default=500, ge=1, le=1000),
) -> list[TaskOut]:
    if not auth.has("tasks:read"):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="This API token lacks the 'tasks:read' scope")
    user = auth.user
    now = utcnow()
    stmt = (
        select(Task)
        .options(selectinload(Task.criteria), selectinload(Task.comments))
        .order_by(Task.created_at.desc())
    )
    visible = _visible_filter(user)
    if visible is not None:
        stmt = stmt.where(visible)

    mine_filter = or_(Task.assignee_1_id == user.id, Task.assignee_2_id == user.id)
    if mine:
        stmt = stmt.where(or_(mine_filter, Task.claimed_by == user.id))
    elif assignee_id is not None:
        stmt = stmt.where(or_(Task.assignee_1_id == assignee_id, Task.assignee_2_id == assignee_id))

    if ready:
        stmt = stmt.where(
            Task.status == S.to_do,
            or_(Task.claimed_by.is_(None), Task.claim_expires_at <= now),
        )
        if not user.is_lead:
            stmt = stmt.where(or_(mine_filter, Task.pool.is_(True)))

    if status_filter is not None:
        stmt = stmt.where(Task.status == status_filter)
    elif not include_closed:
        stmt = stmt.where(Task.status.not_in(list(CLOSED_STATUSES)))
    if side:
        stmt = stmt.where(Task.side == side)
    if created_kind is not None:
        stmt = stmt.where(Task.created_kind == created_kind)
    if created_by is not None:
        stmt = stmt.where(Task.created_by == created_by)
    if from_bots:
        bot_ids = select(User.id).where(User.account_type == AccountType.bot)
        stmt = stmt.where(Task.created_by.in_(bot_ids))
    if q:
        like = f"%{q.strip()}%"
        stmt = stmt.where(or_(Task.title.ilike(like), Task.description.ilike(like), Task.summary.ilike(like)))

    if tag:
        tasks = [t for t in db.scalars(stmt).unique() if tag in (t.tags or [])][:limit]
    else:
        tasks = list(db.scalars(stmt.limit(limit)).unique())
    return [_out(t) for t in tasks]


@router.get("/inbox", response_model=list[InboxItem])
def inbox(auth: AuthCtx, db: DbSession) -> list[InboxItem]:
    """What waits on you: open questions to you, your tasks that are parked,
    and for leaders the review and triage queues."""
    user = auth.user
    items: list[InboxItem] = []

    questions = db.scalars(
        select(Comment)
        .where(
            Comment.kind == CommentKind.question,
            Comment.to_user_id == user.id,
            Comment.resolved_at.is_(None),
        )
        .order_by(Comment.created_at)
    ).all()
    for c in questions:
        if _can_see(c.task, user):
            items.append(
                InboxItem(
                    task_id=c.task_id,
                    task_title=c.task.title,
                    reason="question",
                    comment_id=c.id,
                    author=_who(c),
                    text=c.body[:300],
                    at=c.created_at,
                )
            )

    mine = or_(Task.assignee_1_id == user.id, Task.assignee_2_id == user.id, Task.claimed_by == user.id)
    for t in db.scalars(select(Task).where(mine, Task.status.in_([S.blocked, S.needs_confirm]))).unique():
        items.append(InboxItem(task_id=t.id, task_title=t.title, reason=t.status.value, at=t.updated_at))

    if user.is_lead:
        for t in db.scalars(
            select(Task).where(Task.status.in_([S.in_review, S.proposed])).order_by(Task.updated_at)
        ).unique():
            reason = "review" if t.status is S.in_review else "triage"
            items.append(InboxItem(task_id=t.id, task_title=t.title, reason=reason, at=t.updated_at))
    return items


@router.post("/triage", response_model=list[TriageResult])
def triage(
    payload: TriageRequest,
    db: DbSession,
    auth: Auth = Depends(require_scope("tasks:write")),
    lead: User = Depends(require_leader),
) -> list[TriageResult]:
    """Accept or drop many proposals (or backlog tasks) at once.

    Each task is checked on its own; one bad id does not stop the rest.
    """
    if payload.to is S.dropped and not (payload.reason or "").strip():
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="A reason is required to drop tasks")
    reason = lint.clean(payload.reason, field="reason")
    if payload.assignee_1_id is not None:
        _validate_assignees(db, payload.assignee_1_id, None)
    results: list[TriageResult] = []
    for task_id in dict.fromkeys(payload.task_ids):
        task = db.get(Task, task_id)
        if task is None:
            results.append(TriageResult(id=task_id, ok=False, error="not found"))
            continue
        if task.status not in {S.proposed, S.backlog}:
            results.append(TriageResult(id=task_id, ok=False, status=task.status,
                                        error=f"only proposed or backlog tasks (task is {task.status.value})"))
            continue
        if task.status is payload.to:
            results.append(TriageResult(id=task_id, ok=True, status=task.status))
            continue
        from_status = task.status
        task.status = payload.to
        changes = {}
        if payload.assignee_1_id is not None and payload.to is not S.dropped:
            task.assignee_1_id = payload.assignee_1_id
            changes["assignee_1_id"] = payload.assignee_1_id
        if payload.priority is not None:
            task.priority = payload.priority
            changes["priority"] = payload.priority.value
        if payload.side is not None:
            task.side = payload.side
            changes["side"] = payload.side.value
        if payload.to is S.dropped:
            task.drop_reason = reason
        _touch(task)
        record(
            db, auth, task_id=task.id,
            event_type=EventType.dropped if payload.to is S.dropped else EventType.triaged,
            from_status=from_status, to_status=payload.to, comment=reason, data=changes or None,
        )
        results.append(TriageResult(id=task_id, ok=True, status=payload.to))
    db.commit()
    return results


@router.get("/{task_id}", response_model=TaskDetailOut)
def get_task(task_id: int, auth: AuthCtx, db: DbSession) -> TaskDetailOut:
    task = _get_task_or_404(db, task_id)
    _assert_visible(task, auth.user)
    return _detail(task)


def _size(n: int) -> str:
    if n < 1024:
        return f"{n} B"
    if n < 1024 * 1024:
        return f"{n / 1024:.0f} KB"
    return f"{n / 1024 / 1024:.1f} MB"


def _who(comment: Comment) -> str:
    name = comment.author.handle or comment.author.name
    return f"{name} (agent {comment.agent_name})" if comment.agent_name else f"{name} (human)"


def _cut(text: str | None, limit: int) -> tuple[str | None, bool]:
    if text is None:
        return None, False
    text = text.strip()
    if len(text) <= limit:
        return text, False
    return text[: limit - 1].rstrip() + "…", True


@router.get("/{task_id}/brief", response_model=TaskBrief)
def brief(task_id: int, auth: AuthCtx, db: DbSession) -> TaskBrief:
    """Everything an agent needs before working on a task, capped near 2 KB.

    Free text from people stays free text: the CLI marks it as untrusted.
    """
    task = _get_task_or_404(db, task_id)
    _assert_visible(task, auth.user)
    truncated = False

    summary, cut = _cut(task.summary, 500)
    truncated |= cut
    description, cut = _cut(task.description, 500 if summary else 800)
    truncated |= cut

    criteria = []
    for c in task.criteria:
        text, cut = _cut(c.text, 140)
        truncated |= cut
        criteria.append(f"{c.n}. [{c.state.value}] {text}")

    questions = []
    for c in task.comments:
        if c.kind is CommentKind.question and c.resolved_at is None:
            text, cut = _cut(c.body, 160)
            truncated |= cut
            to = f" to @{c.to_user.handle or c.to_user.name}" if c.to_user else ""
            questions.append(f"#{c.id} by {_who(c)}{to}: {text}")
    if len(questions) > 5:
        questions, truncated = questions[:5], True

    handbacks = [c for c in task.comments if c.kind is CommentKind.handback]
    last_handback, cut = _cut(
        f"by {_who(handbacks[-1])}\n{handbacks[-1].body}" if handbacks else None, 600
    )
    truncated |= cut

    git = [
        f"{g.kind.value} {g.repo} {g.ref[:12] if g.kind.value == 'commit' else g.ref}"
        + (f" ({g.state})" if g.state else "")
        for g in task.git_links[-8:]
    ]
    truncated |= len(task.git_links) > 8

    claim = None
    if task.claim_is_live(utcnow()) and task.claimer:
        who = task.claimer.handle or task.claimer.name
        claim = f"{who}/{task.claim_agent or 'web'} until {task.claim_expires_at:%Y-%m-%d %H:%M}Z"

    assignees = [u.handle or u.name for u in (task.assignee_1, task.assignee_2) if u]
    deploy = task.deploy_state.value + (f": {task.deploy_note[:120]}" if task.deploy_note else "")
    docs = [f"{d.slug} v{d.current_version} ({d.kind.value}): {d.title[:80]}" for d in task.docs[:8]]
    context = [
        (f"{c.repo}:{c.path}" + (f"@{c.ref}" if c.ref else "") if c.path else c.url or "")
        + f" - {c.title[:60]}"
        + (f": {c.summary[:100]}" if c.summary else "")
        for c in task.context[:8]
    ]
    files = [f"{f.name} ({_size(f.size)})" for f in task.files if f.removed_at is None][:8]
    truncated |= len(task.docs) > 8 or len(task.context) > 8
    return TaskBrief(
        id=task.id,
        title=task.title,
        status=task.status,
        side=task.side,
        priority=task.priority,
        points=task.points,
        version=task.version,
        tags=task.tags or [],
        areas=task.areas or [],
        assignees=assignees,
        claim=claim,
        summary=summary,
        description=description,
        criteria=criteria,
        open_questions=questions,
        last_handback=last_handback,
        git=git,
        deploy=deploy,
        docs=docs,
        context=context,
        files=files,
        truncated=truncated,
    )


@router.get("/{task_id}/events", response_model=list[TaskEventOut])
def task_events(
    task_id: int,
    auth: AuthCtx,
    db: DbSession,
    since: int = Query(default=0, ge=0, description="Only events with a larger id"),
) -> list[TaskEvent]:
    task = _get_task_or_404(db, task_id)
    _assert_visible(task, auth.user)
    return list(
        db.scalars(
            select(TaskEvent)
            .where(TaskEvent.task_id == task_id, TaskEvent.id > since)
            .order_by(TaskEvent.id)
        )
    )


# --- edit / assign / status ---------------------------------------------------

_WORKER_FIELDS = {"summary", "tags", "areas", "side"}
_LINTED = {"title", "description", "summary"}


@router.patch("/{task_id}", response_model=TaskDetailOut)
def update_task(
    task_id: int,
    payload: TaskUpdate,
    db: DbSession,
    auth: Auth = Depends(require_scope("tasks:write")),
) -> TaskDetailOut:
    task = _get_task_or_404(db, task_id)
    user = auth.user
    _assert_visible(task, user)
    fields = payload.model_dump(exclude_unset=True)
    _check_version(task, fields.pop("expected_version", None))

    if not user.is_lead:
        _assert_worker(task, user)
        if task.status in CLOSED_STATUSES:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="The task is closed")
        extra = set(fields) - _WORKER_FIELDS
        if extra:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"Only a leader can change: {', '.join(sorted(extra))}",
            )

    changes: dict[str, list] = {}
    for field, value in fields.items():
        if field in _LINTED:
            value = lint.clean(value, field=field)
        if field in {"restricted", "pool"} and value is None:
            continue
        if field in {"tags", "areas"} and value is None:
            value = []
        old = getattr(task, field)
        if old == value:
            continue
        setattr(task, field, value)
        if field == "description":
            changes[field] = ["(changed)", "(changed)"]
        else:
            changes[field] = [_plain(old), _plain(value)]

    if changes:
        record(db, auth, task_id=task.id, event_type=EventType.field_changed, data=changes)
        _touch(task)
    db.commit()
    return _detail(_get_task_or_404(db, task.id))


def _plain(value):
    if hasattr(value, "value"):
        return value.value
    if hasattr(value, "isoformat"):
        return value.isoformat()
    return value


@router.patch("/{task_id}/status", response_model=TaskDetailOut)
def change_status(
    task_id: int,
    payload: StatusChangeRequest,
    db: DbSession,
    auth: Auth = Depends(require_scope("tasks:write")),
) -> TaskDetailOut:
    task = _get_task_or_404(db, task_id)
    user = auth.user
    _assert_visible(task, user)
    _check_version(task, payload.expected_version)

    try:
        check_transition(
            current=task.status,
            target=payload.status,
            role=user.work_role,
            is_assignee=_is_worker(task, user),
            resume_status=task.resume_status,
        )
    except TransitionError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from None

    from_status = task.status
    target = payload.status
    comment = lint.clean(payload.comment, field="comment")
    now = utcnow()

    if target in {S.in_review, S.done}:
        open_numbers = _open_criteria_numbers(task)
        if open_numbers:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=(
                    "Acceptance criteria still open: "
                    + ", ".join(str(n) for n in open_numbers)
                    + ". Mark each met (with evidence) or dropped first."
                ),
            )
    if target is S.in_review and auth.kind is ActorKind.agent:
        if not _has_handback_since(task, _last_claim_time(task)):
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Post a hand-back comment (kind 'handback') before moving the task to review.",
            )
    if target is S.dropped and not (comment or "").strip():
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="A reason is required to drop a task",
        )

    if target in PARKING and from_status in PARKABLE:
        task.resume_status = from_status
    elif from_status in PARKING and target not in PARKING:
        task.resume_status = None

    task.status = target
    _touch(task)
    if target in {S.in_review, S.done, S.dropped}:
        _clear_claim(task)

    if from_status is S.in_review and target is S.done:
        # Approval and closure are distinct KPI inputs: `approved` feeds the
        # review pass rate, `closed` marks the end of the cycle.
        record(db, auth, task_id=task.id, event_type=EventType.approved,
               from_status=from_status, to_status=S.done, comment=comment, timestamp=now)
        record(db, auth, task_id=task.id, event_type=EventType.closed,
               from_status=from_status, to_status=S.done, timestamp=now)
    elif from_status is S.in_review and target is S.in_progress:
        # A leader moving a task out of review is a rejection for the KPIs.
        if not (comment or "").strip():
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="A comment is required when sending a task back out of review",
            )
        record(db, auth, task_id=task.id, event_type=EventType.rejected,
               from_status=from_status, to_status=target, comment=comment, timestamp=now)
    elif target is S.dropped:
        task.drop_reason = comment
        record(db, auth, task_id=task.id, event_type=EventType.dropped,
               from_status=from_status, to_status=target, comment=comment, timestamp=now)
    else:
        record(db, auth, task_id=task.id, event_type=EventType.status_changed,
               from_status=from_status, to_status=target, comment=comment, timestamp=now)

    db.commit()
    return _detail(_get_task_or_404(db, task.id))


@router.patch("/{task_id}/assign", response_model=TaskDetailOut)
def assign_task(
    task_id: int,
    payload: TaskAssign,
    db: DbSession,
    auth: AuthCtx,
    leader: User = Depends(require_leader),
) -> TaskDetailOut:
    task = _get_task_or_404(db, task_id)
    _validate_assignees(db, payload.assignee_1_id, payload.assignee_2_id)

    before = task.assignee_ids
    task.assignee_1_id = payload.assignee_1_id
    task.assignee_2_id = payload.assignee_2_id
    _touch(task)

    record(
        db,
        auth,
        task_id=task.id,
        event_type=EventType.assigned,
        comment=f"Reassigned from {before or 'nobody'} to {task.assignee_ids or 'nobody'}",
        data={"from": before, "to": task.assignee_ids},
    )
    db.commit()
    return _detail(_get_task_or_404(db, task.id))


@router.post("/{task_id}/reject", response_model=TaskDetailOut)
def reject_task(
    task_id: int,
    payload: RejectRequest,
    db: DbSession,
    auth: AuthCtx,
    leader: User = Depends(require_leader),
) -> TaskDetailOut:
    task = _get_task_or_404(db, task_id)

    try:
        check_rejection(current=task.status, target=payload.to_status)
    except TransitionError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from None

    from_status = task.status
    task.status = payload.to_status
    _touch(task)

    record(
        db,
        auth,
        task_id=task.id,
        event_type=EventType.rejected,
        from_status=from_status,
        to_status=payload.to_status,
        comment=lint.clean(payload.comment, field="comment"),
    )
    db.commit()
    return _detail(_get_task_or_404(db, task.id))


# --- claims -------------------------------------------------------------------


@router.post("/{task_id}/claim", response_model=ClaimOut)
def claim_task(
    task_id: int,
    payload: ClaimRequest,
    db: DbSession,
    auth: Auth = Depends(require_scope("claims")),
) -> ClaimOut:
    """Take or renew a lease on a task. 409 when someone else holds a live claim."""
    task = _get_task_or_404(db, task_id)
    user = auth.user
    _assert_visible(task, user)
    _assert_not_viewer(user)

    if task.status not in {S.to_do, S.in_progress}:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Only to_do or in_progress tasks can be claimed (task is '{task.status.value}')",
        )
    if not user.is_lead and user.id not in task.assignee_ids and not task.pool:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You can claim tasks assigned to you, or pool tasks",
        )

    agent = auth.agent if auth.kind is ActorKind.agent else (payload.agent or "").strip() or None
    now = utcnow()
    hours = min(payload.ttl_hours or settings.claim_default_hours, settings.claim_max_hours)
    expires = now + timedelta(hours=hours)
    renewing = task.claimed_by == user.id and task.claim_agent == agent and task.claim_is_live(now)
    if renewing and payload.ttl_hours is None and task.claim_expires_at > expires:
        # A plain renew keeps a longer lease the holder asked for earlier.
        expires = task.claim_expires_at

    # One statement decides the race: it only writes when the task is free,
    # the old claim expired, or the same person and agent renew. `now` comes
    # from Python because stored times are naive UTC strings.
    holder_free = or_(
        Task.claimed_by.is_(None),
        Task.claim_expires_at.is_(None),
        Task.claim_expires_at <= now,
        and_(
            Task.claimed_by == user.id,
            (Task.claim_agent == agent) if agent is not None else Task.claim_agent.is_(None),
        ),
    )
    result = db.execute(
        update(Task)
        .where(Task.id == task.id, holder_free)
        .values(
            claimed_by=user.id,
            claim_agent=agent,
            claim_expires_at=expires,
            claim_branch=payload.branch or Task.claim_branch,
            version=Task.version + 1,
            updated_at=now,
        )
        .execution_options(synchronize_session=False)
    )
    if result.rowcount == 0:
        db.rollback()
        holder = task.claimer.handle or task.claimer.name if task.claimer else "someone"
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=(
                f"Claimed by {holder}/{task.claim_agent or 'web'} until "
                f"{task.claim_expires_at:%Y-%m-%d %H:%M}Z. Pick other work."
            ),
        )
    db.refresh(task)

    warnings: list[str] = []
    if task.status is S.to_do:
        record(db, auth, task_id=task.id, event_type=EventType.status_changed,
               from_status=S.to_do, to_status=S.in_progress, comment="Claimed", timestamp=now)
        task.status = S.in_progress

    record(
        db,
        auth,
        task_id=task.id,
        event_type=EventType.claimed,
        timestamp=now,
        data={
            "agent": agent,
            "branch": task.claim_branch,
            "expires_at": expires.isoformat(),
            "renewed": renewing,
        },
    )

    # Warnings, not refusals, during the pilot.
    active = db.scalar(
        select(func.count(Task.id)).where(
            Task.claimed_by == user.id,
            Task.claim_expires_at > now,
            Task.id != task.id,
        )
    ) or 0
    if active + 1 > (user.wip_limit or 2):
        warnings.append(f"You now hold {active + 1} claims; your WIP limit is {user.wip_limit}.")
    if task.areas:
        others = db.scalars(
            select(Task).where(
                Task.id != task.id,
                Task.claimed_by.is_not(None),
                Task.claim_expires_at > now,
            )
        ).unique()
        for other in others:
            shared = set(task.areas) & set(other.areas or [])
            if shared:
                warnings.append(
                    f"Task {other.id} is claimed and touches the same area: {', '.join(sorted(shared))}"
                )

    db.commit()
    return _out(_get_task_or_404(db, task.id), ClaimOut, warnings=warnings)


@router.post("/{task_id}/release", response_model=TaskDetailOut)
def release_task(
    task_id: int,
    db: DbSession,
    auth: Auth = Depends(require_scope("claims")),
) -> TaskDetailOut:
    task = _get_task_or_404(db, task_id)
    user = auth.user
    _assert_visible(task, user)
    if task.claimed_by is None:
        return _detail(task)
    if task.claimed_by != user.id and not user.is_lead:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only the claim holder or a leader can release this claim",
        )
    data = {"agent": task.claim_agent, "holder": task.claimed_by}
    _clear_claim(task)
    _touch(task)
    record(db, auth, task_id=task.id, event_type=EventType.released, data=data)
    db.commit()
    return _detail(_get_task_or_404(db, task.id))


# --- comments -----------------------------------------------------------------


def _section(body: str, heading: str) -> str | None:
    match = re.search(rf"(?im)^[ 	]*{re.escape(heading)}[ 	]*(\S.*)?$", body)
    return match.group(1).strip() if match and match.group(1) else None


@router.get("/{task_id}/comments", response_model=list[CommentOut])
def list_comments(task_id: int, auth: AuthCtx, db: DbSession) -> list[Comment]:
    task = _get_task_or_404(db, task_id)
    _assert_visible(task, auth.user)
    return list(task.comments)


@router.post("/{task_id}/comments", response_model=CommentOut, status_code=status.HTTP_201_CREATED)
def add_comment(
    task_id: int,
    payload: CommentCreate,
    db: DbSession,
    auth: Auth = Depends(require_scope("comments:write")),
) -> Comment:
    task = _get_task_or_404(db, task_id)
    user = auth.user
    _assert_visible(task, user)
    _assert_not_viewer(user)
    if user.is_bot and task.created_by != user.id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="A bot comments only on tasks it proposed")
    body = lint.clean(payload.body, field="body")

    parent = None
    if payload.parent_id is not None:
        parent = db.get(Comment, payload.parent_id)
        if parent is None or parent.task_id != task.id:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="parent_id: no such comment on this task")
        if parent.parent_id is not None:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Reply to the top-level comment; threads are one level deep")

    to_user = None
    if payload.kind is CommentKind.question:
        if not payload.to:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="A question needs 'to': the handle or id of the person asked")
        to_user = _resolve_person(db, payload.to)
    if payload.kind is CommentKind.answer:
        if parent is None or parent.kind is not CommentKind.question:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="An answer needs parent_id pointing at a question")
    if payload.kind is CommentKind.handback:
        missing = [h for h in HANDBACK_REQUIRED if _section(body, h) is None]
        if missing:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="A hand-back needs these headings with text: " + ", ".join(missing),
            )

    comment = Comment(
        task_id=task.id,
        author_id=user.id,
        actor_kind=auth.kind,
        agent_name=auth.agent,
        kind=payload.kind,
        body=body,
        parent_id=parent.id if parent else None,
        to_user_id=to_user.id if to_user else None,
    )
    db.add(comment)
    db.flush()
    task.comments.append(comment)

    if payload.kind is CommentKind.question:
        from_status = task.status
        moved = payload.wait and task.status in PARKABLE
        if moved:
            task.resume_status = task.status
            task.status = S.needs_confirm
            _touch(task)
        record(
            db,
            auth,
            task_id=task.id,
            event_type=EventType.question_asked,
            from_status=from_status if moved else None,
            to_status=S.needs_confirm if moved else None,
            data={"comment_id": comment.id, "to": to_user.id},
        )
    elif payload.kind is CommentKind.answer:
        parent.resolved_at = utcnow()
        parent.resolved_by = user.id
        record(db, auth, task_id=task.id, event_type=EventType.question_answered,
               data={"comment_id": comment.id, "question_id": parent.id})
        _unpark_if_clear(db, auth, task)
    else:
        if payload.kind is CommentKind.handback:
            summary = _section(body, "Summary:")
            if summary:
                task.summary = summary[:4_000]
                _touch(task)
        record(db, auth, task_id=task.id, event_type=EventType.commented,
               data={"comment_id": comment.id, "kind": payload.kind.value})

    db.commit()
    db.refresh(comment)
    return comment


@router.post("/{task_id}/comments/{comment_id}/resolve", response_model=CommentOut)
def resolve_comment(
    task_id: int,
    comment_id: int,
    db: DbSession,
    auth: Auth = Depends(require_scope("comments:write")),
) -> Comment:
    task = _get_task_or_404(db, task_id)
    user = auth.user
    _assert_visible(task, user)
    comment = db.get(Comment, comment_id)
    if comment is None or comment.task_id != task.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Comment not found")
    if not user.is_lead and user.id not in {comment.author_id, comment.to_user_id}:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Only the author, the person asked or a leader can resolve this")
    if comment.resolved_at is None:
        comment.resolved_at = utcnow()
        comment.resolved_by = user.id
        if comment.kind is CommentKind.question:
            record(db, auth, task_id=task.id, event_type=EventType.question_answered,
                   data={"question_id": comment.id, "resolved_without_answer": True})
            _unpark_if_clear(db, auth, task)
    db.commit()
    db.refresh(comment)
    return comment


# --- acceptance criteria -----------------------------------------------------


@router.post("/{task_id}/criteria", response_model=CriterionOut, status_code=status.HTTP_201_CREATED)
def add_criterion(
    task_id: int,
    payload: CriterionCreate,
    db: DbSession,
    auth: Auth = Depends(require_scope("tasks:write")),
) -> Criterion:
    task = _get_task_or_404(db, task_id)
    _assert_visible(task, auth.user)
    _assert_worker(task, auth.user)
    if task.status in CLOSED_STATUSES:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="The task is closed")
    n = max((c.n for c in task.criteria), default=0) + 1
    criterion = Criterion(task_id=task.id, n=n, text=lint.clean(payload.text, field="text"))
    db.add(criterion)
    _touch(task)
    record(db, auth, task_id=task.id, event_type=EventType.criterion_added, data={"n": n})
    db.commit()
    db.refresh(criterion)
    return criterion


@router.patch("/{task_id}/criteria/{n}", response_model=CriterionOut)
def update_criterion(
    task_id: int,
    n: int,
    payload: CriterionUpdate,
    db: DbSession,
    auth: Auth = Depends(require_scope("tasks:write")),
) -> Criterion:
    task = _get_task_or_404(db, task_id)
    user = auth.user
    _assert_visible(task, user)
    _assert_worker(task, user)
    criterion = next((c for c in task.criteria if c.n == n), None)
    if criterion is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"No criterion {n} on this task")

    change: dict = {"n": n}
    if payload.text is not None and payload.text != criterion.text:
        criterion.text = lint.clean(payload.text, field="text")
        change["text_changed"] = True
    if payload.evidence is not None:
        criterion.evidence = lint.clean(payload.evidence, field="evidence")
        change["evidence"] = True
    if payload.state is not None and payload.state is not criterion.state:
        if payload.state is CriterionState.dropped and not (criterion.evidence or "").strip():
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="Say why in 'evidence' to drop a criterion",
            )
        if payload.state is CriterionState.met and not (criterion.evidence or "").strip():
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="Evidence is required to mark a criterion met: the command and its result, a commit or a PR link",
            )
        change["state"] = [criterion.state.value, payload.state.value]
        criterion.state = payload.state
        criterion.checked_by = user.id
        criterion.checked_kind = auth.kind
        criterion.checked_at = utcnow()

    if len(change) > 1:
        _touch(task)
        record(db, auth, task_id=task.id, event_type=EventType.criterion_changed, data=change)
    db.commit()
    db.refresh(criterion)
    return criterion


# --- git links and deploy state -----------------------------------------------


@router.post("/{task_id}/git", response_model=GitLinkOut, status_code=status.HTTP_201_CREATED)
def add_git_link(
    task_id: int,
    payload: GitLinkCreate,
    db: DbSession,
    auth: Auth = Depends(require_scope("git:write")),
) -> GitLink:
    """Link a branch, PR or commit. Linking the same ref again updates it."""
    task = _get_task_or_404(db, task_id)
    _assert_visible(task, auth.user)
    _assert_worker(task, auth.user)
    title = lint.clean(payload.title, field="title")
    ref = payload.ref.strip()
    link = db.scalar(
        select(GitLink).where(
            GitLink.task_id == task.id,
            GitLink.repo == payload.repo,
            GitLink.kind == payload.kind,
            GitLink.ref == ref,
        )
    )
    now = utcnow()
    if link is None:
        link = GitLink(
            task_id=task.id,
            repo=payload.repo,
            kind=payload.kind,
            ref=ref,
            url=payload.url,
            title=title,
            state=payload.state,
            actor_kind=auth.kind,
            added_by=auth.user.id,
            created_at=now,
            updated_at=now,
        )
        db.add(link)
    else:
        link.url = payload.url or link.url
        link.title = title or link.title
        link.state = payload.state or link.state
        link.updated_at = now
    record(
        db,
        auth,
        task_id=task.id,
        event_type=EventType.git_linked,
        data={"repo": payload.repo, "kind": payload.kind.value, "ref": ref, "state": payload.state},
    )
    db.commit()
    db.refresh(link)
    return link


@router.patch("/{task_id}/deploy", response_model=TaskDetailOut)
def set_deploy_state(
    task_id: int,
    payload: DeployUpdate,
    db: DbSession,
    auth: Auth = Depends(require_scope("tasks:write")),
) -> TaskDetailOut:
    task = _get_task_or_404(db, task_id)
    _assert_visible(task, auth.user)
    _assert_worker(task, auth.user)
    old = task.deploy_state
    task.deploy_state = payload.state
    task.deploy_note = lint.clean(payload.note, field="note")
    task.deployed_at = utcnow() if payload.state is not DeployState.none else None
    _touch(task)
    record(
        db,
        auth,
        task_id=task.id,
        event_type=EventType.deployed,
        data={"from": old.value, "to": payload.state.value, "note": task.deploy_note},
    )
    db.commit()
    return _detail(_get_task_or_404(db, task.id))
