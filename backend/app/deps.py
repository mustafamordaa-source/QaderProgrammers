"""Shared FastAPI dependencies: current user resolution and role guards."""

from __future__ import annotations

from typing import Annotated

import jwt
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import Role, User
from app.security import decode_access_token

bearer_scheme = HTTPBearer(auto_error=False)

CREDENTIALS_ERROR = HTTPException(
    status_code=status.HTTP_401_UNAUTHORIZED,
    detail="Could not validate credentials",
    headers={"WWW-Authenticate": "Bearer"},
)


def get_current_user(
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(bearer_scheme)],
    db: Annotated[Session, Depends(get_db)],
) -> User:
    if credentials is None:
        raise CREDENTIALS_ERROR
    try:
        payload = decode_access_token(credentials.credentials)
        user_id = int(payload["sub"])
    except (jwt.PyJWTError, KeyError, TypeError, ValueError):
        raise CREDENTIALS_ERROR from None

    user = db.get(User, user_id)
    if user is None:
        raise CREDENTIALS_ERROR
    if not user.is_active:
        # Deactivating someone must revoke the token they already hold, not just
        # stop them logging in again.
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="This account has been deactivated",
        )
    return user


CurrentUser = Annotated[User, Depends(get_current_user)]
DbSession = Annotated[Session, Depends(get_db)]


def require_roles(*roles: Role):
    """Build a role-guard dependency: `Depends(require_roles(Role.leader))`.

    This is a closure rather than a callable class on purpose: with
    `from __future__ import annotations` in effect, FastAPI resolves a
    dependency's annotations against its `__globals__`, which a class *instance*
    does not have — the guard's `user` parameter would silently degrade into a
    required query parameter.
    """
    allowed = set(roles)
    label = ", ".join(sorted(r.value for r in allowed))

    def guard(user: CurrentUser) -> User:
        if user.role not in allowed:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"This action requires role: {label}",
            )
        return user

    return guard


require_leader = require_roles(Role.leader)
require_programmer = require_roles(Role.programmer)

LeaderUser = Annotated[User, Depends(require_leader)]
ProgrammerUser = Annotated[User, Depends(require_programmer)]
