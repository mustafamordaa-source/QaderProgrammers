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

from pydantic import ValidationError

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from sqlalchemy import and_, func, or_, select, update
from sqlalchemy.orm import Session, selectinload

from app import lint
from app.config import settings
from app.deps import Auth, AuthCtx, DbSession, require_leader, require_scope
from app.events import record
from app.paging import Page
from app.models import (
    CLOSED_STATUSES,
    AccountType,
    ActorKind,
    Comment,
    CommentKind,
    Criterion,
    CriterionState,
    Priority,
    DeployState,
    EventType,
    GitLink,
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
    DecisionQuestion,
    FacetsOut,
    PersonOn,
    TakePartRequest,
    DeployUpdate,
    ImportRequest,
    ImportResult,
    ImportTask,
    GitLinkCreate,
    GitLinkOut,
    InboxItem,
    RejectRequest,
    StatusChangeRequest,
    TaskAssign,
    TaskBrief,
    TaskCreate,
    TaskLinkCreate,
    TaskLinkOut,
    TaskRef,
    TemplateOut,
    SplitRequest,
    TaskDetailOut,
    TaskEventOut,
    TaskOut,
    TaskUpdate,
)
from app.notify import by_handles, leads, mentioned_handles, notify
from app.models import Area, LinkKind, Notification, NotifyKind, TaskKind, TaskLink
from app import templates
from app.routers.areas import (
    area_and_children_ids, clear_pick, find_similar, resolve_area, similar_tasks, suggest_areas,
)
from app.schemas import SimilarOut, SimilarRequest
from app.similarity import DUPLICATE, RELATED, Doc
from app.transitions import PARKABLE, PARKING, TransitionError, check_rejection, check_transition

router = APIRouter(prefix="/tasks", tags=["tasks"])

S = TaskStatus

# Headings a hand-back must carry. The full template is in the agent skill.
HANDBACK_REQUIRED = ("Summary:", "Checks run:", "Left:")


# --- helpers ------------------------------------------------------------------


def _people(db: Session, ids) -> list[User]:
    return [u for u in (db.get(User, i) for i in ids if i is not None) if u is not None]


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


TASK_REF_RE = re.compile(r"(?:hub[-\s]?|#)?(\d{1,9})", re.IGNORECASE)


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
    return task.open_to_side and task.claimed_by == user.id and task.claim_is_live(utcnow())


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


def _out(task: Task, model=TaskOut, user: User | None = None, **extra):
    row = model.model_validate(task)
    row.criteria_total, row.criteria_open, row.open_questions = _counts(task)
    row.blocked_by = task.open_blockers()
    row.children_total = len(task.children)
    row.children_open = sum(1 for c in task.children if c.status not in CLOSED_STATUSES)
    row.lane = LANES.get(task.status)
    row.people = _people_on(task)
    row.parts_total = row.criteria_total
    row.parts_taken = sum(1 for c in task.criteria if _part_holder(c) is not None)
    if user is not None:
        now = utcnow()
        code, text = _claim_block(task, user, now)
        mine = task.claim_is_live(now) and task.claimed_by == user.id
        row.claimable = code is None and not mine
        row.claim_block, row.claim_block_text = (None, None) if mine else (code, text)
    for key, value in extra.items():
        setattr(row, key, value)
    return row


def _detail(task: Task, user: User | None = None) -> TaskDetailOut:
    from app.routers.docs import doc_meta

    row = _out(task, TaskDetailOut, user)
    if user is not None:
        for out, criterion in zip(row.criteria, task.criteria):
            holder = _part_holder(criterion)
            out.subtask = _ref(holder) if holder is not None else None
            out.take_block_text = _take_block(task, criterion, user)
            out.can_take = out.take_block_text is None
    row.docs = [doc_meta(d) for d in task.docs]
    row.files = [FileOut.model_validate(f) for f in task.files if f.removed_at is None]
    row.context = [ContextOut.model_validate(c) for c in task.context]
    row.parent = TaskRef.model_validate(task.parent) if task.parent else None
    row.children = [_ref(c) for c in task.children]
    row.links = _links_out(task)
    return row


def _ref(task: Task) -> TaskRef:
    """A subtask line for the parent's roster: side, people, claim, status."""
    ref = TaskRef.model_validate(task)
    ref.assignees = [u.handle or u.name for u in (task.assignee_1, task.assignee_2) if u]
    ref.blocked_by = task.open_blockers()
    if task.claim_is_live(utcnow()) and task.claimer:
        holder = task.claimer.handle or task.claimer.name
        ref.claim_holder = f"{holder} (agent {task.claim_agent})" if task.claim_agent else holder
    return ref


SIDE_LABELS = {
    "fe": "Frontend", "be": "Backend", "mobile": "Mobile", "content": "Content",
    "infra": "Infra", "qa": "QA", "design": "Design", "other": "Other",
}

# Where a claimable task comes from: planned by a lead (to_do) or the backlog.
LANES = {S.to_do: "planned", S.backlog: "backlog"}
# A claim may start from these; claiming moves the task to in_progress.
CLAIM_FROM = {S.backlog, S.to_do, S.in_progress}
PRIORITY_RANK = {"urgent": 0, "high": 1, "medium": 2, "low": 3}


def _handle(u: User) -> str:
    return u.handle or u.name


def _claim_block(task: Task, user: User, now) -> tuple[str | None, str | None]:
    """Why `user` cannot claim `task` now, as (code, sentence); (None, None) when they can."""
    if user.is_read_only:
        return "viewer", "Viewer accounts are read-only"
    st = task.status
    if st is S.proposed:
        return "proposed", "A lead has not accepted this proposal yet"
    if st is S.in_review:
        return "in_review", "The work is in review"
    if st is S.needs_confirm:
        return "waiting_decision", "Waiting for a decision from a lead"
    if st is S.blocked:
        return "blocked", "Parked as blocked; read the task for the reason"
    if st not in CLAIM_FROM:
        return "closed", f"The task is {st.value.replace('_', ' ')}"
    # Who may take it comes before what it waits on.
    if not (user.is_lead or user.id in task.assignee_ids):
        if task.assign_only:
            return "assign_only", "A lead assigns this one to a chosen person"
        if not task.open_to_side:
            return "not_pool", "Assigned to someone else: ask a lead before you take it"
        if task.side is not None and user.sides and task.side.value not in user.sides:
            sides = ", ".join(SIDE_LABELS.get(x, x) for x in user.sides)
            return "other_side", f"{SIDE_LABELS[task.side.value]} work; your profile lists {sides}"
    blockers = task.open_blockers()
    if blockers:
        return "blocked_by", "Waits for " + ", ".join(f"HUB-{b}" for b in blockers)
    if task.claim_is_live(now) and task.claimed_by != user.id:
        holder = _handle(task.claimer) if task.claimer else "someone"
        return "claimed", f"Claimed by {holder} until {task.claim_expires_at:%Y-%m-%d %H:%M}Z"
    if not user.is_lead and _parts_held_by_others(task, user, now):
        return "parts_taken", "Others are working on its parts; take a free part instead"
    return None, None


def _parts_held_by_others(task: Task, user: User, now) -> bool:
    for c in task.criteria:
        sub = _part_holder(c)
        if sub is not None and sub.status not in CLOSED_STATUSES and sub.claim_is_live(now) and sub.claimed_by != user.id:
            return True
    return False


def _claim_origin(task: Task) -> TaskStatus | None:
    """Where the current claim started the task from (backlog or to_do), if a claim started it."""
    for e in sorted(task.events, key=lambda e: e.id or 0, reverse=True):
        if e.event_type is EventType.status_changed and e.to_status is S.in_progress:
            if (e.comment or "").startswith("Claimed") and e.from_status in (S.backlog, S.to_do):
                return e.from_status
            return None
    return None


