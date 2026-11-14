"""Product areas: a shared, searchable list tasks belong to (payments, exams,
...), with aliases, a parent and merges.

No data changes: existing tasks have no area until someone sets one. Way back:
restore the pre-deploy backup.

Revision ID: 0006
Revises: 0005
"""

from alembic import op

revision = "0006"
down_revision = "0005"
branch_labels = None
depends_on = None

STATEMENTS = (
    """CREATE TABLE areas_list (
        id INTEGER NOT NULL,
        slug VARCHAR(60) NOT NULL,
        name VARCHAR(120) NOT NULL,
        description TEXT,
        aliases JSON NOT NULL,
        parent_id INTEGER,
        merged_into_id INTEGER,
        created_by INTEGER NOT NULL,
        actor_kind VARCHAR(6) NOT NULL,
        created_at DATETIME NOT NULL,
        PRIMARY KEY (id),
        UNIQUE (slug),
        FOREIGN KEY(parent_id) REFERENCES areas_list (id),
        FOREIGN KEY(merged_into_id) REFERENCES areas_list (id),
        FOREIGN KEY(created_by) REFERENCES users (id)
    )""",
    "ALTER TABLE tasks ADD COLUMN area_id INTEGER REFERENCES areas_list (id)",
    "CREATE INDEX ix_tasks_area_id ON tasks (area_id)",
)


def upgrade() -> None:
    for sql in STATEMENTS:
        op.execute(sql)


def downgrade() -> None:
    raise RuntimeError("Restore the pre-deploy backup to go back before 0006.")
