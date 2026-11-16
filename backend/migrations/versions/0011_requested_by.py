"""Who asked for a task: managers, stakeholders, team or scan; their requests
come first in the default Impact order.

No data changes. Way back: restore the pre-deploy backup.

Revision ID: 0011
Revises: 0010
"""

from alembic import op

revision = "0011"
down_revision = "0010"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("ALTER TABLE tasks ADD COLUMN requested_by VARCHAR(12)")
    op.execute("ALTER TABLE tasks ADD COLUMN requested_by_name VARCHAR(80)")
    op.execute("ALTER TABLE tasks ADD COLUMN requested_at DATE")
    op.execute("CREATE INDEX ix_tasks_requested_by ON tasks (requested_by)")


def downgrade() -> None:
    raise RuntimeError("Restore the pre-deploy backup to go back before 0011.")
