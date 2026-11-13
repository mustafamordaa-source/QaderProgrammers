"""Migrations: an old `create_all` database upgrades in place and keeps its data.

These run against real SQLite files, because the staging database is one.
"""

from __future__ import annotations

import importlib
import sqlite3

import pytest
from sqlalchemy import create_engine, inspect, select
from sqlalchemy.orm import Session

from app.database import Base
from app.models import Side, Task, TaskEvent, TaskStatus

baseline = importlib.import_module("migrations.versions.0001_baseline")
migrate = importlib.import_module("migrate")


@pytest.fixture()
def old_db(tmp_path):
    """A database exactly as the pre-migration app left it, with history."""
    path = tmp_path / "old.db"
    conn = sqlite3.connect(path)
    for sql in baseline.STATEMENTS:
        conn.execute(sql)
    conn.execute(
        "INSERT INTO users (id, name, email, password_hash, role, is_active, created_at) "
        "VALUES (1, 'Lead', 'lead@example.com', 'x', 'leader', 1, '2026-09-20 10:00:00'), "
        "(2, 'Alice', 'alice@example.com', 'x', 'programmer', 1, '2026-09-20 10:00:00')"
    )
    conn.execute(
        "INSERT INTO tasks (id, title, priority, status, points, created_by, assignee_1_id, created_at, updated_at) "
        "VALUES (1, 'Front work', 'medium', 'in_progress_front', 3, 1, 2, '2026-09-21 09:00:00', '2026-09-21 10:00:00'), "
        "(2, 'Back work', 'high', 'in_progress_back', 5, 1, 2, '2026-09-21 09:00:00', '2026-09-21 10:00:00'), "
        "(3, 'Done work', 'low', 'done', 1, 1, 2, '2026-09-21 09:00:00', '2026-09-22 10:00:00')"
    )
    conn.execute(
        "INSERT INTO task_events (task_id, actor_id, event_type, from_status, to_status, timestamp) VALUES "
        "(1, 1, 'created', NULL, 'to_do', '2026-09-21 09:00:00'), "
        "(1, 2, 'status_changed', 'to_do', 'in_progress_front', '2026-09-21 10:00:00')"
    )
    conn.commit()
    conn.close()
    return f"sqlite:///{path.as_posix()}"


def test_old_database_is_stamped_then_upgraded(old_db):
    assert migrate.upgrade(old_db) == "0004"
    # Running it again is a no-op.
    assert migrate.upgrade(old_db) == "0004"


def test_live_tasks_move_to_in_progress_with_a_side(old_db):
    migrate.upgrade(old_db)
    engine = create_engine(old_db)
    with Session(engine) as db:
        tasks = {t.id: t for t in db.scalars(select(Task))}
        assert tasks[1].status is TaskStatus.in_progress and tasks[1].side is Side.fe
        assert tasks[2].status is TaskStatus.in_progress and tasks[2].side is Side.be
        assert tasks[3].status is TaskStatus.done and tasks[3].side is None
        assert tasks[1].tags == [] and tasks[1].version == 1
        # Old events keep their legacy values and still load.
        events = list(db.scalars(select(TaskEvent).where(TaskEvent.task_id == 1).order_by(TaskEvent.id)))
        assert events[-1].to_status is TaskStatus.in_progress_front
    engine.dispose()


def test_event_log_is_append_only_after_upgrade(old_db):
    migrate.upgrade(old_db)
    conn = sqlite3.connect(old_db.removeprefix("sqlite:///"))
    with pytest.raises(sqlite3.IntegrityError, match="append-only"):
        conn.execute("UPDATE task_events SET comment = 'edited'")
    with pytest.raises(sqlite3.IntegrityError, match="append-only"):
        conn.execute("DELETE FROM task_events")
    conn.close()


def test_migrated_schema_matches_the_models(old_db, tmp_path):
    """Every table and column the models declare exists after the upgrade."""
    migrate.upgrade(old_db)
    engine = create_engine(old_db)
    inspector = inspect(engine)
    for table in Base.metadata.sorted_tables:
        assert table.name in inspector.get_table_names(), table.name
        have = {c["name"] for c in inspector.get_columns(table.name)}
        want = {c.name for c in table.columns}
        assert want <= have, (table.name, want - have)
    engine.dispose()


def test_fresh_database_builds_from_scratch(tmp_path):
    url = f"sqlite:///{(tmp_path / 'fresh.db').as_posix()}"
    assert migrate.upgrade(url) == "0004"


def test_old_leaders_become_admin_and_lead(old_db):
    from app.models import User

    migrate.upgrade(old_db)
    engine = create_engine(old_db)
    with Session(engine) as db:
        users = {u.email: u for u in db.scalars(select(User))}
        assert users["lead@example.com"].roles == ["admin", "lead"]
        assert users["alice@example.com"].roles == ["member"]
        assert users["lead@example.com"].is_admin and not users["lead@example.com"].is_member
    engine.dispose()
