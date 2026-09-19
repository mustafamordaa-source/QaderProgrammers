"""Seed the local database with a leader, some programmers, and task history.

The history is backdated over roughly ten weeks so the KPI dashboard has
something real to show: varied cycle times, a few rejections, some overdue
completions, and a spread of still-open work.

Usage:
    python seed.py            # create the DB if needed, refuse to duplicate
    python seed.py --reset    # drop everything and start over
"""

from __future__ import annotations

import argparse
import random
from datetime import datetime, timedelta, timezone

from sqlalchemy import select

from app.database import Base, SessionLocal, engine
from app.events import log_event
from app.models import EventType, Priority, Role, Task, TaskStatus, User
from app.security import hash_password

DEMO_PASSWORD = "password123"

LEADER = {"name": "Mustafa Mordaa", "email": "leader@qader.dev"}
PROGRAMMERS = [
    {"name": "Sara Haddad", "email": "sara@qader.dev"},
    {"name": "Omar Nasser", "email": "omar@qader.dev"},
    {"name": "Lina Faris", "email": "lina@qader.dev"},
    {"name": "Yusuf Amin", "email": "yusuf@qader.dev"},
]

TASK_TITLES = [
    "Build login page and auth context",
    "Design task_events schema",
    "Kanban drag-and-drop interactions",
    "JWT refresh handling",
    "KPI aggregation queries",
    "Rejection comment modal",
    "Seed script for local demo data",
    "Dark mode tokens in Tailwind config",
    "Rate limit the login endpoint",
    "Task detail audit trail view",
    "Due-date reminders",
    "Role guard dependency tests",
    "Fix timezone drift on due dates",
    "Programmer queue empty state",
    "Cycle-time trend chart",
    "Pagination for the task list",
    "Password reset flow",
    "Export KPI report to CSV",
    "Optimise the events index",
    "Accessibility pass on the board",
    "Bulk reassign UI",
    "Error boundary for the dashboard",
    "Docker compose for local dev",
    "Retry logic on failed status writes",
]


def utc(dt: datetime) -> datetime:
    return dt.astimezone(timezone.utc).replace(tzinfo=None) if dt.tzinfo else dt


def build_users(db) -> tuple[User, list[User]]:
    leader = User(
        name=LEADER["name"],
        email=LEADER["email"],
        password_hash=hash_password(DEMO_PASSWORD),
        role=Role.leader,
    )
    db.add(leader)
    programmers = []
    for spec in PROGRAMMERS:
        user = User(
            name=spec["name"],
            email=spec["email"],
            password_hash=hash_password(DEMO_PASSWORD),
            role=Role.programmer,
        )
        db.add(user)
        programmers.append(user)
    db.flush()
    return leader, programmers


