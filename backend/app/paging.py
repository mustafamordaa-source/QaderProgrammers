"""Paging for list endpoints.

A list endpoint takes `page` (1-based) and `page_size` (default 20, at most
100). The body stays a JSON array either way:

- neither parameter sent: the endpoint answers as it did before paging
  existed (its own `limit`, no extra headers), so older clients keep working;
- either one sent: the array holds that page, and the totals travel in the
  `X-Total-Count`, `X-Page`, `X-Page-Size` and `X-Total-Pages` headers.

Endpoints must order rows by a unique key (usually with the id as the last
sort key), so two pages never share a row.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Annotated, Any, Sequence

from fastapi import Depends, Query, Response
from sqlalchemy import Select, func, select
from sqlalchemy.orm import Session

DEFAULT_PAGE_SIZE = 20
MAX_PAGE_SIZE = 100

# Browsers on another origin read only the headers named here (see main.py).
PAGING_HEADERS = ("X-Total-Count", "X-Page", "X-Page-Size", "X-Total-Pages", "X-Total-Points")


@dataclass
class Paging:
    page: int | None = None
    page_size: int | None = None

    @property
    def on(self) -> bool:
        return self.page is not None or self.page_size is not None

    @property
    def number(self) -> int:
        return self.page or 1

    @property
    def size(self) -> int:
        return self.page_size or DEFAULT_PAGE_SIZE

    @property
    def offset(self) -> int:
        return (self.number - 1) * self.size

    def set_headers(self, response: Response, total: int, **extra: Any) -> None:
        response.headers["X-Total-Count"] = str(total)
        response.headers["X-Page"] = str(self.number)
        response.headers["X-Page-Size"] = str(self.size)
        response.headers["X-Total-Pages"] = str(max(1, -(-total // self.size)))
        for name, value in extra.items():
            response.headers[name.replace("_", "-")] = str(value)

    def slice(self, rows: Sequence, response: Response, **extra: Any) -> list:
        """One page of an in-memory list, with the headers set."""
        self.set_headers(response, len(rows), **extra)
        return list(rows[self.offset : self.offset + self.size])

    def window(self, stmt: Select) -> Select:
        return stmt.offset(self.offset).limit(self.size)


def count_rows(db: Session, stmt: Select) -> int:
    """Rows a filtered select matches. Pass the statement before ordering,
    loader options and limits are added."""
    return db.scalar(select(func.count()).select_from(stmt.order_by(None).subquery())) or 0


def paging_params(
    page: int | None = Query(default=None, ge=1, description="Page number, from 1. Totals come in the X-Total-* headers."),
    page_size: int | None = Query(
        default=None, ge=1, le=MAX_PAGE_SIZE, description=f"Rows per page (default {DEFAULT_PAGE_SIZE}, at most {MAX_PAGE_SIZE})"
    ),
) -> Paging:
    return Paging(page=page, page_size=page_size)


Page = Annotated[Paging, Depends(paging_params)]
