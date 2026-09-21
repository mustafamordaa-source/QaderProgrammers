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

    db.flush()
    return leader


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

        leader = build_users(db)
        db.commit()

        print("Seeded the database.\n")
        print(f"  Leader      {LEADER['email']}")
    finally:
        db.close()


if __name__ == "__main__":
    main()