def _part_holder(criterion: Criterion) -> Task | None:
    """The live subtask made from this part, if someone took it (a dropped one frees it)."""
    sub = criterion.subtask
    if sub is None or sub.status is S.dropped:
        return None
    return sub


def _take_block(task: Task, criterion: Criterion, user: User) -> str | None:
    """Why `user` cannot take this part now; None when they can."""
    if user.is_read_only:
        return "Viewer accounts are read-only"
    if user.is_bot:
        return "Bots cannot take parts"
    if task.parent_id is not None:
        return "This is already a subtask; claim it instead"
    if criterion.state is not CriterionState.open:
        return f"This part is {criterion.state.value}"
    holder = _part_holder(criterion)
    if holder is not None:
        who = _handle(holder.claimer) if holder.claim_is_live(utcnow()) and holder.claimer else None
        return f"Taken in HUB-{holder.id}" + (f" by {who}" if who else "")
    if task.status not in CLAIM_FROM:
        code, text = _claim_block(task, user, utcnow())
        return text or "The task cannot take new work now"
    if not user.is_lead and task.claim_is_live(utcnow()) and task.claimed_by != user.id:
        who = _handle(task.claimer) if task.claimer else "someone"
        return f"{who} holds the whole task"
    blockers = task.open_blockers()
    if blockers:
        return "Waits for " + ", ".join(f"HUB-{b}" for b in blockers)
    if user.is_lead or user.id in task.assignee_ids:
        return None
    if task.assign_only:
        return "A lead assigns this one to a chosen person"
    if not task.open_to_side:
        return "Assigned to someone else: ask a lead before you take it"
    if task.side is not None and user.sides and task.side.value not in user.sides:
        sides = ", ".join(SIDE_LABELS.get(x, x) for x in user.sides)
        return f"{SIDE_LABELS[task.side.value]} work; your profile lists {sides}"
    return None


def _people_on(task: Task) -> list[PersonOn]:
    """Everyone on the task: its claim holder and assignees, then the people on its subtasks."""
    now = utcnow()
    out: list[PersonOn] = []
    seen: set[tuple[int, int]] = set()

    def add(u: User | None, role: str, task_id: int, part: int | None = None) -> None:
        if u is None or (u.id, task_id) in seen:
            return
        seen.add((u.id, task_id))
        out.append(PersonOn(handle=_handle(u), name=u.name, role=role, task_id=task_id, part=part))

    if task.claim_is_live(now):
        add(task.claimer, "claim", task.id)
    add(task.assignee_1, "assignee", task.id)
    add(task.assignee_2, "assignee", task.id)
    part_of = {c.subtask_id: c.n for c in task.criteria if c.subtask_id}
    for child in task.children:
        if child.status is S.dropped:
            continue
        part = part_of.get(child.id)
        if child.claim_is_live(now):
            add(child.claimer, "part", child.id, part)
        add(child.assignee_1, "part", child.id, part)
        add(child.assignee_2, "part", child.id, part)
    return out


def _mark_part_done(db: Session, auth: Auth, task: Task) -> None:
    """A subtask made from a part closes as done: mark that part met on the parent."""
    parent = task.parent
    if parent is None:
        return
    for c in parent.criteria:
        if c.subtask_id == task.id and c.state is CriterionState.open:
            c.state = CriterionState.met
            c.evidence = f"Done in HUB-{task.id}"
            c.checked_by = auth.user.id
            c.checked_kind = auth.kind
            c.checked_at = utcnow()
            record(db, auth, task_id=parent.id, event_type=EventType.criterion_changed,
                   data={"n": c.n, "state": ["open", "met"], "via": task.id})
            _touch(parent)


def _start_parent(db: Session, auth: Auth, task: Task) -> None:
    """The first subtask to start starts its parent too."""
    parent = task.parent
    if parent is not None and parent.status in (S.to_do, S.backlog):
        record(db, auth, task_id=parent.id, event_type=EventType.status_changed,
               from_status=parent.status, to_status=S.in_progress, comment=f"Subtask #{task.id} started")
        parent.status = S.in_progress
        _touch(parent)


def _tell_leads_when_family_closes(db: Session, auth: Auth, task: Task) -> None:
    parent = task.parent
    if parent is None or parent.status in CLOSED_STATUSES:
        return
    if all(c.status in CLOSED_STATUSES for c in parent.children):
        notify(db, auth, users=leads(db), task=parent, kind=NotifyKind.review,
               text=f"Every subtask of #{parent.id} is closed; it can be reviewed and closed.")


def _link_label(link: TaskLink, outgoing: bool) -> str:
    verb = {LinkKind.blocks: "blocks", LinkKind.relates: "relates to", LinkKind.duplicates: "duplicates"}[link.kind]
    if outgoing:
        return f"this task {verb} #{link.to_task_id}"
    return f"#{link.from_task_id} {verb} this task"


def _links_out(task: Task) -> list[TaskLinkOut]:
    out = []
    for link in task.outgoing_links:
        out.append(TaskLinkOut(id=link.id, kind=link.kind, direction="outgoing", label=_link_label(link, True),
                               other=TaskRef.model_validate(link.to_task), created_at=link.created_at))
    for link in task.incoming_links:
        out.append(TaskLinkOut(id=link.id, kind=link.kind, direction="incoming", label=_link_label(link, False),
                               other=TaskRef.model_validate(link.from_task), created_at=link.created_at))
    return out


def _check_parent(db: Session, task_id: int | None, parent_id: int, user: User) -> Task:
    """Two levels only: the parent has no parent, and the child has no children."""
    parent = db.get(Task, parent_id)
    if parent is None or not _can_see(parent, user):
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=f"parent_id: no task {parent_id}")
    if parent.id == task_id:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="A task cannot be its own parent")
    if parent.parent_id is not None:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"Task {parent.id} is itself a subtask; subtasks go two levels deep",
        )
    if task_id is not None and db.scalar(select(func.count(Task.id)).where(Task.parent_id == task_id)):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="This task has subtasks, so it cannot become a subtask",
        )
    if parent.status in CLOSED_STATUSES:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=f"Task {parent.id} is closed")
    return parent


def _refuse_if_blocked(task: Task) -> None:
    blockers = task.open_blockers()
    if blockers:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Blocked by open task " + ", ".join(f"#{b}" for b in blockers) + ". Finish or unlink it first.",
        )


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


@router.post("/similar", response_model=SimilarOut)
def similar(
    payload: SimilarRequest,
    db: DbSession,
    auth: Auth = Depends(require_scope("tasks:read")),
) -> SimilarOut:
    """Tasks that look like this text (open, done or dropped), best first, with a
    0-100 score and band, plus the areas the text fits. Nothing is written."""
    return similar_tasks(payload, db, auth)


