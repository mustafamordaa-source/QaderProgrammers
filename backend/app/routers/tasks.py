"""Task CRUD, assignment and status-transition routes."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import or_, select
from sqlalchemy.orm import Session, selectinload

from app.deps import CurrentUser, DbSession, require_leader
from app.events import log_event
from app.models import EventType, Role, Task, TaskStatus, User, utcnow
from app.schemas import (
    RejectRequest,
    StatusChangeRequest,
    TaskAssign,
    TaskCreate,
    TaskDetailOut,
    TaskOut,
    TaskUpdate,
)
from app.transitions import TransitionError, check_rejection, check_transition

router = APIRouter(prefix="/tasks", tags=["tasks"])


def _get_task_or_404(db: Session, task_id: int) -> Task:
    task = db.scalar(
        select(Task).where(Task.id == task_id).options(selectinload(Task.events))
    )
    if task is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Task not found")
    return task


def _assert_visible(task: Task, user: User) -> None:
    """Programmers may only see tasks they are assigned to."""
    if user.role is Role.leader or user.id in task.assignee_ids:
        return
    # 404 rather than 403: don't reveal that a task exists.
    raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Task not found")


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
        if assignee.role is not Role.programmer:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=f"{field}: tasks can only be assigned to programmers",
            )
        if not assignee.is_active:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=f"{field}: {assignee.name}'s account is deactivated",
            )


@router.post("", response_model=TaskDetailOut, status_code=status.HTTP_201_CREATED)
def create_task(
    payload: TaskCreate,
    db: DbSession,
    leader: User = Depends(require_leader),
) -> Task:
    _validate_assignees(db, payload.assignee_1_id, payload.assignee_2_id)

    task = Task(
        title=payload.title,
        description=payload.description,
        priority=payload.priority,
        status=TaskStatus.to_do,
        due_date=payload.due_date,
        created_by=leader.id,
        assignee_1_id=payload.assignee_1_id,
        assignee_2_id=payload.assignee_2_id,
    )
    db.add(task)
    db.flush()  # assign task.id before logging the event

    log_event(
        db,
        task_id=task.id,
        actor_id=leader.id,
        event_type=EventType.created,
        to_status=TaskStatus.to_do,
        timestamp=task.created_at,
    )
    db.commit()
    db.refresh(task)
    return task


@router.get("", response_model=list[TaskOut])
def list_tasks(
    user: CurrentUser,
    db: DbSession,
    status_filter: TaskStatus | None = None,
    assignee_id: int | None = None,
) -> list[Task]:
    stmt = select(Task).order_by(Task.created_at.desc())

    if user.role is Role.programmer:
        # Programmers see their queue only, regardless of the filters asked for.
        stmt = stmt.where(
            or_(Task.assignee_1_id == user.id, Task.assignee_2_id == user.id)
        )
    elif assignee_id is not None:
        stmt = stmt.where(
            or_(Task.assignee_1_id == assignee_id, Task.assignee_2_id == assignee_id)
        )

    if status_filter is not None:
        stmt = stmt.where(Task.status == status_filter)

    return list(db.scalars(stmt).unique())


@router.get("/{task_id}", response_model=TaskDetailOut)
def get_task(task_id: int, user: CurrentUser, db: DbSession) -> Task:
    task = _get_task_or_404(db, task_id)
    _assert_visible(task, user)
    return task


@router.patch("/{task_id}", response_model=TaskDetailOut)
def update_task(
    task_id: int,
    payload: TaskUpdate,
    db: DbSession,
    leader: User = Depends(require_leader),
) -> Task:
    task = _get_task_or_404(db, task_id)
    for field, value in payload.model_dump(exclude_unset=True).items():
        setattr(task, field, value)
    task.updated_at = utcnow()
    db.commit()
    db.refresh(task)
    return task


@router.patch("/{task_id}/status", response_model=TaskDetailOut)
def change_status(
    task_id: int,
    payload: StatusChangeRequest,
    user: CurrentUser,
    db: DbSession,
) -> Task:
    task = _get_task_or_404(db, task_id)
    _assert_visible(task, user)

    try:
        check_transition(
            current=task.status,
            target=payload.status,
            role=user.role,
            is_assignee=user.id in task.assignee_ids,
        )
    except TransitionError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from None

    from_status = task.status
    now = utcnow()
    task.status = payload.status
    task.updated_at = now

    if from_status is TaskStatus.in_review and payload.status is TaskStatus.done:
        # Approval and closure are distinct KPI inputs: `approved` feeds the
        # review pass rate, `closed` marks the end of the cycle.
        log_event(
            db,
            task_id=task.id,
            actor_id=user.id,
            event_type=EventType.approved,
            from_status=from_status,
            to_status=TaskStatus.done,
            comment=payload.comment,
            timestamp=now,
        )
        log_event(
            db,
            task_id=task.id,
            actor_id=user.id,
            event_type=EventType.closed,
            from_status=from_status,
            to_status=TaskStatus.done,
            timestamp=now,
        )
    elif from_status is TaskStatus.in_review and payload.status in {
        TaskStatus.in_progress_front,
        TaskStatus.in_progress_back,
    }:
        # A leader moving a task out of review without a comment is still a
        # rejection as far as the KPIs are concerned.
        if not (payload.comment or "").strip():
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="A comment is required when sending a task back out of review",
            )
        log_event(
            db,
            task_id=task.id,
            actor_id=user.id,
            event_type=EventType.rejected,
            from_status=from_status,
            to_status=payload.status,
            comment=payload.comment,
            timestamp=now,
        )
    else:
        log_event(
            db,
            task_id=task.id,
            actor_id=user.id,
            event_type=EventType.status_changed,
            from_status=from_status,
            to_status=payload.status,
            comment=payload.comment,
            timestamp=now,
        )

    db.commit()
    db.refresh(task)
    return task


@router.patch("/{task_id}/assign", response_model=TaskDetailOut)
def assign_task(
    task_id: int,
    payload: TaskAssign,
    db: DbSession,
    leader: User = Depends(require_leader),
) -> Task:
    task = _get_task_or_404(db, task_id)
    _validate_assignees(db, payload.assignee_1_id, payload.assignee_2_id)

    before = task.assignee_ids
    task.assignee_1_id = payload.assignee_1_id
    task.assignee_2_id = payload.assignee_2_id
    task.updated_at = utcnow()

    log_event(
        db,
        task_id=task.id,
        actor_id=leader.id,
        event_type=EventType.status_changed,
        from_status=task.status,
        to_status=task.status,
        comment=f"Reassigned from {before or 'nobody'} to {task.assignee_ids or 'nobody'}",
    )
    db.commit()
    db.refresh(task)
    return task


@router.post("/{task_id}/reject", response_model=TaskDetailOut)
def reject_task(
    task_id: int,
    payload: RejectRequest,
    db: DbSession,
    leader: User = Depends(require_leader),
) -> Task:
    task = _get_task_or_404(db, task_id)

    try:
        check_rejection(current=task.status, target=payload.to_status)
    except TransitionError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from None

    from_status = task.status
    task.status = payload.to_status
    task.updated_at = utcnow()

    log_event(
        db,
        task_id=task.id,
        actor_id=leader.id,
        event_type=EventType.rejected,
        from_status=from_status,
        to_status=payload.to_status,
        comment=payload.comment,
    )
    db.commit()
    db.refresh(task)
    return task
