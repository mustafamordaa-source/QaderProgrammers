"""Task kinds, subtasks, fingerprints, task links, and PR base/merge time for
the GitHub webhook.

No data changes: every existing task becomes kind "task". Way back: restore
the pre-deploy backup.

Revision ID: 0005
Revises: 0004
"""

from alembic import op

revision = "0005"
down_revision = "0004"
branch_labels = None
depends_on = None

STATEMENTS = (
    "ALTER TABLE tasks ADD COLUMN kind VARCHAR(8) NOT NULL DEFAULT 'task'",
    "ALTER TABLE tasks ADD COLUMN parent_id INTEGER REFERENCES tasks (id)",
    "ALTER TABLE tasks ADD COLUMN fingerprint VARCHAR(200)",
    "CREATE INDEX ix_tasks_parent_id ON tasks (parent_id)",
    "CREATE INDEX ix_tasks_fingerprint ON tasks (fingerprint)",
    "ALTER TABLE git_links ADD COLUMN base_ref VARCHAR(200)",
    "ALTER TABLE git_links ADD COLUMN merged_at DATETIME",
    """CREATE TABLE task_links (
        id INTEGER NOT NULL,
        from_task_id INTEGER NOT NULL,
        to_task_id INTEGER NOT NULL,
        kind VARCHAR(10) NOT NULL,
        created_by INTEGER NOT NULL,
        actor_kind VARCHAR(6) NOT NULL,
        created_at DATETIME NOT NULL,
        PRIMARY KEY (id),
        CONSTRAINT uq_task_links UNIQUE (from_task_id, to_task_id, kind),
        CONSTRAINT ck_task_links_not_self CHECK (from_task_id != to_task_id),
        FOREIGN KEY(from_task_id) REFERENCES tasks (id),
        FOREIGN KEY(to_task_id) REFERENCES tasks (id),
        FOREIGN KEY(created_by) REFERENCES users (id)
    )""",
    "CREATE INDEX ix_task_links_from_task_id ON task_links (from_task_id)",
    "CREATE INDEX ix_task_links_to_task_id ON task_links (to_task_id)",
)


def upgrade() -> None:
    for sql in STATEMENTS:
        op.execute(sql)


def downgrade() -> None:
    raise RuntimeError("Restore the pre-deploy backup to go back before 0005.")