@router.post("", response_model=TaskDetailOut, status_code=status.HTTP_201_CREATED)
def create_task(
    payload: TaskCreate,
    db: DbSession,
    response: Response,
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
        if payload.restricted or payload.pool or payload.assign_only:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Only a leader marks a task restricted, pool or assign-only",
            )
    _validate_assignees(db, payload.assignee_1_id, payload.assignee_2_id)

    missing = templates.missing_sections(payload.kind, payload.description)
    if missing:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=(
                f"A {payload.kind.value} needs these headings with text in the description: "
                + ", ".join(missing) + ". GET /tasks/templates shows the skeleton."
            ),
        )
    if payload.parent_id is not None:
        _check_parent(db, None, payload.parent_id, user)

    if payload.fingerprint:
        existing = db.scalar(
            select(Task).where(
                Task.fingerprint == payload.fingerprint, Task.status.not_in(list(CLOSED_STATUSES))
            )
        )
        if existing is not None:
            # Same problem again: note it on the open task instead of a copy.
            record(db, auth, task_id=existing.id, event_type=EventType.seen_again,
                   data={"title": lint.clean(payload.title, field="title")})
            db.commit()
            if not _can_see(existing, user):
                raise HTTPException(status_code=status.HTTP_409_CONFLICT,
                                    detail="An open task already tracks this fingerprint")
            out = _detail(_get_task_or_404(db, existing.id), auth.user)
            out.duplicate_of_existing = True
            response.status_code = status.HTTP_200_OK  # nothing new was created
            return out
        recent = db.scalar(
            select(Task).where(
                Task.fingerprint == payload.fingerprint,
                Task.status == S.dropped,
                Task.updated_at >= utcnow() - timedelta(days=90),
            )
        )
        if recent is not None:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=(
                    f"Task {recent.id} with this fingerprint was dropped on "
                    f"{recent.updated_at:%Y-%m-%d} ({recent.drop_reason or 'no reason'}); "
                    "it is not filed again for 90 days."
                ),
            )

    area = resolve_area(db, payload.area) if payload.area else None
    exclude: set[int] = set()
    if payload.parent_id is not None:
        # A subtask is meant to resemble its parent and its siblings.
        exclude = {payload.parent_id} | set(db.scalars(select(Task.id).where(Task.parent_id == payload.parent_id)))
    similar_out = SimilarOut()
    if payload.check_similar:
        similar_out = find_similar(
            db, user, title=payload.title, description=payload.description, criteria=payload.criteria,
            area_id=area.id if area else None, exclude_ids=exclude, limit=5,
        )
        dup = next((m for m in similar_out.matches if m.score >= DUPLICATE), None)
        if dup is not None and not (payload.duplicate_reason or "").strip():
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail={
                "message": (
                    f"This looks like task {dup.id} ({dup.score}% alike, {dup.status.value}): {dup.title}. "
                    "Add to that task instead, or send duplicate_reason saying how this one differs."
                ),
                "similar": [m.model_dump(mode="json") for m in similar_out.matches],
            })
    elif payload.auto_area and area is None:
        query = Doc(0, payload.title, "\n".join([payload.description or ""] + list(payload.criteria)))
        similar_out = SimilarOut(suggested_areas=suggest_areas(db, query, [], {}))
    area_auto = False
    if area is None and payload.auto_area:
        pick = clear_pick(similar_out.suggested_areas)
        if pick is not None:
            area = db.get(Area, pick.area.id)
            area_auto = True

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
        assign_only=bool(payload.assign_only),
        created_kind=auth.kind,
        created_agent=auth.agent,
        kind=payload.kind,
        parent_id=payload.parent_id,
        fingerprint=payload.fingerprint,
        area_id=area.id if area else None,
    )
    db.add(task)
    db.flush()  # assign task.id before logging the event

    criteria = payload.criteria or (
        templates.TEMPLATES[payload.kind]["criteria"] if payload.use_template else []
    )
    for n, text in enumerate(criteria, start=1):
        db.add(Criterion(task_id=task.id, n=n, text=lint.clean(text, field=f"criterion {n}")))

    related = [m for m in similar_out.matches if m.score >= RELATED][:3]
    created_data = {}
    if related:
        created_data["similar"] = [{"id": m.id, "score": m.score} for m in related]
    if (payload.duplicate_reason or "").strip() and any(m.score >= DUPLICATE for m in related):
        created_data["duplicate_reason"] = lint.clean(payload.duplicate_reason, field="duplicate_reason")
    if area_auto:
        created_data["area_auto"] = area.slug
    record(
        db,
        auth,
        task_id=task.id,
        event_type=EventType.created,
        to_status=start,
        timestamp=task.created_at,
        data=created_data or None,
    )
    for m in related:
        db.add(TaskLink(from_task_id=task.id, to_task_id=m.id, kind=LinkKind.relates,
                        created_by=user.id, actor_kind=auth.kind, created_at=utcnow()))
        record(db, auth, task_id=m.id, event_type=EventType.linked,
               data={"kind": LinkKind.relates.value, "from": task.id, "score": m.score})
    db.flush()
    if start is S.proposed:
        notify(db, auth, users=leads(db), task=task, kind=NotifyKind.proposal, text=task.title)
    else:
        notify(db, auth, users=_people(db, task.assignee_ids), task=task,
               kind=NotifyKind.assigned, text=task.summary or task.description)
    notify(db, auth, users=by_handles(db, mentioned_handles(task.description)), task=task,
           kind=NotifyKind.mention, text=task.description)
    db.commit()
    out = _detail(_get_task_or_404(db, task.id), auth.user)
    out.similar = similar_out.matches
    out.suggested_areas = similar_out.suggested_areas
    out.area_auto = area_auto
    return out


@router.get("", response_model=list[TaskOut])
def list_tasks(
    auth: AuthCtx,
    db: DbSession,
    response: Response,
    paging: Page,
    status_filter: TaskStatus | None = None,
    statuses: str | None = Query(
        default=None, max_length=200, description="Several statuses, comma-separated (for example blocked,needs_confirm)"
    ),
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
    kind: TaskKind | None = None,
    parent_id: int | None = None,
    pool: bool | None = None,
    my_sides: bool = Query(default=False, description="Only tasks on a side in your Works on"),
    area: str | None = Query(default=None, max_length=60, description="Area slug; includes its sub-areas"),
    awaiting_decision: bool = Query(
        default=False, description="Only tasks with an open question addressed to you (see `to`)"
    ),
    to: str | None = Query(
        default=None, pattern=r"^(me|leads)$",
        description="With awaiting_decision: 'me' (default) or, for a lead, 'leads' for questions to any lead",
    ),
    sort: str = Query(default="created", pattern=r"^(created|updated)$", description="Newest created or newest changed first"),
    limit: int = Query(default=500, ge=1, le=1000, description="Used only when neither page nor page_size is sent"),
    lane: str | None = Query(default=None, pattern=r"^(planned|backlog)$",
                             description="planned = to_do, backlog = backlog"),
    priority: str | None = Query(default=None, max_length=60, description="Comma list, for example urgent,high"),
    kinds: str | None = Query(default=None, max_length=120, description="Comma list, for example bug,feature"),
    subtasks: str = Query(default="all", pattern=r"^(all|top|only)$",
                          description="top hides subtasks, only shows just subtasks"),
    claimable: bool = Query(default=False, description="Only tasks you can claim now"),
) -> list[TaskOut]:
    """Tasks you can see, newest first. Send `page` and/or `page_size` to read a
    page at a time; the totals come back in the X-Total-* headers.

    `ready=true` lists what you can claim now, from the plan (to_do) and the
    backlog: planned first, then by priority, then oldest first."""
    if not auth.has("tasks:read"):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="This API token lacks the 'tasks:read' scope")
    user = auth.user
    now = utcnow()
    stmt = _filtered(
        db, user, now, status_filter=status_filter, statuses=statuses, assignee_id=assignee_id, side=side,
        mine=mine, ready=ready, q=q, include_closed=include_closed, created_kind=created_kind,
        created_by=created_by, from_bots=from_bots, kind=kind, parent_id=parent_id, pool=pool,
        my_sides=my_sides, area=area, lane=lane, priority=priority, kinds=kinds, subtasks=subtasks,
    )
    asked_ids = _asked_ids(db, user, awaiting_decision, to)
    if awaiting_decision:
        stmt = stmt.where(Task.id.in_(
            select(Comment.task_id).where(
                Comment.kind == CommentKind.question,
                Comment.resolved_at.is_(None),
                Comment.to_user_id.in_(asked_ids),
            )
        ))

    # The id breaks ties, so two pages never share a row.
    order = (Task.updated_at.desc(), Task.id.desc()) if sort == "updated" else (Task.created_at.desc(), Task.id.desc())
    rows_stmt = stmt.options(selectinload(Task.criteria), selectinload(Task.comments),
                             selectinload(Task.children), selectinload(Task.incoming_links)).order_by(*order)

    if tag or ready or claimable:
        # Tags are a JSON list, blockers follow links and the claim rules need the
        # person: all three are checked in Python.
        matched = [
            t for t in db.scalars(rows_stmt).unique()
            if (not tag or tag in (t.tags or []))
            and (not (ready or claimable) or _claim_block(t, user, now)[0] is None)
            and (not (ready or claimable) or not (t.claim_is_live(now) and t.claimed_by == user.id))
        ]
        if ready:
            matched.sort(key=lambda t: (t.status is not S.to_do, PRIORITY_RANK.get(t.priority.value, 9), t.created_at, t.id))
        if paging.on:
            tasks = paging.slice(matched, response, X_Total_Points=sum(t.points or 0 for t in matched))
        else:
            tasks = matched[:limit]
    elif paging.on:
        sub = stmt.with_only_columns(Task.id, Task.points).order_by(None).subquery()
        total, points = db.execute(
            select(func.count(), func.coalesce(func.sum(sub.c.points), 0)).select_from(sub)
        ).one()
        paging.set_headers(response, total, X_Total_Points=points)
        tasks = list(db.scalars(paging.window(rows_stmt)).unique())
    else:
        tasks = list(db.scalars(rows_stmt.limit(limit)).unique())

    rows = [_out(t, user=user) for t in tasks]
    if awaiting_decision:
        for row, task in zip(rows, tasks):
            row.decision_questions = [
                DecisionQuestion(
                    comment_id=c.id,
                    to=(c.to_user.handle or c.to_user.name) if c.to_user else None,
                    author=_who(c),
                    text=c.body[:2_000],
                    at=c.created_at,
                )
                for c in task.comments
                if c.kind is CommentKind.question and c.resolved_at is None and c.to_user_id in asked_ids
            ]
    return rows


