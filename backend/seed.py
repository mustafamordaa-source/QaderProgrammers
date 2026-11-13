"""Create the initial leader account.

This bootstraps a usable database: one leader, who then adds everyone else from
the People screen. It deliberately creates no sample programmers and no sample
tasks — the dashboards start empty and fill with real work.

Usage:
    python seed.py --email you@example.com --name "Your Name"
    python seed.py --password '...'   # pick the password yourself (else a random one)
    python seed.py --reset            # local only: drop everything and start over

There is no default password. Without --password the script generates a random
one and prints it once.
"""

from __future__ import annotations

import argparse
import secrets

from sqlalchemy import select

from app.config import settings
from app.database import Base, SessionLocal, engine
from app.models import Role, User
from app.schemas import MIN_PASSWORD_LENGTH
from app.security import hash_password
from migrate import upgrade


def create_leader(db, *, name: str, email: str, password: str) -> User:
    leader = User(
        name=name,
        email=email.lower(),
        password_hash=hash_password(password),
        role=Role.leader,
        is_active=True,
    )
    db.add(leader)
    db.flush()
    return leader


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--reset", action="store_true", help="drop all tables first (refused in production)")
    parser.add_argument("--email", default="leader@example.com", help="the leader's login email")
    parser.add_argument("--name", default="Team Leader", help="the leader's display name")
    parser.add_argument("--password", default=None, help="the leader's password (default: random)")
    args = parser.parse_args()

    if args.reset:
        if settings.app_env.lower() == "production":
            raise SystemExit("--reset is refused in production: it deletes every task and event.")
        Base.metadata.drop_all(bind=engine)
        with engine.begin() as conn:
            conn.exec_driver_sql("DROP TABLE IF EXISTS alembic_version")
    upgrade()

    password = args.password or secrets.token_urlsafe(12)
    if len(password) < MIN_PASSWORD_LENGTH:
        raise SystemExit(f"The password needs at least {MIN_PASSWORD_LENGTH} characters.")

    db = SessionLocal()
    try:
        if db.scalar(select(User).limit(1)) is not None:
            print("Database already has users. Nothing to do.")
            return

        create_leader(db, name=args.name, email=args.email, password=password)
        db.commit()

        print("Seeded the database with the leader account.\n")
        print(f"  Email     {args.email.lower()}")
        if args.password:
            print("  Password  (the one you passed)")
        else:
            # Printed once, to this terminal only. Not logged anywhere else.
            print(f"  Password  {password}")
            print("\n  Store it in your password manager now; it is not shown again.")
        print("\nAdd the rest of the team from the People screen once you are in.")
    finally:
        db.close()


if __name__ == "__main__":
    main()
