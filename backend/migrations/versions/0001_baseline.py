"""Baseline: the schema as `create_all` built it before migrations existed.

A database made before Alembic gets stamped at this revision by migrate.py
instead of running it. A fresh database runs it.

Revision ID: 0001
Revises:
"""

from alembic import op

revision = "0001"
down_revision = None
branch_labels = None
depends_on = None

STATEMENTS = (
    """CREATE TABLE users (
        id INTEGER NOT NULL,
        name VARCHAR(120) NOT NULL,
        email VARCHAR(255) NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        role VARCHAR(10) NOT NULL,
        is_active BOOLEAN NOT NULL,
        created_at DATETIME NOT NULL,
        PRIMARY KEY (id)
    )""",
    "CREATE UNIQUE INDEX ix_users_email ON users (email)",
    """CREATE TABLE tasks (
        id INTEGER NOT NULL,
        title VARCHAR(200) NOT NULL,
        description TEXT,
        priority VARCHAR(6) NOT NULL,
        status VARCHAR(17) NOT NULL,
        due_date DATETIME,
        points INTEGER NOT NULL,
        created_by INTEGER NOT NULL,
        assignee_1_id INTEGER,
        assignee_2_id INTEGER,
        created_at DATETIME NOT NULL,
        updated_at DATETIME NOT NULL,
        PRIMARY KEY (id),
        CONSTRAINT ck_tasks_distinct_assignees CHECK (assignee_2_id IS NULL OR assignee_1_id IS NULL OR assignee_1_id != assignee_2_id),
        CONSTRAINT ck_tasks_points_on_scale CHECK (points IN (1, 2, 3, 5, 8, 13)),
        FOREIGN KEY(created_by) REFERENCES users (id),
        FOREIGN KEY(assignee_1_id) REFERENCES users (id),
        FOREIGN KEY(assignee_2_id) REFERENCES users (id)
    )""",
    "CREATE INDEX ix_tasks_assignee_1_id ON tasks (assignee_1_id)",
    "CREATE INDEX ix_tasks_assignee_2_id ON tasks (assignee_2_id)",
    "CREATE INDEX ix_tasks_status ON tasks (status)",
    "CREATE INDEX ix_tasks_created_at ON tasks (created_at)",
    """CREATE TABLE task_events (
        id INTEGER NOT NULL,
        task_id INTEGER NOT NULL,
        actor_id INTEGER NOT NULL,
        event_type VARCHAR(14) NOT NULL,
        from_status VARCHAR(17),
        to_status VARCHAR(17),
        comment TEXT,
        timestamp DATETIME NOT NULL,
        PRIMARY KEY (id),
        FOREIGN KEY(task_id) REFERENCES tasks (id),
        FOREIGN KEY(actor_id) REFERENCES users (id)
    )""",
    "CREATE INDEX ix_task_events_task_id ON task_events (task_id)",
    "CREATE INDEX ix_task_events_actor_id ON task_events (actor_id)",
    "CREATE INDEX ix_task_events_timestamp ON task_events (timestamp)",
    "CREATE INDEX ix_task_events_task_ts ON task_events (task_id, timestamp)",
)


def upgrade() -> None:
    for sql in STATEMENTS:
        op.execute(sql)


def downgrade() -> None:
    for table in ("task_events", "tasks", "users"):
        op.execute(f"DROP TABLE {table}")