def _comma(value: str | None, enum_cls, what: str) -> list:
    out = []
    for name in (value or "").split(","):
        if not name.strip():
            continue
        try:
            out.append(enum_cls(name.strip()))
        except ValueError:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                                detail=f"{what}: no value '{name.strip()}'") from None
    return out


def _asked_ids(db: Session, user: User, awaiting_decision: bool, to: str | None) -> list[int]:
    if not awaiting_decision:
        return []
    if to == "leads":
        if not user.is_lead:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN,
                                detail="Only a lead lists the questions asked of every lead")
        return sorted({user.id, *(u.id for u in leads(db))})
    return [user.id]


def _filtered(
    db: Session, user: User, now, *, status_filter=None, statuses=None, assignee_id=None, side=None,
    mine=False, ready=False, q=None, include_closed=True, created_kind=None, created_by=None,
    from_bots=False, kind=None, parent_id=None, pool=None, my_sides=False, area=None, lane=None,
    priority=None, kinds=None, subtasks="all",
):
    """The SQL part of the task filters, shared by the list and the facets."""
    stmt = select(Task)
    visible = _visible_filter(user)
    if visible is not None:
        stmt = stmt.where(visible)

    mine_filter = or_(Task.assignee_1_id == user.id, Task.assignee_2_id == user.id)
    if mine:
        stmt = stmt.where(or_(mine_filter, Task.claimed_by == user.id))
    elif assignee_id is not None:
        stmt = stmt.where(or_(Task.assignee_1_id == assignee_id, Task.assignee_2_id == assignee_id))

    if ready:
        # Free work from the plan and the backlog; the claim rules finish the check in Python.
        stmt = stmt.where(
            Task.status.in_([S.to_do, S.backlog]),
            or_(Task.claimed_by.is_(None), Task.claim_expires_at <= now),
        )
        if not user.is_lead:
            stmt = stmt.where(or_(mine_filter, Task.open_to_side))
    if lane:
        stmt = stmt.where(Task.status == (S.to_do if lane == "planned" else S.backlog))
    wanted_priorities = _comma(priority, Priority, "priority")
    if wanted_priorities:
        stmt = stmt.where(Task.priority.in_(wanted_priorities))
    wanted_kinds = _comma(kinds, TaskKind, "kinds")
    if wanted_kinds:
        stmt = stmt.where(Task.kind.in_(wanted_kinds))
    if subtasks == "top":
        stmt = stmt.where(Task.parent_id.is_(None))
    elif subtasks == "only":
        stmt = stmt.where(Task.parent_id.is_not(None))

    wanted_statuses: list[TaskStatus] = []
    for name in (statuses or "").split(","):
        if not name.strip():
            continue
        try:
            wanted_statuses.append(TaskStatus(name.strip()))
        except ValueError:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                                detail=f"statuses: no status '{name.strip()}'") from None
    if status_filter is not None:
        stmt = stmt.where(Task.status == status_filter)
    elif wanted_statuses:
        stmt = stmt.where(Task.status.in_(wanted_statuses))
    elif not include_closed:
        stmt = stmt.where(Task.status.not_in(list(CLOSED_STATUSES)))
    if side:
        wanted_sides = [x.strip() for x in side.split(",") if x.strip()]
        stmt = stmt.where(Task.side.in_(wanted_sides))
    if created_kind is not None:
        stmt = stmt.where(Task.created_kind == created_kind)
    if created_by is not None:
        stmt = stmt.where(Task.created_by == created_by)
    if from_bots:
        bot_ids = select(User.id).where(User.account_type == AccountType.bot)
        stmt = stmt.where(Task.created_by.in_(bot_ids))
    if kind is not None:
        stmt = stmt.where(Task.kind == kind)
    if parent_id is not None:
        stmt = stmt.where(Task.parent_id == parent_id)
    if pool is not None:
        stmt = stmt.where(Task.open_to_side if pool else ~Task.open_to_side)
    if my_sides:
        stmt = stmt.where(Task.side.in_(list(user.sides or [])))
    if area:
        stmt = stmt.where(Task.area_id.in_(area_and_children_ids(db, resolve_area(db, area))))
    if q:
        like = f"%{q.strip()}%"
        found = [Task.title.ilike(like), Task.description.ilike(like), Task.summary.ilike(like)]
        # "HUB-12", "hub12", "#12" or "12" also finds task 12 itself.
        by_id = TASK_REF_RE.fullmatch(q.strip())
        if by_id:
            found.append(Task.id == int(by_id.group(1)))
        stmt = stmt.where(or_(*found))
    return stmt


