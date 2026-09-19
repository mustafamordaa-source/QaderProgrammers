"""KPI computation.

Everything here is derived from `tasks` + `task_events` — there is no separate
bookkeeping to keep in sync. Tasks are loaded with their event log and folded in
Python rather than aggregated in SQL: for an internal team the row counts are
small, and the per-task event walk (which needs ordering and look-ahead) stays
readable and directly unit-testable.

Attribution rule: a task's metrics are credited to its assignees, not to the
actor of each event. A leader performs every `done` transition, so actor-based
credit would hand the leader every completion; and a dual-assigned task is one
shared task, so it counts in full for both assignees.
"""

from __future__ import annotations

import statistics
from collections import Counter
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from sqlalchemy import or_, select
from sqlalchemy.orm import Session, selectinload

from app.models import EventType, Role, Task, TaskStatus, User
from app.schemas import (
    KpiReport,
    OnTimeKpi,
    QualityKpi,
    SpeedKpi,
    TeamKpiReport,
    VolumeKpi,
)

# Statuses we report dwell time for. `done` is terminal, so it has no duration.
TRACKED_STATUSES: tuple[TaskStatus, ...] = (
    TaskStatus.to_do,
    TaskStatus.in_progress_front,
    TaskStatus.in_progress_back,
    TaskStatus.in_review,
)

DEFAULT_RANGE_DAYS = 90


def _utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _naive(dt: datetime) -> datetime:
    """Normalise to naive UTC, matching how timestamps are stored."""
    if dt.tzinfo is not None:
        return dt.astimezone(timezone.utc).replace(tzinfo=None)
    return dt


def resolve_range(start: datetime | None, end: datetime | None) -> tuple[datetime, datetime]:
    """Fill in a default window and normalise to naive UTC."""
    resolved_end = _naive(end) if end else _utcnow()
    resolved_start = _naive(start) if start else resolved_end - timedelta(days=DEFAULT_RANGE_DAYS)
    if resolved_start > resolved_end:
        raise ValueError("range_start must be on or before range_end")
    return resolved_start, resolved_end


def _hours(delta: timedelta) -> float:
    return delta.total_seconds() / 3600.0


def _mean(values: Sequence[float]) -> float | None:
    return round(statistics.fmean(values), 2) if values else None


def _median(values: Sequence[float]) -> float | None:
    return round(statistics.median(values), 2) if values else None


def _rate(numerator: int, denominator: int) -> float | None:
    """A rate in [0, 1], or None when there is nothing to divide by."""
    if denominator <= 0:
        return None
    return round(numerator / denominator, 4)


@dataclass(frozen=True)
class _Interval:
    status: TaskStatus
    start: datetime
    end: datetime


def _status_intervals(task: Task) -> list[_Interval]:
    """Closed dwell intervals for one task, oldest first.

    Consecutive events that leave the status unchanged (a reassignment, say) are
    merged, so they don't split one stay into two shorter ones. The task's
    current status is still open-ended and is deliberately excluded: averaging in
    a partial stay would drag every figure toward zero.
    """
    points: list[tuple[TaskStatus, datetime]] = []
    for event in sorted(task.events, key=lambda e: (e.timestamp, e.id)):
        if event.to_status is None:
            continue
        if points and points[-1][0] == event.to_status:
            continue
        points.append((event.to_status, event.timestamp))

    intervals: list[_Interval] = []
    for (status, start), (_, end) in zip(points, points[1:]):
        if end >= start:
            intervals.append(_Interval(status=status, start=start, end=end))
    return intervals


def _closed_event(task: Task):
    """The event that ended the task's life cycle, if it has one."""
    closed = [e for e in task.events if e.event_type is EventType.closed]
    return min(closed, key=lambda e: e.timestamp) if closed else None


def _in_range(ts: datetime, start: datetime, end: datetime) -> bool:
    return start <= ts <= end


def _week_key(ts: datetime) -> str:
    iso_year, iso_week, _ = ts.isocalendar()
    return f"{iso_year}-W{iso_week:02d}"


def _month_key(ts: datetime) -> str:
    return f"{ts.year}-{ts.month:02d}"


