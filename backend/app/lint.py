"""Text checks for everything people and agents write into the hub.

The hub is shared with the whole team. These checks refuse text that looks
like a secret, a server address or a private file path, and strip invisible
characters that can hide instructions from a human reader. They are a safety
net; the agent skill still tells agents not to post such things.
"""

from __future__ import annotations

import re

from fastapi import HTTPException, status

from app.config import settings

# Invisible characters used to hide text. Arabic needs the directional marks
# U+200E / U+200F and the joiners U+200C / U+200D, so those stay. The bidi
# override characters (U+202A to U+202E) can reorder code for a reader, so
# they go.
_STRIP = re.compile("[\u200b\u2060\ufeff\u202a-\u202e]")

_RULES: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("private key", re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----")),
    ("GitHub token", re.compile(r"\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}")),
    ("API key", re.compile(r"\bsk-[A-Za-z0-9_-]{20,}")),
    ("AWS key", re.compile(r"\bAKIA[0-9A-Z]{16}\b")),
    ("Slack token", re.compile(r"\bxox[abprs]-[A-Za-z0-9-]{10,}")),
    ("hub token", re.compile(r"\bqhub_[0-9a-f]{8}_[A-Za-z0-9_-]{20,}")),
    ("JWT", re.compile(r"\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}")),
    (
        "secret assignment",
        re.compile(
            r"(?im)^\s*(?:export\s+)?[A-Z0-9_]*(?:SECRET|PASSWORD|PASSWD|TOKEN|API_KEY)[A-Z0-9_]*\s*=\s*\S{6,}"
        ),
    ),
    # Any IPv4 address except loopback and the all-zero bind address.
    (
        "IP address",
        re.compile(
            r"\b(?!127\.0\.0\.1\b)(?!0\.0\.0\.0\b)(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}\b"
        ),
    ),
)


def _private_path_rule() -> re.Pattern[str] | None:
    paths = [p.strip() for p in settings.lint_blocked_paths.split(",") if p.strip()]
    if not paths:
        return None
    return re.compile("(?i)(?:" + "|".join(re.escape(p) for p in paths) + ")")


def _id_prefix_rule() -> re.Pattern[str] | None:
    prefixes = [p.strip() for p in settings.lint_blocked_id_prefixes.split(",") if p.strip()]
    if not prefixes:
        return None
    joined = "|".join(re.escape(p) for p in prefixes)
    return re.compile(rf"(?i)\b(?:{joined})-\d+\b")


def find_problems(text: str) -> list[str]:
    """Names of the rules `text` breaks, empty when clean."""
    problems = [name for name, pattern in _RULES if pattern.search(text)]
    path_rule = _private_path_rule()
    if path_rule is not None and path_rule.search(text):
        problems.append("private path")
    id_rule = _id_prefix_rule()
    if id_rule is not None and id_rule.search(text):
        problems.append("private task ID")
    return problems


def clean(text: str | None, *, field: str) -> str | None:
    """Strip invisible characters and refuse text that breaks a rule (422)."""
    if text is None:
        return None
    text = _STRIP.sub("", text)
    problems = find_problems(text)
    if problems:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=(
                f"{field}: the hub refuses this text ({', '.join(problems)}). "
                "Remove it; secrets, server addresses and private notes stay out of the hub."
            ),
        )
    return text