@router.get("/facets", response_model=FacetsOut)
def facets(
    auth: AuthCtx,
    db: DbSession,
    status_filter: TaskStatus | None = None,
    statuses: str | None = Query(default=None, max_length=200),
    assignee_id: int | None = None,
    side: str | None = None,
    tag: str | None = None,
    mine: bool = False,
    ready: bool = False,
    q: str | None = Query(default=None, max_length=100),
    include_closed: bool = True,
    kind: TaskKind | None = None,
    parent_id: int | None = None,
    pool: bool | None = None,
    my_sides: bool = False,
    area: str | None = Query(default=None, max_length=60),
    created_kind: ActorKind | None = None,
    created_by: int | None = None,
    from_bots: bool = False,
    awaiting_decision: bool = False,
    to: str | None = Query(default=None, pattern=r"^(me|leads)$"),
    lane: str | None = Query(default=None, pattern=r"^(planned|backlog)$"),
    priority: str | None = Query(default=None, max_length=60),
    kinds: str | None = Query(default=None, max_length=120),
    subtasks: str = Query(default="all", pattern=r"^(all|top|only)$"),
    claimable: bool = False,
) -> FacetsOut:
    """Counts for the same filters as GET /tasks: by status, priority, kind,
    side, area and lane, plus how many you can claim. For filter chips and
    short agent summaries."""
    if not auth.has("tasks:read"):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="This API token lacks the 'tasks:read' scope")
    user = auth.user
    now = utcnow()
    stmt = _filtered(
        db, user, now, status_filter=status_filter, statuses=statuses, assignee_id=assignee_id, side=side,
        mine=mine, ready=ready, q=q, include_closed=include_closed, kind=kind, parent_id=parent_id,
        pool=pool, my_sides=my_sides, area=area, lane=lane, priority=priority, kinds=kinds, subtasks=subtasks,
        created_kind=created_kind, created_by=created_by, from_bots=from_bots,
    )
    stmt = stmt.options(selectinload(Task.criteria), selectinload(Task.children), selectinload(Task.incoming_links))
    if awaiting_decision:
        asked = _asked_ids(db, user, awaiting_decision, to)
        stmt = stmt.where(Task.id.in_(select(Comment.task_id).where(
            Comment.kind == CommentKind.question, Comment.resolved_at.is_(None), Comment.to_user_id.in_(asked),
        )))
    out = FacetsOut(total=0, status={}, priority={}, kind={}, side={}, area={}, lane={}, claimable=0, subtasks=0)

    def bump(bucket: dict, key) -> None:
        if key is not None:
            bucket[key] = bucket.get(key, 0) + 1

    for t in db.scalars(stmt).unique():
        if tag and tag not in (t.tags or []):
            continue
        free = _claim_block(t, user, now)[0] is None and not (t.claim_is_live(now) and t.claimed_by == user.id)
        if (ready or claimable) and not free:
            continue
        if ready and t.status not in LANES:
            continue
        out.total += 1
        # "Free to take" counts what the ready list shows: the plan and the backlog.
        out.claimable += free and t.status in LANES
        out.subtasks += t.parent_id is not None
        bump(out.status, t.status.value)
        bump(out.priority, t.priority.value)
        bump(out.kind, t.kind.value)
        bump(out.side, t.side.value if t.side else "none")
        bump(out.area, t.area.slug if t.area else "none")
        bump(out.lane, LANES.get(t.status))
    return out


@router.get("/inbox", response_model=list[InboxItem])
def inbox(auth: AuthCtx, db: DbSession, response: Response, paging: Page) -> list[InboxItem]:
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
        .order_by(Comment.created_at, Comment.id)
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
    for t in db.scalars(
        select(Task).where(mine, Task.status.in_([S.blocked, S.needs_confirm])).order_by(Task.updated_at, Task.id)
    ).unique():
        items.append(InboxItem(task_id=t.id, task_title=t.title, reason=t.status.value, at=t.updated_at))

    if user.is_lead:
        for t in db.scalars(
            select(Task).where(Task.status.in_([S.in_review, S.proposed])).order_by(Task.updated_at, Task.id)
        ).unique():
            reason = "review" if t.status is S.in_review else "triage"
            items.append(InboxItem(task_id=t.id, task_title=t.title, reason=reason, at=t.updated_at))
    return paging.slice(items, response) if paging.on else items


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
        if "assignee_1_id" in changes:
            notify(db, auth, users=_people(db, [task.assignee_1_id]), task=task,
                   kind=NotifyKind.assigned, text=task.summary or task.description)
        results.append(TriageResult(id=task_id, ok=True, status=payload.to))
    db.commit()
    return results


# --- bulk import --------------------------------------------------------------


def _import_auth(auth: AuthCtx) -> Auth:
    if not auth.has("tasks:create"):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN,
                            detail="This API token lacks the 'tasks:create' scope")
    if auth.user.is_bot or not auth.user.is_lead:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN,
                            detail="Only a lead or an admin imports tasks")
    return auth


def _error_text(exc: Exception) -> str:
    if isinstance(exc, ValidationError):
        return "; ".join(
            f"{'.'.join(str(p) for p in e['loc']) or 'task'}: {e['msg'].removeprefix('Value error, ')}"
            for e in exc.errors()
        )
    if isinstance(exc, HTTPException):
        detail = exc.detail
        return detail.get("message", str(detail)) if isinstance(detail, dict) else str(detail)
    return str(exc)


def _import_question(db: Session, auth: Auth, task: Task, body: str, to_user: User) -> None:
    """Ask `to_user` on the task and park it in needs_confirm, like a question with wait."""
    comment = Comment(
        task_id=task.id, author_id=auth.user.id, actor_kind=auth.kind, agent_name=auth.agent,
        kind=CommentKind.question, body=body, to_user_id=to_user.id,
    )
    db.add(comment)
    db.flush()
    task.comments.append(comment)
    from_status = task.status
    moved = task.status in PARKABLE
    if moved:
        task.resume_status = task.status
        task.status = S.needs_confirm
    record(
        db, auth, task_id=task.id, event_type=EventType.question_asked,
        from_status=from_status if moved else None,
        to_status=S.needs_confirm if moved else None,
        data={"comment_id": comment.id, "to": to_user.id, "import": True},
    )
    notify(db, auth, users=[to_user], task=task, kind=NotifyKind.question, text=body, comment_id=comment.id)


def _import_one(db: Session, auth: Auth, item: ImportTask, *, dry_run: bool) -> tuple[str, int | None]:
    """Create or update one imported task. Everything that can refuse the task
    runs before the first write, so a refused task leaves nothing behind."""
    key = lint.clean(item.external_key, field="external_key")
    fingerprint = f"ext:{key}"
    title = lint.clean(item.title, field="title")
    description = lint.clean(item.description, field="description")
    criteria = [lint.clean(c, field=f"criterion {n}") for n, c in enumerate(item.criteria, start=1)]
    question = lint.clean(item.question, field="question")
    area = resolve_area(db, item.area) if item.area else None
    to_user = _resolve_person(db, item.question_to) if question else None

    task = db.scalar(select(Task).where(Task.fingerprint == fingerprint).order_by(Task.id).limit(1))
    if task is None:
        if dry_run:
            return "created", None
        task = Task(
            title=title, description=description, priority=item.priority, status=item.status,
            created_by=auth.user.id, side=item.side, tags=item.tags or [], areas=[],
            restricted=item.restricted, pool=item.pool, assign_only=item.assign_only, created_kind=auth.kind, created_agent=auth.agent,
            kind=item.kind, fingerprint=fingerprint, area_id=area.id if area else None,
        )
        if item.points is not None:
            task.points = item.points
        db.add(task)
        db.flush()
        for n, text in enumerate(criteria, start=1):
            db.add(Criterion(task_id=task.id, n=n, text=text))
        record(db, auth, task_id=task.id, event_type=EventType.created, to_status=item.status,
               timestamp=task.created_at, data={"import": True, "external_key": key})
        if question:
            _import_question(db, auth, task, question, to_user)
        return "created", task.id

    # Update: only the fields this import sent; the status stays where the team put it.
    sent = item.model_fields_set
    wanted: dict[str, object] = {"title": title}
    if "description" in sent:
        wanted["description"] = description
    for field in ("kind", "priority", "side", "restricted", "points", "pool", "assign_only"):
        if field in sent and getattr(item, field) is not None:
            wanted[field] = getattr(item, field)
    if "tags" in sent:
        wanted["tags"] = item.tags or []
    if "area" in sent:
        wanted["area_id"] = area.id if area else None
    changed = {f: v for f, v in wanted.items() if getattr(task, f) != v}
    add_criteria = criteria if not task.criteria else []
    ask = bool(question) and not any(
        c.kind is CommentKind.question and c.body.strip() == question.strip() for c in task.comments
    )
    if not (changed or add_criteria or ask):
        return "unchanged", task.id
    if dry_run:
        return "updated", task.id

    if changed:
        data: dict[str, object] = {"import": True}
        for field, value in changed.items():
            old = getattr(task, field)
            if field == "description":
                data[field] = ["(changed)", "(changed)"]
            elif field == "area_id":
                data["area"] = [task.area.slug if task.area else None, area.slug if area else None]
            else:
                data[field] = [_plain(old), _plain(value)]
            setattr(task, field, value)
        record(db, auth, task_id=task.id, event_type=EventType.field_changed, data=data)
    for n, text in enumerate(add_criteria, start=1):
        db.add(Criterion(task_id=task.id, n=n, text=text))
        record(db, auth, task_id=task.id, event_type=EventType.criterion_added, data={"n": n, "import": True})
    if ask:
        _import_question(db, auth, task, question, to_user)
    _touch(task)
    return "updated", task.id


