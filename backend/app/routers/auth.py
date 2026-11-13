"""Authentication routes: login, the people directory and personal API tokens."""

from __future__ import annotations

from datetime import timedelta

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy import select

from app import ratelimit
from app.config import settings
from app.deps import (
    DEFAULT_TOKEN_SCOPES,
    SCOPES,
    Auth,
    AuthCtx,
    CurrentUser,
    DbSession,
    require_human,
)
from app.models import ApiToken, Role, User, utcnow
from app.schemas import (
    ApiTokenCreate,
    ApiTokenCreated,
    ApiTokenOut,
    LoginRequest,
    TokenResponse,
    UserOut,
)
from app.security import create_access_token, new_api_token, verify_password

router = APIRouter(prefix="/auth", tags=["auth"])

MAX_ACTIVE_TOKENS = 10


def _client_ip(request: Request) -> str:
    # taskflow_web (nginx) sets X-Real-IP; uvicorn runs with proxy headers on.
    return request.headers.get("x-real-ip") or (request.client.host if request.client else "?")


@router.post("/login", response_model=TokenResponse)
def login(payload: LoginRequest, request: Request, db: DbSession) -> TokenResponse:
    email = payload.email.lower()
    # Two buckets: one per address from this IP, one per IP overall, so a
    # guesser can neither hammer one account nor spray many.
    ip = _client_ip(request)
    ratelimit.hit(f"login:{ip}:{email}", settings.rate_login_per_minute)
    ratelimit.hit(f"login-ip:{ip}", settings.rate_login_per_minute * 4)

    user = db.scalar(select(User).where(User.email == email))
    # Same response for unknown email, wrong password and deactivated account,
    # so the endpoint doesn't confirm which accounts exist or which are live.
    if (
        user is None
        or not user.is_active
        or user.is_bot  # bots use tokens an admin issues, never a password
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


@router.get("/whoami")
def whoami(auth: AuthCtx) -> dict:
    """Who is calling and how: lets an agent see its token's scopes and expiry."""
    out = {
        "user": UserOut.model_validate(auth.user).model_dump(mode="json"),
        "kind": auth.kind.value,
        "agent": auth.agent,
        "scopes": sorted(auth.scopes),
        "token": None,
        "token_max_days": settings.api_token_max_days,
    }
    if auth.token is not None:
        out["token"] = {
            "id": auth.token.id,
            "name": auth.token.name,
            "prefix": auth.token.prefix,
            "expires_at": auth.token.expires_at.isoformat(),
        }
    return out


@router.get("/users", response_model=list[UserOut])
def list_users(
    user: CurrentUser,
    db: DbSession,
    role: str | None = None,
    side: str | None = None,
) -> list[User]:
    """Directory used by the assignment UI and by agents resolving handles.

    Members get the list too (names are shown on shared tasks), but it is
    read-only and carries no sensitive fields.
    """
    # Deactivated people are left out: this feeds the assignment pickers, and
    # nobody should be given new work. Leaders see everyone via GET /users.
    stmt = select(User).where(User.is_active.is_(True)).order_by(User.name)
    people = list(db.scalars(stmt))
    if role is not None:
        # Accepts the access roles (admin, lead, member, viewer) and the old
        # single-role names (leader, programmer) older clients send.
        wanted = {"leader": "lead", "programmer": "member"}.get(role, role)
        people = [
            p for p in people
            if (wanted in p.effective_roles or (wanted == "lead" and p.is_lead))
            and not (p.is_bot and wanted == "member")
        ]
    if side is not None:
        people = [p for p in people if side in (p.sides or [])]
    return people


# --- personal API tokens -------------------------------------------------------


@router.get("/scopes")
def list_scopes() -> dict[str, str]:
    return SCOPES


@router.get("/tokens", response_model=list[ApiTokenOut])
def list_tokens(db: DbSession, auth: Auth = Depends(require_human)) -> list[ApiToken]:
    """Your own tokens, newest first. Secrets are never shown again."""
    return list(
        db.scalars(
            select(ApiToken).where(ApiToken.user_id == auth.user.id).order_by(ApiToken.id.desc())
        )
    )


@router.post("/tokens", response_model=ApiTokenCreated, status_code=status.HTTP_201_CREATED)
def create_token(
    payload: ApiTokenCreate,
    db: DbSession,
    auth: Auth = Depends(require_human),
) -> ApiTokenCreated:
    """Create a token for your agents. Only a browser login can do this, so a
    leaked token cannot mint more tokens."""
    user = auth.user
    if user.is_read_only:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Viewer accounts cannot create API tokens")
    if payload.expires_days > settings.api_token_max_days:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"expires_days: at most {settings.api_token_max_days}",
        )
    scopes = payload.scopes if payload.scopes is not None else list(DEFAULT_TOKEN_SCOPES)
    unknown = sorted(set(scopes) - set(SCOPES))
    if unknown or not scopes:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"scopes: unknown {unknown}" if unknown else "scopes: pick at least one",
        )
    now = utcnow()
    active = [
        t for t in db.scalars(select(ApiToken).where(ApiToken.user_id == user.id))
        if t.revoked_at is None and t.expires_at > now
    ]
    if len(active) >= MAX_ACTIVE_TOKENS:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"You already have {MAX_ACTIVE_TOKENS} active tokens. Revoke one first.",
        )

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
    out = ApiTokenCreated.model_validate({**ApiTokenOut.model_validate(row).model_dump(), "token": full})
    return out


@router.delete("/tokens/{token_id}", response_model=ApiTokenOut)
def revoke_token(token_id: int, db: DbSession, auth: Auth = Depends(require_human)) -> ApiToken:
    """Revoke your own token. A leader may revoke anyone's."""
    row = db.get(ApiToken, token_id)
    if row is None or (row.user_id != auth.user.id and not auth.user.is_admin):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Token not found")
    if row.revoked_at is None:
        row.revoked_at = utcnow()
        db.commit()
        db.refresh(row)
    return row