def compute_metrics(
    tasks: Iterable[Task],
    range_start: datetime,
    range_end: datetime,
) -> tuple[SpeedKpi, QualityKpi, VolumeKpi, OnTimeKpi]:
    """Fold a set of tasks into the four KPI groups."""
    cycle_hours: list[float] = []
    dwell_hours: dict[TaskStatus, list[float]] = {s: [] for s in TRACKED_STATUSES}

    submissions = 0
    rejections = 0
    approved_tasks = 0
    first_pass_tasks = 0

    completed_total = 0
    per_week: Counter[str] = Counter()
    per_month: Counter[str] = Counter()
    open_by_status: Counter[str] = Counter()

    completed_with_due = 0
    on_time = 0

    for task in tasks:
        # --- speed: dwell time per status -------------------------------
        for interval in _status_intervals(task):
            if interval.status in dwell_hours and _in_range(interval.start, range_start, range_end):
                dwell_hours[interval.status].append(_hours(interval.end - interval.start))

        # --- quality: review submissions and rejections -----------------
        task_submissions = 0
        for event in task.events:
            if not _in_range(event.timestamp, range_start, range_end):
                continue
            if event.to_status is TaskStatus.in_review:
                submissions += 1
            if event.event_type is EventType.rejected:
                rejections += 1

        # First-pass rate is judged over the task's whole history, not just the
        # window, so a task reviewed twice never counts as a first-time pass.
        task_submissions = sum(1 for e in task.events if e.to_status is TaskStatus.in_review)

        # --- volume / on-time / cycle time ------------------------------
        closed = _closed_event(task)
        if closed is not None and _in_range(closed.timestamp, range_start, range_end):
            completed_total += 1
            per_week[_week_key(closed.timestamp)] += 1
            per_month[_month_key(closed.timestamp)] += 1
            cycle_hours.append(_hours(closed.timestamp - task.created_at))

            approved_tasks += 1
            if task_submissions == 1:
                first_pass_tasks += 1

            if task.due_date is not None:
                completed_with_due += 1
                if closed.timestamp <= task.due_date:
                    on_time += 1

        if task.status is not TaskStatus.done:
            open_by_status[task.status.value] += 1

    speed = SpeedKpi(
        avg_cycle_time_hours=_mean(cycle_hours),
        median_cycle_time_hours=_median(cycle_hours),
        avg_time_in_status_hours={s.value: _mean(dwell_hours[s]) for s in TRACKED_STATUSES},
    )
    quality = QualityKpi(
        review_submissions=submissions,
        rejections=rejections,
        rejection_rate=_rate(rejections, submissions),
        first_pass_rate=_rate(first_pass_tasks, approved_tasks),
    )
    volume = VolumeKpi(
        completed_total=completed_total,
        completed_per_week=dict(sorted(per_week.items())),
        completed_per_month=dict(sorted(per_month.items())),
        open_by_status={s.value: open_by_status.get(s.value, 0) for s in TaskStatus if s is not TaskStatus.done},
        open_total=sum(open_by_status.values()),
    )
    on_time_kpi = OnTimeKpi(
        completed_with_due_date=completed_with_due,
        on_time=on_time,
        on_time_rate=_rate(on_time, completed_with_due),
    )
    return speed, quality, volume, on_time_kpi


def _load_tasks(db: Session, user_id: int | None) -> list[Task]:
    stmt = select(Task).options(selectinload(Task.events))
    if user_id is not None:
        stmt = stmt.where(or_(Task.assignee_1_id == user_id, Task.assignee_2_id == user_id))
    return list(db.scalars(stmt).unique())


def build_report(
    db: Session,
    *,
    user: User | None,
    range_start: datetime,
    range_end: datetime,
) -> KpiReport:
    """KPIs for one programmer, or for the whole team when `user` is None."""
    tasks = _load_tasks(db, user.id if user else None)
    speed, quality, volume, on_time = compute_metrics(tasks, range_start, range_end)
    return KpiReport(
        scope="programmer" if user else "team",
        user_id=user.id if user else None,
        user_name=user.name if user else None,
        range_start=range_start,
        range_end=range_end,
        speed=speed,
        quality=quality,
        volume=volume,
        on_time=on_time,
    )


def build_team_report(db: Session, *, range_start: datetime, range_end: datetime) -> TeamKpiReport:
    """Team totals plus a per-programmer breakdown.

    Team totals are computed over the task set directly, so a dual-assigned task
    counts once for the team even though it counts in full for both assignees.
    """
    team = build_report(db, user=None, range_start=range_start, range_end=range_end)
    programmers = db.scalars(
        select(User).where(User.role == Role.programmer).order_by(User.name)
    ).all()
    return TeamKpiReport(
        **team.model_dump(),
        programmers=[
            build_report(db, user=p, range_start=range_start, range_end=range_end)
            for p in programmers
        ],
    )
