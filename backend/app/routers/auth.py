"""Authentication routes."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, status

from app.deps import CurrentUser, DbSession
from app.models import Role, User
from app.schemas import LoginRequest, TokenResponse, UserOut
from app.security import create_access_token, verify_password
from sqlalchemy import select

router = APIRouter(prefix="/auth", tags=["auth"])


@router.post("/login", response_model=TokenResponse)
def login(payload: LoginRequest, db: DbSession) -> TokenResponse:
    user = db.scalar(select(User).where(User.email == payload.email.lower()))
    # Same response for unknown email, wrong password and deactivated account,
    # so the endpoint doesn't confirm which accounts exist or which are live.
    if (
        user is None
        or not user.is_active
        or not verify_password(payload.password, user.password_hash)
    ):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Incorrect email or password",
        )
    return TokenResponse(
        access_token=create_access_token(user.id),
        user=UserOut.model_validate(user),
    )


@router.get("/me", response_model=UserOut)
def me(user: CurrentUser) -> User:
    return user


@router.get("/users", response_model=list[UserOut])
def list_users(user: CurrentUser, db: DbSession, role: Role | None = None) -> list[User]:
    """Directory used by the leader's assignment UI.

    Programmers get the list too (names are shown on shared tasks), but it is
    read-only and carries no sensitive fields.
    """
    # Deactivated people are left out: this feeds the assignment pickers, and
    # nobody should be given new work. Leaders see everyone via GET /users.
    stmt = select(User).where(User.is_active.is_(True)).order_by(User.name)
    if role is not None:
        stmt = stmt.where(User.role == role)
    return list(db.scalars(stmt))