@router.post("/import", response_model=list[ImportResult])
def import_tasks(
    payload: ImportRequest,
    db: DbSession,
    auth: Auth = Depends(_import_auth),
) -> list[ImportResult]:
    """Create or update many tasks at once (leads and admins).

    Each task carries an `external_key`. The hub keeps it as the fingerprint
    `ext:<key>`, so sending the same batch again updates those tasks instead
    of adding copies. Every task is checked on its own: the answer has one row
    per task with `created`, `updated`, `unchanged` or `error`. With `dry_run`
    nothing is written. The similar-task check and the per-kind description
    headings do not apply to imports; the text checks do.
    """
    if len(payload.tasks) > settings.import_max_tasks:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"At most {settings.import_max_tasks} tasks per call; send the rest in another call.",
        )
    results: list[ImportResult] = []
    seen: set[str] = set()
    for raw in payload.tasks:
        raw_key = raw.get("external_key")
        key = raw_key if isinstance(raw_key, str) else None
        try:
            item = ImportTask.model_validate(raw)
            if item.external_key in seen:
                raise ValueError("external_key appears twice in this call")
            seen.add(item.external_key)
            action, task_id = _import_one(db, auth, item, dry_run=payload.dry_run)
            if not payload.dry_run:
                db.flush()
            results.append(ImportResult(external_key=item.external_key, action=action, id=task_id))
        except (ValidationError, HTTPException, ValueError) as exc:
            results.append(ImportResult(external_key=key, action="error", error=_error_text(exc)))
    # A dry run wrote nothing, so there is nothing to roll back.
    db.commit()
    return results


@router.get("/templates", response_model=list[TemplateOut])
def list_templates(auth: AuthCtx) -> list[dict]:
    """The skeleton, required headings and starter criteria for each task kind."""
    return templates.as_json()


@router.post("/{task_id}/split", response_model=TaskDetailOut, status_code=status.HTTP_201_CREATED)
def split_task(
    task_id: int,
    payload: SplitRequest,
    db: DbSession,
    auth: Auth = Depends(require_scope("tasks:create")),
) -> TaskDetailOut:
    """Split a task into one subtask per side (frontend, backend, content...).

    Each part copies the parent's priority, tags, areas and due date. A part
    with an assignee goes to that person; a part without one goes to the pool
    for its side, so anyone who works on that side can claim it. `order`
    makes one part wait for another (for example backend before frontend).
    A lead may split any task and assign parts; a member may split a task
    they work on, into pool parts only.
    """
    parent = _get_task_or_404(db, task_id)
    user = auth.user
    _assert_visible(parent, user)
    _assert_not_viewer(user)
    if user.is_bot:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Bots cannot split tasks")
    if not user.is_lead:
        _assert_worker(parent, user)
        if any(p.assignee_id for p in payload.parts):
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN,
                                detail="Only a lead assigns parts; leave assignee_id out to put them in the pool")
    if parent.parent_id is not None:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                            detail="This task is itself a subtask; subtasks go two levels deep")
    if parent.status in CLOSED_STATUSES or parent.status is S.proposed:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT,
                            detail=f"A {parent.status.value} task cannot be split")
    taken = {c.side for c in parent.children if c.side is not None and c.status not in CLOSED_STATUSES}
    clash = [p.side.value for p in payload.parts if p.side in taken]
    if clash:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT,
                            detail=f"An open subtask already covers: {', '.join(clash)}")
    for part in payload.parts:
        if part.assignee_id is not None:
            _validate_assignees(db, part.assignee_id, None)

    now = utcnow()
    by_side: dict = {}
    for part in payload.parts:
        label = SIDE_LABELS[part.side.value]
        child = Task(
            title=lint.clean(part.title or f"{parent.title} ({label})", field="title")[:200],
            description=lint.clean(
                part.description or f"{label} part of #{parent.id}. Read the parent task and its documents first.",
                field="description",
            ),
            priority=parent.priority,
            points=part.points or parent.points,
            status=S.to_do,
            due_date=parent.due_date,
            created_by=user.id,
            assignee_1_id=part.assignee_id,
            side=part.side,
            tags=list(parent.tags or []),
            areas=list(parent.areas or []),
            area_id=parent.area_id,
            restricted=parent.restricted,
            pool=part.assignee_id is None,
            created_kind=auth.kind,
            created_agent=auth.agent,
            parent_id=parent.id,
            created_at=now,
            updated_at=now,
        )
        db.add(child)
        db.flush()
        for n, text in enumerate(part.criteria, start=1):
            db.add(Criterion(task_id=child.id, n=n, text=lint.clean(text, field=f"criterion {n}")))
        record(db, auth, task_id=child.id, event_type=EventType.created, to_status=S.to_do, timestamp=now,
               data={"split_from": parent.id, "side": part.side.value})
        notify(db, auth, users=_people(db, [part.assignee_id]), task=child, kind=NotifyKind.assigned,
               text=child.description)
        by_side[part.side] = child

    for o in payload.order:
        before, after = by_side[o.before], by_side[o.after]
        db.add(TaskLink(from_task_id=before.id, to_task_id=after.id, kind=LinkKind.blocks,
                        created_by=user.id, actor_kind=auth.kind, created_at=now))
        record(db, auth, task_id=after.id, event_type=EventType.linked,
               data={"kind": "blocks", "from": before.id})

    record(db, auth, task_id=parent.id, event_type=EventType.field_changed,
           data={"split_into": {s.value: c.id for s, c in by_side.items()}})
    _touch(parent)
    db.commit()
    return _detail(_get_task_or_404(db, parent.id), auth.user)


@router.post("/{task_id}/links", response_model=TaskDetailOut, status_code=status.HTTP_201_CREATED)
def add_link(
    task_id: int,
    payload: TaskLinkCreate,
    db: DbSession,
    auth: Auth = Depends(require_scope("tasks:write")),
) -> TaskDetailOut:
    """Link this task to another: blocks, relates or duplicates."""
    task = _get_task_or_404(db, task_id)
    user = auth.user
    _assert_visible(task, user)
    other = db.get(Task, payload.to_task_id)
    if other is None or not _can_see(other, user):
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=f"to_task_id: no task {payload.to_task_id}")
    if other.id == task.id:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="A task cannot link to itself")
    if not (_is_worker(task, user) or _is_worker(other, user)):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Work on one of the two tasks to link them")
    if payload.kind is LinkKind.blocks:
        # No cycles: walk what `task` is blocked by; `other` must not be there.
        seen, todo = set(), [task.id]
        while todo:
            current = todo.pop()
            if current == other.id:
                raise HTTPException(status_code=status.HTTP_409_CONFLICT,
                                    detail=f"#{other.id} already waits on #{task.id}; that would be a loop")
            if current in seen:
                continue
            seen.add(current)
            todo += list(db.scalars(select(TaskLink.from_task_id).where(
                TaskLink.to_task_id == current, TaskLink.kind == LinkKind.blocks)))
    exists = db.scalar(select(TaskLink).where(
        TaskLink.from_task_id == task.id, TaskLink.to_task_id == other.id, TaskLink.kind == payload.kind))
    if exists is None:
        db.add(TaskLink(from_task_id=task.id, to_task_id=other.id, kind=payload.kind,
                        created_by=user.id, actor_kind=auth.kind, created_at=utcnow()))
        record(db, auth, task_id=task.id, event_type=EventType.linked,
               data={"kind": payload.kind.value, "to": other.id})
        record(db, auth, task_id=other.id, event_type=EventType.linked,
               data={"kind": payload.kind.value, "from": task.id})
        _touch(task)
        db.commit()
    return _detail(_get_task_or_404(db, task.id), auth.user)


