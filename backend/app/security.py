"""Password hashing, JWT encoding/decoding and personal API tokens."""

from __future__ import annotations

import hashlib
import hmac
import secrets
from datetime import datetime, timedelta, timezone

import jwt
from passlib.context import CryptContext

from app.config import settings

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")

# Personal API tokens look like `qhub_<prefix>_<secret>`. The prefix is stored
# in clear so the server finds the row; only a SHA-256 of the secret is kept.
API_TOKEN_MARK = "qhub_"


def hash_password(password: str) -> str:
    return pwd_context.hash(password)


def verify_password(plain: str, hashed: str) -> bool:
    return pwd_context.verify(plain, hashed)


def create_access_token(subject: int | str, expires_minutes: int | None = None) -> str:
    minutes = expires_minutes or settings.access_token_expire_minutes
    now = datetime.now(timezone.utc)
    payload = {
        "sub": str(subject),
        "iat": now,
        "exp": now + timedelta(minutes=minutes),
    }
    return jwt.encode(payload, settings.secret_key, algorithm=settings.algorithm)


def decode_access_token(token: str) -> dict:
    """Decode a token, raising jwt.PyJWTError on anything invalid or expired."""
    return jwt.decode(token, settings.secret_key, algorithms=[settings.algorithm])


def hash_token_secret(secret: str) -> str:
    return hashlib.sha256(secret.encode("utf-8")).hexdigest()


def new_api_token() -> tuple[str, str, str]:
    """Return (full token, prefix, secret hash). The full token is shown once."""
    prefix = secrets.token_hex(4)
    secret = secrets.token_urlsafe(32)
    return f"{API_TOKEN_MARK}{prefix}_{secret}", prefix, hash_token_secret(secret)


def split_api_token(token: str) -> tuple[str, str] | None:
    """Return (prefix, secret) for a well-formed token, else None."""
    if not token.startswith(API_TOKEN_MARK):
        return None
    prefix, sep, secret = token[len(API_TOKEN_MARK):].partition("_")
    if not sep or not prefix or not secret:
        return None
    return prefix, secret


def token_secret_matches(secret: str, stored_hash: str) -> bool:
    return hmac.compare_digest(hash_token_secret(secret), stored_hash)
