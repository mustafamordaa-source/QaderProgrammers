"""Audience: who a task's problem reaches (students, teachers, parents,
managers, admins, team). Drives the default Impact sort.

No data changes: existing tasks start unset. Way back: restore the
pre-deploy backup.

Revision ID: 0010
Revises: 0009
"""

from alembic import op

revision = "0010"
down_revision = "0009"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("ALTER TABLE tasks ADD COLUMN audience VARCHAR(10)")
    op.execute("CREATE INDEX ix_tasks_audience ON tasks (audience)")


def downgrade() -> None:
    raise RuntimeError("Restore the pre-deploy backup to go back before 0010.")