@router.delete("/{task_id}/links/{link_id}", response_model=TaskDetailOut)
def remove_link(
    task_id: int,
    link_id: int,
    db: DbSession,
    auth: Auth = Depends(require_scope("tasks:write")),
) -> TaskDetailOut:
    task = _get_task_or_404(db, task_id)
    user = auth.user
    _assert_visible(task, user)
    link = db.get(TaskLink, link_id)
    if link is None or task.id not in (link.from_task_id, link.to_task_id):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Link not found")
    if not (_is_worker(link.from_task, user) or _is_worker(link.to_task, user)):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Work on one of the two tasks to unlink them")
    data = {"kind": link.kind.value, "from": link.from_task_id, "to": link.to_task_id}
    db.delete(link)
    record(db, auth, task_id=task.id, event_type=EventType.unlinked, data=data)
    _touch(task)
    db.commit()
    return _detail(_get_task_or_404(db, task.id), auth.user)


@router.get("/{task_id}", response_model=TaskDetailOut)
def get_task(task_id: int, auth: AuthCtx, db: DbSession) -> TaskDetailOut:
    task = _get_task_or_404(db, task_id)
    _assert_visible(task, auth.user)
    return _detail(task, auth.user)


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
        holder = _part_holder(c)
        if holder is not None:
            who = _handle(holder.claimer) if holder.claim_is_live(utcnow()) and holder.claimer else None
            taken = f" [taken in HUB-{holder.id} {holder.status.value}" + (f" by @{who}" if who else "") + "]"
        else:
            taken = ""
        criteria.append(f"{c.n}. [{c.state.value}]{taken} {text}")

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
    now = utcnow()
    code, text = _claim_block(task, auth.user, now)
    if task.claim_is_live(now) and task.claimed_by == auth.user.id:
        claimable, code, text = False, None, None
    else:
        claimable = code is None
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
        kind=task.kind.value,
        parent=f"#{task.parent.id} {task.parent.title[:80]}" if task.parent else None,
        children=[f"#{c.id} [{c.status.value}] {c.title[:60]}" for c in task.children[:10]],
        blocked_by=[f"#{b}" for b in task.open_blockers()],
        links=[link.label for link in _links_out(task)][:10],
        truncated=truncated,
        claimable=claimable,
        claim_block=code,
        claim_block_text=text,
        people=[
            f"@{p.handle} " + ("whole task" if p.role == "claim" else "assigned" if p.role == "assignee"
                                else (f"part {p.part} " if p.part else "") + f"via HUB-{p.task_id}")
            for p in _people_on(task)
        ][:12],
        parts=f"{sum(1 for c in task.criteria if _part_holder(c) is not None)}/{len(task.criteria)} taken",
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

_WORKER_FIELDS = {"summary", "tags", "areas", "side", "area"}
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

    if "parent_id" in fields:
        new_parent = fields["parent_id"] or None
        fields["parent_id"] = new_parent
        if new_parent is not None:
            _check_parent(db, task.id, new_parent, user)

    changes: dict[str, list] = {}
    if "area" in fields:
        ref = fields.pop("area")
        new_area = resolve_area(db, ref) if ref else None
        if (new_area.id if new_area else None) != task.area_id:
            changes["area"] = [task.area.slug if task.area else None, new_area.slug if new_area else None]
            task.area_id = new_area.id if new_area else None
    for field, value in fields.items():
        if field in _LINTED:
            value = lint.clean(value, field=field)
        if field in {"restricted", "pool", "assign_only"} and value is None:
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
    return _detail(_get_task_or_404(db, task.id), auth.user)


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
    if (from_status is S.in_progress and target is S.to_do and not user.is_lead
            and _claim_origin(task) is S.backlog):
        # Planning is a lead's call: work claimed from the backlog goes back there.
        target = S.backlog
    comment = lint.clean(payload.comment, field="comment")
    now = utcnow()

    if target is S.in_progress and from_status is not S.in_review:
        _refuse_if_blocked(task)
    if target is S.done:
        open_children = [c.id for c in task.children if c.status not in CLOSED_STATUSES]
        if open_children:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Subtasks still open: " + ", ".join(f"#{c}" for c in open_children),
            )
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

    if target is S.in_progress:
        _start_parent(db, auth, task)
    if target is S.done:
        _mark_part_done(db, auth, task)
    if target in CLOSED_STATUSES:
        db.flush()
        _tell_leads_when_family_closes(db, auth, task)
    workers = _people(db, task.assignee_ids)
    if target is S.in_review:
        notify(db, auth, users=leads(db), task=task, kind=NotifyKind.review, text=task.summary or comment)
    elif from_status is S.in_review and target is S.done:
        notify(db, auth, users=workers, task=task, kind=NotifyKind.approved, text=comment)
    elif from_status is S.in_review and target is S.in_progress:
        notify(db, auth, users=workers, task=task, kind=NotifyKind.rejected, text=comment)
    db.commit()
    return _detail(_get_task_or_404(db, task.id), auth.user)


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
    new_people = [i for i in task.assignee_ids if i not in before]
    notify(db, auth, users=_people(db, new_people), task=task, kind=NotifyKind.assigned, text=task.summary or task.description)
    db.commit()
    return _detail(_get_task_or_404(db, task.id), auth.user)


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
    notify(db, auth, users=_people(db, task.assignee_ids), task=task,
           kind=NotifyKind.rejected, text=payload.comment)
    db.commit()
    return _detail(_get_task_or_404(db, task.id), auth.user)


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

    _refuse_claim(task, user)
    out, warnings = _claim(db, auth, task, payload.agent, payload.ttl_hours, payload.branch)
    db.commit()
    return _out(_get_task_or_404(db, task.id), ClaimOut, user, warnings=warnings)


def _refuse_claim(task: Task, user: User) -> None:
    """Raise with the reason when `user` may not claim `task`; a live claim of
    someone else is left to the race-safe update in `_claim`."""
    code, text = _claim_block(task, user, utcnow())
    if code is None or code == "claimed":
        return
    forbidden = {"viewer", "not_pool", "other_side", "assign_only"}
    raise HTTPException(
        status_code=status.HTTP_403_FORBIDDEN if code in forbidden else status.HTTP_409_CONFLICT,
        detail=text,
        headers={"X-Claim-Block": code},
    )


def _claim(db: Session, auth: Auth, task: Task, agent_name: str | None, ttl_hours: float | None,
           branch: str | None):
    """Take or renew the lease; moves a backlog or to_do task to in_progress.
    Does not commit. Returns (task, warnings)."""
    user = auth.user
    payload_ttl = ttl_hours
    agent = auth.agent if auth.kind is ActorKind.agent else (agent_name or "").strip() or None
    now = utcnow()
    hours = min(payload_ttl or settings.claim_default_hours, settings.claim_max_hours)
    expires = now + timedelta(hours=hours)
    renewing = task.claimed_by == user.id and task.claim_agent == agent and task.claim_is_live(now)
    if renewing and payload_ttl is None and task.claim_expires_at > expires:
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
            claim_branch=branch or Task.claim_branch,
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
            headers={"X-Claim-Block": "claimed"},
            detail=(
                f"Claimed by {holder}/{task.claim_agent or 'web'} until "
                f"{task.claim_expires_at:%Y-%m-%d %H:%M}Z. Pick other work."
            ),
        )
    db.refresh(task)

    warnings: list[str] = []
    if task.status in (S.to_do, S.backlog):
        record(db, auth, task_id=task.id, event_type=EventType.status_changed,
               from_status=task.status, to_status=S.in_progress,
               comment="Claimed" if task.status is S.to_do else "Claimed from the backlog", timestamp=now)
        task.status = S.in_progress
        _start_parent(db, auth, task)

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
    return task, warnings


