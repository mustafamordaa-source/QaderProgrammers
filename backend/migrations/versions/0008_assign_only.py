"""Assign-only tasks: a lead marks sensitive work that a lead must assign to a
chosen person. Every other task with no assignee is open to its side.

No data changes: every task starts as not assign-only. Way back: restore the
pre-deploy backup.

Revision ID: 0008
Revises: 0007
"""

from alembic import op

revision = "0008"
down_revision = "0007"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("ALTER TABLE tasks ADD COLUMN assign_only BOOLEAN NOT NULL DEFAULT 0")


def downgrade() -> None:
    raise RuntimeError("Restore the pre-deploy backup to go back before 0008.")
