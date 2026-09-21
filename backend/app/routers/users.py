"""User management. Every route here is leader-only.

Accounts are deactivated rather than deleted. `tasks` and `task_events` both
carry non-nullable foreign keys into `users`, so a hard delete would either be
refused by the database or take the audit log — and therefore every KPI — with
it. Deactivation revokes access while leaving history intact.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.deps import DbSession, require_leader
from app.models import Role, Task, TaskStatus, User
from app.schemas import PasswordReset, UserAdminOut, UserCreate, UserUpdate
from app.security import hash_password

router = APIRouter(prefix="/users", tags=["users"])


def _open_task_counts(db: Session) -> dict[int, int]:
    """Open (not yet done) task count per assignee, counting a shared task for
    both of the people on it."""
    counts: dict[int, int] = {}
    for column in (Task.assignee_1_id, Task.assignee_2_id):
        rows = db.execute(
            select(column, func.count(Task.id))
            .where(column.is_not(None), Task.status != TaskStatus.done)
            .group_by(column)
        ).all()
        for user_id, count in rows:
            counts[user_id] = counts.get(user_id, 0) + count
    return counts


def _to_admin_out(user: User, counts: dict[int, int]) -> UserAdminOut:
    row = UserAdminOut.model_validate(user)
    row.open_task_count = counts.get(user.id, 0)
    return row


def _get_user_or_404(db: Session, user_id: int) -> User:
    user = db.get(User, user_id)
    if user is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
    return user


def _assert_email_free(db: Session, email: str, *, exclude_id: int | None = None) -> None:
    stmt = select(User).where(User.email == email)
    if exclude_id is not None:
        stmt = stmt.where(User.id != exclude_id)
    if db.scalar(stmt) is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"{email} is already registered",
        )


def _assert_a_leader_remains(db: Session, *, changing: User, role: Role, is_active: bool) -> None:
    """Refuse a change that would leave nobody able to approve work or manage
    users. Applies to the acting leader too — self-demotion is fine, but only
    with somebody else left to hand over to."""
    if changing.role is not Role.leader:
        return
    if role is Role.leader and is_active:
        return  # still an active leader after the change

    other_active_leaders = db.scalar(
        select(func.count(User.id)).where(
            User.role == Role.leader,
            User.is_active.is_(True),
            User.id != changing.id,
        )
    )
    if not other_active_leaders:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=(
                "This is the only active leader. Promote or activate another "
                "leader first — otherwise nobody could approve work or manage users."
            ),
        )


@router.get("", response_model=list[UserAdminOut])
def list_users(
    db: DbSession,
    leader: User = Depends(require_leader),
    include_inactive: bool = True,
) -> list[UserAdminOut]:
    stmt = select(User).order_by(User.is_active.desc(), User.name)
    if not include_inactive:
        stmt = stmt.where(User.is_active.is_(True))
    counts = _open_task_counts(db)
    return [_to_admin_out(user, counts) for user in db.scalars(stmt)]


@router.post("", response_model=UserAdminOut, status_code=status.HTTP_201_CREATED)
def create_user(
    payload: UserCreate,
    db: DbSession,
    leader: User = Depends(require_leader),
) -> UserAdminOut:
    email = payload.email.lower()
    _assert_email_free(db, email)

    user = User(
        name=payload.name,
        email=email,
        password_hash=hash_password(payload.password),
        role=payload.role,
        is_active=True,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return _to_admin_out(user, {})


@router.patch("/{user_id}", response_model=UserAdminOut)
def update_user(
    user_id: int,
    payload: UserUpdate,
    db: DbSession,
    leader: User = Depends(require_leader),
) -> UserAdminOut:
    user = _get_user_or_404(db, user_id)
    fields = payload.model_dump(exclude_unset=True)

    if "email" in fields and fields["email"] is not None:
        fields["email"] = fields["email"].lower()
        _assert_email_free(db, fields["email"], exclude_id=user.id)

    _assert_a_leader_remains(
        db,
        changing=user,
        role=fields.get("role", user.role),
        is_active=fields.get("is_active", user.is_active),
    )

    for field, value in fields.items():
        if value is not None:
            setattr(user, field, value)

    db.commit()
    db.refresh(user)
    return _to_admin_out(user, _open_task_counts(db))


@router.post("/{user_id}/password", response_model=UserAdminOut)
def reset_password(
    user_id: int,
    payload: PasswordReset,
    db: DbSession,
    leader: User = Depends(require_leader),
) -> UserAdminOut:
    user = _get_user_or_404(db, user_id)
    user.password_hash = hash_password(payload.password)
    db.commit()
    db.refresh(user)
    return _to_admin_out(user, _open_task_counts(db))
