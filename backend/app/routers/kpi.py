"""KPI routes. Leaders see everything; programmers see only themselves."""

from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query, status

from app.deps import CurrentUser, DbSession, require_leader
from app.kpi import build_report, build_team_report, resolve_range
from app.models import Role, User
from app.schemas import KpiReport, TeamKpiReport

router = APIRouter(prefix="/kpi", tags=["kpi"])

RangeStart = Query(default=None, description="Inclusive UTC start of the reporting window")
RangeEnd = Query(default=None, description="Inclusive UTC end of the reporting window")


def _resolve(start: datetime | None, end: datetime | None) -> tuple[datetime, datetime]:
    try:
        return resolve_range(start, end)
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc)
        ) from None


@router.get("/team", response_model=TeamKpiReport)
def team_kpi(
    db: DbSession,
    leader: User = Depends(require_leader),
    range_start: datetime | None = RangeStart,
    range_end: datetime | None = RangeEnd,
) -> TeamKpiReport:
    start, end = _resolve(range_start, range_end)
    return build_team_report(db, range_start=start, range_end=end)


@router.get("/me", response_model=KpiReport)
def my_kpi(
    user: CurrentUser,
    db: DbSession,
    range_start: datetime | None = RangeStart,
    range_end: datetime | None = RangeEnd,
) -> KpiReport:
    start, end = _resolve(range_start, range_end)
    # A leader asking for "me" gets the team view, since they own no tasks.
    scope = None if user.role is Role.leader else user
    return build_report(db, user=scope, range_start=start, range_end=end)


@router.get("/programmer/{user_id}", response_model=KpiReport)
def programmer_kpi(
    user_id: int,
    db: DbSession,
    leader: User = Depends(require_leader),
    range_start: datetime | None = RangeStart,
    range_end: datetime | None = RangeEnd,
) -> KpiReport:
    target = db.get(User, user_id)
    if target is None or target.role is not Role.programmer:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Programmer not found")
    start, end = _resolve(range_start, range_end)
    return build_report(db, user=target, range_start=start, range_end=end)
