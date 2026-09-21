"""Create the initial leader account.

This bootstraps a usable database: one leader, who then adds everyone else from
the People screen. It deliberately creates no sample programmers and no sample
tasks — the dashboards start empty and fill with real work.

Usage:
    python seed.py                  # create the DB if needed, refuse to duplicate
    python seed.py --reset          # drop everything and start over
    python seed.py --password '...' # set the leader's password explicitly
"""

from __future__ import annotations

import argparse

from sqlalchemy import select

from app.database import Base, SessionLocal, engine
from app.models import Role, User
from app.security import hash_password

DEFAULT_PASSWORD = "password123"

LEADER = {"name": "Mustafa Mordaa", "email": "leader@qader.dev"}


def create_leader(db, password: str) -> User:
    leader = User(
        name=LEADER["name"],
        email=LEADER["email"],
        password_hash=hash_password(password),
        role=Role.leader,
        is_active=True,
    )
    db.add(leader)
    db.flush()
    return leader


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--reset", action="store_true", help="drop all tables first")
    parser.add_argument(
        "--password",
        default=DEFAULT_PASSWORD,
        help="password for the leader account (default: %(default)s)",
    )
    args = parser.parse_args()

    if args.reset:
        Base.metadata.drop_all(bind=engine)
    Base.metadata.create_all(bind=engine)

    db = SessionLocal()
    try:
        if db.scalar(select(User).limit(1)) is not None:
            print("Database already has users. Re-run with --reset to rebuild it.")
            return

        create_leader(db, args.password)
        db.commit()

        print("Seeded the database with the leader account.\n")
        print(f"  Email     {LEADER['email']}")
        # Printed here because the login screen no longer hints at any
        # credentials — this is the only place the password is surfaced.
        print(f"  Password  {args.password}")
        if args.password == DEFAULT_PASSWORD:
            print("\n  Change this after signing in, or pass --password next time.")
        print("\nAdd the rest of the team from the People screen once you are in.")
    finally:
        db.close()


if __name__ == "__main__":
    main()