@router.post("/{task_id}/criteria/{n}/take", response_model=ClaimOut, status_code=status.HTTP_201_CREATED)
def take_part(
    task_id: int,
    n: int,
    payload: TakePartRequest,
    db: DbSession,
    auth: Auth = Depends(require_scope("claims")),
) -> ClaimOut:
    """Take one part (acceptance criterion) of a task: the hub makes a subtask
    for it on the parent's side, links the part to it and claims it for you.
    When that subtask is approved as done, the part is marked met."""
    parent = _get_task_or_404(db, task_id)
    user = auth.user
    _assert_visible(parent, user)
    criterion = next((c for c in parent.criteria if c.n == n), None)
    if criterion is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"No part {n} on this task")
    reason = _take_block(parent, criterion, user)
    if reason is not None:
        code = ("taken" if reason.startswith("Taken in") else "claimed" if "holds the whole task" in reason
                else "waiting_decision" if "decision" in reason
                else "other_side" if "your profile lists" in reason else "not_pool" if "ask a lead before" in reason
                else "assign_only" if "A lead assigns this one" in reason
                else "blocked_by" if reason.startswith("Waits for") else "refused")
        forbidden = user.is_read_only or user.is_bot or code in ("other_side", "not_pool", "assign_only")
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN if forbidden else status.HTTP_409_CONFLICT,
                            detail=reason, headers={"X-Claim-Block": code})

    now = utcnow()
    text = " ".join(criterion.text.split())
    child = Task(
        title=(text if len(text) <= 200 else text[:199] + "…"),
        description=lint.clean(
            f"Part {n} of HUB-{parent.id} ({parent.title}).\n\n{criterion.text}\n\n"
            "Read the parent task first: its description holds the context, the evidence and the fix.",
            field="description",
        ),
        priority=parent.priority,
        points=min(parent.points or 1, 3),
        status=S.to_do,
        due_date=parent.due_date,
        created_by=user.id,
        side=parent.side,
        tags=list(parent.tags or []),
        areas=list(parent.areas or []),
        area_id=parent.area_id,
        restricted=parent.restricted,
        pool=parent.open_to_side,
        assign_only=parent.assign_only,
        # Restricted or assigned work stays with the taker: they can open it, and a lapsed
        # claim does not hand it to the whole side.
        assignee_1_id=user.id if (parent.restricted or not parent.open_to_side) else None,
        kind=parent.kind,
        created_kind=auth.kind,
        created_agent=auth.agent,
        parent_id=parent.id,
        created_at=now,
        updated_at=now,
    )
    db.add(child)
    db.flush()
    db.add(Criterion(task_id=child.id, n=1, text=criterion.text))
    record(db, auth, task_id=child.id, event_type=EventType.created, to_status=S.to_do, timestamp=now,
           data={"part_of": parent.id, "part": n})
    # The part is free when it has no subtask or only a dropped one; link it only if it still is.
    previous = criterion.subtask_id if (criterion.subtask is not None and criterion.subtask.status is S.dropped) else None
    won = db.execute(
        update(Criterion)
        .where(
            Criterion.id == criterion.id,
            Criterion.subtask_id.is_(None) if previous is None else Criterion.subtask_id == previous,
        )
        .values(subtask_id=child.id)
        .execution_options(synchronize_session=False)
    )
    if won.rowcount == 0:
        db.rollback()
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Someone took this part a moment ago",
                            headers={"X-Claim-Block": "taken"})
    db.expire(criterion)
    record(db, auth, task_id=parent.id, event_type=EventType.field_changed, timestamp=now,
           data={"part_taken": {"n": n, "subtask": child.id}})
    _touch(parent)
    db.flush()
    db.refresh(child)
    _, warnings = _claim(db, auth, child, payload.agent, payload.ttl_hours, None)
    db.commit()
    return _out(_get_task_or_404(db, child.id), ClaimOut, user, warnings=warnings)


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
        return _detail(task, auth.user)
    if task.claimed_by != user.id and not user.is_lead:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only the claim holder or a leader can release this claim",
        )
    data = {"agent": task.claim_agent, "holder": task.claimed_by}
    origin = _claim_origin(task) if task.status is S.in_progress else None
    if origin is not None and not any(c.status not in CLOSED_STATUSES for c in task.children):
        # Released work goes back where the claim took it from, so it is free to take again.
        record(db, auth, task_id=task.id, event_type=EventType.status_changed,
               from_status=S.in_progress, to_status=origin, comment="Released")
        task.status = origin
    _clear_claim(task)
    _touch(task)
    record(db, auth, task_id=task.id, event_type=EventType.released, data=data)
    db.commit()
    return _detail(_get_task_or_404(db, task.id), auth.user)


# --- comments -----------------------------------------------------------------


def _section(body: str, heading: str) -> str | None:
    match = re.search(rf"(?im)^[ 	]*{re.escape(heading)}[ 	]*(\S.*)?$", body)
    return match.group(1).strip() if match and match.group(1) else None


def _assert_bot_may_reply(db: Session, bot: User, task: Task, parent: Comment | None, kind: CommentKind) -> None:
    """A bot comments on its own proposals, and otherwise only replies in a
    thread where someone tagged it or asked it a question, within a daily cap."""
    if parent is None or kind not in (CommentKind.note, CommentKind.answer):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="A bot comments only on tasks it proposed, or replies (note or answer, with parent_id) in a thread where someone tagged it",
        )
    if kind is CommentKind.answer and parent.to_user_id != bot.id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="A bot answers only questions asked of it; reply with a note")
    thread = [parent.id] + [c.id for c in task.comments if c.parent_id == parent.id]
    tagged = db.scalar(
        select(func.count(Notification.id)).where(
            Notification.user_id == bot.id,
            Notification.task_id == task.id,
            Notification.comment_id.in_(thread),
            Notification.kind.in_([NotifyKind.mention, NotifyKind.question]),
        )
    )
    if not tagged:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Nobody tagged this bot in that thread")
    since = utcnow() - timedelta(days=1)
    sent = db.scalar(
        select(func.count(Comment.id))
        .join(Task, Task.id == Comment.task_id)
        .where(Comment.author_id == bot.id, Comment.created_at >= since, Task.created_by != bot.id)
    )
    if (sent or 0) >= settings.bot_replies_per_day:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=f"This bot reached its limit of {settings.bot_replies_per_day} replies in 24 hours",
        )


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
    body = lint.clean(payload.body, field="body")

    parent = None
    if payload.parent_id is not None:
        parent = db.get(Comment, payload.parent_id)
        if parent is None or parent.task_id != task.id:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="parent_id: no such comment on this task")
        if parent.parent_id is not None:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Reply to the top-level comment; threads are one level deep")

    if user.is_bot and task.created_by != user.id:
        _assert_bot_may_reply(db, user, task, parent, payload.kind)

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

    told = []
    if payload.kind is CommentKind.question:
        told += notify(db, auth, users=[to_user], task=task, kind=NotifyKind.question, text=body, comment_id=comment.id)
    elif payload.kind is CommentKind.answer:
        told += notify(db, auth, users=_people(db, [parent.author_id]), task=task, kind=NotifyKind.answered, text=body, comment_id=comment.id)
    already = {to_user.id} if to_user else set()
    if payload.kind is CommentKind.answer:
        already.add(parent.author_id)
    mentioned = [u for u in by_handles(db, mentioned_handles(body)) if u.id not in already]
    told += notify(db, auth, users=mentioned, task=task, kind=NotifyKind.mention, text=body, comment_id=comment.id)
    notified_ids = [n.user_id for n in told]

    db.commit()
    db.refresh(comment)
    # Who the hub actually told, so an agent can confirm a mention landed.
    comment.notified = [
        (u.handle or u.name) for u in _people(db, notified_ids)
    ]
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
    return _detail(_get_task_or_404(db, task.id), auth.user)
