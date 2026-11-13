"""In-process sliding-window rate limits.

The API runs one uvicorn worker (SQLite takes one writer), so a dict in memory
is the whole store. A restart clears it, which is fine for limits measured in
minutes.
"""

from __future__ import annotations

import threading
import time
from collections import defaultdict, deque

from fastapi import HTTPException, status

_WINDOW_SECONDS = 60.0
_hits: dict[str, deque[float]] = defaultdict(deque)
_lock = threading.Lock()


def hit(key: str, limit_per_minute: int) -> None:
    """Record one request for `key`; raise 429 when over the limit."""
    if limit_per_minute <= 0:
        return
    now = time.monotonic()
    with _lock:
        bucket = _hits[key]
        while bucket and now - bucket[0] >= _WINDOW_SECONDS:
            bucket.popleft()
        if len(bucket) >= limit_per_minute:
            retry = max(1, int(_WINDOW_SECONDS - (now - bucket[0])))
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail="Too many requests. Try again shortly.",
                headers={"Retry-After": str(retry)},
            )
        bucket.append(now)


def reset() -> None:
    """Clear every bucket (tests)."""
    with _lock:
        _hits.clear()
