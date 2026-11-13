"""Shared FastAPI dependencies: who is calling, how, and role and scope guards.

Two ways in:

- a browser login (JWT) acts as a human with every scope its role allows;
- a personal API token (`qhub_...`) acts as an agent for the token's owner,
  limited to the token's scopes, and must name the agent in `X-Agent`.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Annotated

import jwt
from fastapi import Depends, Header, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import ratelimit
from app.config import settings
from app.database import get_db
from app.models import ActorKind, ApiToken, Role, User, utcnow
from app.security import decode_access_token, split_api_token, token_secret_matches

bearer_scheme = HTTPBearer(auto_error=False)

CREDENTIALS_ERROR = HTTPException(
    status_code=status.HTTP_401_UNAUTHORIZED,
    detail="Could not validate credentials",
    headers={"WWW-Authenticate": "Bearer"},
)

# Every scope a token can carry. A JWT login implies all of them.
SCOPES: dict[str, str] = {
    "tasks:read": "Read tasks, comments, criteria and links",
    "tasks:write": "Move tasks, edit fields on your own tasks, criteria, deploy state",
    "tasks:create": "Create tasks (members create into backlog)",
    "comments:write": "Comment, ask and answer",
    "claims": "Claim and release tasks",
    "git:write": "Link branches, PRs and commits",
    "docs:write": "Write task documents, attach files, add context links",
    "tasks:propose": "Propose tasks for a lead to triage (bots)",
}
DEFAULT_TOKEN_SCOPES: tuple[str, ...] = tuple(s for s in SCOPES if s != "tasks:propose")
# The most a bot token may hold: read, propose, comment on its own proposals.
BOT_SCOPES: tuple[str, ...] = ("tasks:read", "tasks:propose", "comments:write")

_WRITE_METHODS = {"POST", "PUT", "PATCH", "DELETE"}
_BAD_AGENT_NAMES = {"", "unknown", "agent", "none", "null"}


@dataclass
class Auth:
    user: User
    kind: ActorKind
    token: ApiToken | None = None
    agent: str | None = None
    scopes: set[str] = field(default_factory=set)

    @property
    def token_id(self) -> int | None:
        return self.token.id if self.token else None

    def has(self, scope: str) -> bool:
        return self.kind is ActorKind.human or scope in self.scopes


def _user_from_jwt(raw: str, db: Session) -> User:
    try:
        payload = decode_access_token(raw)
        user_id = int(payload["sub"])
    except (jwt.PyJWTError, KeyError, TypeError, ValueError):
        raise CREDENTIALS_ERROR from None
    user = db.get(User, user_id)
    if user is None:
        raise CREDENTIALS_ERROR
    return user


def _token_row(raw: str, db: Session) -> ApiToken:
    parts = split_api_token(raw)
    if parts is None:
        raise CREDENTIALS_ERROR
    prefix, secret = parts
    row = db.scalar(select(ApiToken).where(ApiToken.prefix == prefix))
    if row is None or not token_secret_matches(secret, row.secret_hash):
        raise CREDENTIALS_ERROR
    if row.revoked_at is not None or row.expires_at <= utcnow():
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="This API token is revoked or expired",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return row


def get_auth(
    request: Request,
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(bearer_scheme)],
    db: Annotated[Session, Depends(get_db)],
    x_agent: Annotated[str | None, Header()] = None,
) -> Auth:
    if credentials is None:
        raise CREDENTIALS_ERROR
    raw = credentials.credentials

    if raw.startswith("qhub_"):
        token = _token_row(raw, db)
        user = token.user
        write = request.method in _WRITE_METHODS
        ratelimit.hit(
            f"token:{token.id}:{'w' if write else 'r'}",
            settings.rate_token_writes_per_minute if write else settings.rate_token_reads_per_minute,
        )
        agent = (x_agent or "").strip()[:80]
        if write and agent.lower() in _BAD_AGENT_NAMES:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Writes with an API token need an X-Agent header naming the agent (not 'unknown').",
            )
        if not write and "tasks:read" not in (token.scopes or []):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="This API token lacks the 'tasks:read' scope",
            )
        token.last_used_at = utcnow()
        auth = Auth(
            user=user,
            kind=ActorKind.agent,
            token=token,
            agent=agent or None,
            scopes=set(token.scopes or []),
        )
    else:
        user = _user_from_jwt(raw, db)
        auth = Auth(user=user, kind=ActorKind.human, scopes=set(SCOPES))

    if not user.is_active:
        # Deactivating someone must revoke the token they already hold, not just
        # stop them logging in again.
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="This account has been deactivated",
        )
    return auth


AuthCtx = Annotated[Auth, Depends(get_auth)]


def get_current_user(auth: AuthCtx) -> User:
    return auth.user


CurrentUser = Annotated[User, Depends(get_current_user)]
DbSession = Annotated[Session, Depends(get_db)]


def require_scope(scope: str):
    """Guard for token scopes: `Depends(require_scope("claims"))`."""

    def guard(auth: AuthCtx) -> Auth:
        if not auth.has(scope):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"This API token lacks the '{scope}' scope",
            )
        return auth

    return guard


def require_human(auth: AuthCtx) -> Auth:
    """Some actions (managing tokens) need a browser login, not a token."""
    if auth.kind is not ActorKind.human:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Sign in on the web for this action; API tokens cannot do it",
        )
    return auth


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


def _require(check: str, label: str):
    def guard(user: CurrentUser) -> User:
        if not getattr(user, check):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"This action requires role: {label}",
            )
        return user

    return guard


# Leads run the work; admins hold every lead right too. The message keeps the
# word "leader" that older clients and tests match on.
require_leader = _require("is_lead", "leader")
require_admin = _require("is_admin", "admin")
require_programmer = require_roles(Role.programmer)

LeaderUser = Annotated[User, Depends(require_leader)]
ProgrammerUser = Annotated[User, Depends(require_programmer)]
