"""Bots that work: `users.can_work` lets an admin turn a bot account into a
worker that can be assigned, claim, take parts and hand back like a member.

Adds one column, false for every existing row. Way back: restore the
pre-deploy backup.

Revision ID: 0012
Revises: 0011
"""

from alembic import op

revision = "0012"
down_revision = "0011"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("ALTER TABLE users ADD COLUMN can_work BOOLEAN NOT NULL DEFAULT 0")


def downgrade() -> None:
    raise RuntimeError("Restore the pre-deploy backup to go back before 0012.")
