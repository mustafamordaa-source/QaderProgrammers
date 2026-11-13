"""People and bot accounts.

Leads may list everyone; only admins create, change, deactivate, reset
passwords and issue bot tokens.

Accounts are deactivated rather than deleted. `tasks` and `task_events` both
carry non-nullable foreign keys into `users`, so a hard delete would either be
refused by the database or take the audit log, and therefore every KPI, with
it. Deactivation revokes access while leaving history intact.
"""

from __future__ import annotations

import secrets
from datetime import timedelta

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.config import settings
from app.deps import BOT_SCOPES, DbSession, require_admin, require_leader
from app.models import (
    CLOSED_STATUSES,
    AccessRole,
    AccountType,
    ApiToken,
    Role,
    Task,
    User,
    normalise_roles,
    utcnow,
)
from app.schemas import (
    ApiTokenCreate,
    ApiTokenCreated,
    ApiTokenOut,
    PasswordReset,
    UserAdminOut,
    UserCreate,
    UserUpdate,
)
from app.security import hash_password, new_api_token

router = APIRouter(prefix="/users", tags=["users"])

# The old single role names map onto the new access roles.
LEGACY_ROLE_MAP: dict[Role, list[str]] = {
    Role.leader: [AccessRole.admin.value, AccessRole.lead.value],
    Role.programmer: [AccessRole.member.value],
    Role.viewer: [AccessRole.viewer.value],
}


def _open_task_counts(db: Session) -> dict[int, int]:
    """Open task count per assignee, counting a shared task for both people."""
    counts: dict[int, int] = {}
    for column in (Task.assignee_1_id, Task.assignee_2_id):
        rows = db.execute(
            select(column, func.count(Task.id))
            .where(column.is_not(None), Task.status.not_in(list(CLOSED_STATUSES)))
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
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=f"{email} is already registered")


def _assert_handle_free(db: Session, handle: str | None, *, exclude_id: int | None = None) -> None:
    if not handle:
        return
    stmt = select(User).where(User.handle == handle)
    if exclude_id is not None:
        stmt = stmt.where(User.id != exclude_id)
    if db.scalar(stmt) is not None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=f"The handle '{handle}' is taken")


def _wanted_roles(roles, role: Role | None, fallback: list[str]) -> list[str]:
    if roles is not None:
        out = normalise_roles(roles)
    elif role is not None:
        out = LEGACY_ROLE_MAP[role]
    else:
        out = fallback
    if not out:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="roles: pick at least one")
    return out


def _assert_an_admin_remains(db: Session, *, changing: User, roles: list[str], is_active: bool) -> None:
    """Refuse a change that would leave nobody able to manage people. Applies to
    the acting admin too: handing over is fine, with somebody left to hand to."""
    if not changing.is_admin:
        return
    if AccessRole.admin.value in roles and is_active:
        return
    others = [
        u for u in db.scalars(select(User).where(User.is_active.is_(True), User.id != changing.id))
        if u.is_admin and not u.is_bot
    ]
    if not others:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=(
                "This is the only active leader with admin rights. Give another "
                "person the admin role first, otherwise nobody could manage people."
            ),
        )


@router.get("", response_model=list[UserAdminOut])
def list_users(
    db: DbSession,
    lead: User = Depends(require_leader),
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
    admin: User = Depends(require_admin),
) -> UserAdminOut:
    email = payload.email.lower()
    _assert_email_free(db, email)
    _assert_handle_free(db, payload.handle)
    is_bot = payload.account_type is AccountType.bot

    if is_bot:
        # A bot proposes work; it never leads, administers or logs in.
        roles = [AccessRole.member.value]
        password = secrets.token_urlsafe(32)
    else:
        roles = _wanted_roles(payload.roles, payload.role, [AccessRole.member.value])
        if not payload.password:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="password: required for a person")
        password = payload.password

    user = User(
        name=payload.name,
        email=email,
        password_hash=hash_password(password),
        role=Role.programmer,
        is_active=True,
        handle=payload.handle,
        github_login=payload.github_login,
        sides=[s.value for s in payload.sides or []],
        wip_limit=payload.wip_limit or 2,
        account_type=payload.account_type,
    )
    user.set_roles(roles)
    db.add(user)
    db.commit()
    db.refresh(user)
    return _to_admin_out(user, {})


