"""Notifications: in-app list plus an email outbox, and per-person settings.

No data changes. Way back: restore the pre-deploy backup.

Revision ID: 0004
Revises: 0003
"""

from alembic import op

revision = "0004"
down_revision = "0003"
branch_labels = None
depends_on = None

STATEMENTS = (
    "ALTER TABLE users ADD COLUMN email_notifications BOOLEAN NOT NULL DEFAULT 1",
    "ALTER TABLE users ADD COLUMN notify_kinds JSON NOT NULL DEFAULT '[]'",
    "ALTER TABLE users ADD COLUMN notify_address VARCHAR(255)",
    """CREATE TABLE notifications (
        id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        task_id INTEGER NOT NULL,
        comment_id INTEGER,
        kind VARCHAR(8) NOT NULL,
        actor_id INTEGER,
        actor_kind VARCHAR(6) NOT NULL,
        agent_name VARCHAR(80),
        text TEXT,
        created_at DATETIME NOT NULL,
        read_at DATETIME,
        email_state VARCHAR(8) NOT NULL,
        email_attempts INTEGER NOT NULL,
        emailed_at DATETIME,
        email_error VARCHAR(300),
        PRIMARY KEY (id),
        FOREIGN KEY(user_id) REFERENCES users (id),
        FOREIGN KEY(task_id) REFERENCES tasks (id),
        FOREIGN KEY(comment_id) REFERENCES comments (id),
        FOREIGN KEY(actor_id) REFERENCES users (id)
    )""",
    "CREATE INDEX ix_notifications_user_id ON notifications (user_id)",
    "CREATE INDEX ix_notifications_created_at ON notifications (created_at)",
    "CREATE INDEX ix_notifications_email_state ON notifications (email_state)",
)


def upgrade() -> None:
    for sql in STATEMENTS:
        op.execute(sql)


def downgrade() -> None:
    raise RuntimeError("Restore the pre-deploy backup to go back before 0004.")