def seed_tasks(db, leader: User, programmers: list[User], rng: random.Random) -> None:
    now = datetime.now(timezone.utc).replace(tzinfo=None)

    for index, title in enumerate(TASK_TITLES):
        created_at = now - timedelta(days=rng.randint(3, 70), hours=rng.randint(0, 23))

        # Roughly a third of the tasks are shared between two programmers.
        dual = rng.random() < 0.35
        assignees = rng.sample(programmers, 2 if dual else 1)
        a1 = assignees[0]
        a2 = assignees[1] if dual else None

        priority = rng.choice(list(Priority))
        # A third of the tasks get a deadline tight enough that some will slip,
        # so the on-time rate on the dashboard isn't a flat 100%.
        if rng.random() < 0.35:
            due_date = created_at + timedelta(hours=rng.randint(24, 60))
        else:
            due_date = created_at + timedelta(days=rng.randint(4, 21))

        task = Task(
            title=title,
            description=f"Seeded sample task #{index + 1}. Replace with real work.",
            priority=priority,
            status=TaskStatus.to_do,
            due_date=due_date,
            created_by=leader.id,
            assignee_1_id=a1.id,
            assignee_2_id=a2.id if a2 else None,
            created_at=created_at,
            updated_at=created_at,
        )
        db.add(task)
        db.flush()

        log_event(
            db,
            task_id=task.id,
            actor_id=leader.id,
            event_type=EventType.created,
            to_status=TaskStatus.to_do,
            timestamp=created_at,
        )

        # How far along the workflow this task got.
        progress = rng.random()
        cursor = created_at
        current = TaskStatus.to_do

        def advance(hours_low: int, hours_high: int) -> datetime:
            nonlocal cursor
            cursor = cursor + timedelta(hours=rng.randint(hours_low, hours_high))
            return cursor

        def move(to_status: TaskStatus, actor: User, hours: tuple[int, int]) -> None:
            nonlocal current
            ts = advance(*hours)
            log_event(
                db,
                task_id=task.id,
                actor_id=actor.id,
                event_type=EventType.status_changed,
                from_status=current,
                to_status=to_status,
                timestamp=ts,
            )
            current = to_status

        if progress < 0.15:
            # Still sitting in the backlog.
            task.status = current
            task.updated_at = cursor
            continue

        # Pick the work type: backend-only, frontend-only, or both.
        work = rng.choice(["front", "back", "both"]) if dual else rng.choice(["front", "back"])
        first = TaskStatus.in_progress_back if work in ("back", "both") else TaskStatus.in_progress_front
        move(first, a1, (2, 40))

        if work == "both":
            move(TaskStatus.in_progress_front, a2 or a1, (4, 48))

        if progress < 0.4:
            task.status = current
            task.updated_at = cursor
            continue

        submitter = a2 or a1
        move(TaskStatus.in_review, submitter, (3, 36))

        # Some submissions bounce back at least once.
        if rng.random() < 0.3:
            bounce_to = rng.choice([TaskStatus.in_progress_front, TaskStatus.in_progress_back])
            ts = advance(2, 20)
            log_event(
                db,
                task_id=task.id,
                actor_id=leader.id,
                event_type=EventType.rejected,
                from_status=TaskStatus.in_review,
                to_status=bounce_to,
                comment=rng.choice(
                    [
                        "Missing tests for the new branch.",
                        "Status transition is not validated server-side.",
                        "Please handle the empty-state case.",
                        "Timestamps are being rendered in UTC on the card.",
                    ]
                ),
                timestamp=ts,
            )
            current = bounce_to
            move(TaskStatus.in_review, submitter, (5, 30))

        if progress < 0.65:
            task.status = current
            task.updated_at = cursor
            continue

        # Leader approves and closes.
        ts = advance(1, 30)
        for event_type in (EventType.approved, EventType.closed):
            log_event(
                db,
                task_id=task.id,
                actor_id=leader.id,
                event_type=event_type,
                from_status=TaskStatus.in_review,
                to_status=TaskStatus.done,
                comment="Looks good — merged." if event_type is EventType.approved else None,
                timestamp=ts,
            )
        task.status = TaskStatus.done
        task.updated_at = ts


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--reset", action="store_true", help="drop all tables first")
    parser.add_argument("--seed", type=int, default=20260919, help="RNG seed for repeatable data")
    args = parser.parse_args()

    if args.reset:
        Base.metadata.drop_all(bind=engine)
    Base.metadata.create_all(bind=engine)

    rng = random.Random(args.seed)
    db = SessionLocal()
    try:
        if db.scalar(select(User).limit(1)) is not None:
            print("Database already has users. Re-run with --reset to rebuild it.")
            return

        leader, programmers = build_users(db)
        seed_tasks(db, leader, programmers, rng)
        db.commit()

        print("Seeded the database.\n")
        print(f"  Leader      {LEADER['email']}")
        for spec in PROGRAMMERS:
            print(f"  Programmer  {spec['email']}")
        print(f"\n  Password for every account: {DEMO_PASSWORD}")
        print(f"  Tasks created: {len(TASK_TITLES)}")
    finally:
        db.close()


if __name__ == "__main__":
    main()