@router.patch("/{user_id}", response_model=UserAdminOut)
def update_user(
    user_id: int,
    payload: UserUpdate,
    db: DbSession,
    admin: User = Depends(require_admin),
) -> UserAdminOut:
    user = _get_user_or_404(db, user_id)
    fields = payload.model_dump(exclude_unset=True)
    roles_in = fields.pop("roles", None)
    role_in = fields.pop("role", None)

    if fields.get("email") is not None:
        fields["email"] = fields["email"].lower()
        _assert_email_free(db, fields["email"], exclude_id=user.id)
    if fields.get("handle"):
        _assert_handle_free(db, fields["handle"], exclude_id=user.id)
    if fields.get("sides") is not None:
        fields["sides"] = [s.value if hasattr(s, "value") else s for s in fields["sides"]]

    new_roles = user.effective_roles
    if roles_in is not None or role_in is not None:
        if user.is_bot:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="A bot's role cannot change")
        new_roles = _wanted_roles(roles_in, Role(role_in) if role_in else None, user.effective_roles)

    _assert_an_admin_remains(
        db,
        changing=user,
        roles=new_roles,
        is_active=fields.get("is_active", user.is_active),
    )

    for field, value in fields.items():
        if value is not None or field in {"handle", "github_login"}:
            setattr(user, field, value)
    user.set_roles(new_roles)

    if fields.get("is_active") is False:
        # Deactivation also kills every API token the person holds.
        now = utcnow()
        for token in db.scalars(select(ApiToken).where(ApiToken.user_id == user.id)):
            if token.revoked_at is None:
                token.revoked_at = now

    db.commit()
    db.refresh(user)
    return _to_admin_out(user, _open_task_counts(db))


@router.post("/{user_id}/password", response_model=UserAdminOut)
def reset_password(
    user_id: int,
    payload: PasswordReset,
    db: DbSession,
    admin: User = Depends(require_admin),
) -> UserAdminOut:
    user = _get_user_or_404(db, user_id)
    if user.is_bot:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Bots have no password; issue a token")
    user.password_hash = hash_password(payload.password)
    db.commit()
    db.refresh(user)
    return _to_admin_out(user, _open_task_counts(db))


@router.get("/{user_id}/tokens", response_model=list[ApiTokenOut])
def list_bot_tokens(user_id: int, db: DbSession, admin: User = Depends(require_admin)) -> list[ApiToken]:
    """A bot's tokens. People manage their own on the Settings page."""
    user = _get_user_or_404(db, user_id)
    if not user.is_bot:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not a bot account")
    return list(db.scalars(select(ApiToken).where(ApiToken.user_id == user.id).order_by(ApiToken.id.desc())))


@router.post("/{user_id}/tokens", response_model=ApiTokenCreated, status_code=status.HTTP_201_CREATED)
def issue_bot_token(
    user_id: int,
    payload: ApiTokenCreate,
    db: DbSession,
    admin: User = Depends(require_admin),
) -> ApiTokenCreated:
    """Issue a token for a bot. Bot scopes are limited to reading, proposing
    tasks and commenting on its own proposals."""
    user = _get_user_or_404(db, user_id)
    if not user.is_bot:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not a bot account")
    if payload.expires_days > settings.api_token_max_days:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"expires_days: at most {settings.api_token_max_days}",
        )
    scopes = payload.scopes if payload.scopes is not None else list(BOT_SCOPES)
    extra = sorted(set(scopes) - set(BOT_SCOPES))
    if extra or not scopes:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"scopes: a bot may hold only {sorted(BOT_SCOPES)}" if extra else "scopes: pick at least one",
        )
    now = utcnow()
    full, prefix, secret_hash = new_api_token()
    row = ApiToken(
        user_id=user.id,
        name=payload.name.strip(),
        prefix=prefix,
        secret_hash=secret_hash,
        scopes=sorted(set(scopes)),
        created_at=now,
        expires_at=now + timedelta(days=payload.expires_days),
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return ApiTokenCreated.model_validate({**ApiTokenOut.model_validate(row).model_dump(), "token": full})
