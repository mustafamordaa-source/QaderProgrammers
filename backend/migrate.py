"""Bring the database schema up to date.

    python migrate.py            # upgrade to the newest revision
    python migrate.py --check    # print the current and newest revision, change nothing

A database made by the old `create_all` start-up (it has a `users` table but no
`alembic_version`) is stamped at the baseline first, then upgraded.
"""

from __future__ import annotations

import argparse
from pathlib import Path

from alembic import command
from alembic.config import Config
from alembic.runtime.migration import MigrationContext
from alembic.script import ScriptDirectory
from sqlalchemy import create_engine, inspect

from app.config import settings

HERE = Path(__file__).resolve().parent
BASELINE = "0001"


def _config(url: str) -> Config:
    cfg = Config(str(HERE / "alembic.ini"))
    cfg.set_main_option("script_location", str(HERE / "migrations"))
    cfg.set_main_option("sqlalchemy.url", url)
    return cfg


def current_revision(url: str) -> str | None:
    engine = create_engine(url)
    try:
        with engine.connect() as conn:
            return MigrationContext.configure(conn).get_current_revision()
    finally:
        engine.dispose()


def upgrade(url: str | None = None) -> str | None:
    url = url or settings.database_url
    cfg = _config(url)
    engine = create_engine(url)
    try:
        tables = set(inspect(engine).get_table_names())
    finally:
        engine.dispose()
    if "users" in tables and "alembic_version" not in tables:
        print(f"Existing pre-migration database: stamping baseline {BASELINE}.")
        command.stamp(cfg, BASELINE)
    command.upgrade(cfg, "head")
    return current_revision(url)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--check", action="store_true", help="report revisions only")
    args = parser.parse_args()
    url = settings.database_url
    head = ScriptDirectory.from_config(_config(url)).get_current_head()
    if args.check:
        print(f"current: {current_revision(url)}  newest: {head}")
        return
    print(f"Schema at {upgrade(url)} (newest {head}).")


if __name__ == "__main__":
    main()
