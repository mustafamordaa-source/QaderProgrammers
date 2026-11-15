"""Claims follow activity: remember when an idle holder was reminded.

Data change: claims live at upgrade time move to the 48-hour clock, so the
sweep does not free them at their old 2 to 8 hour end. Way back: restore the
pre-deploy backup.

Revision ID: 0009
Revises: 0008
"""

from alembic import op

revision = "0009"
down_revision = "0008"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("ALTER TABLE tasks ADD COLUMN claim_warned_at DATETIME")
    op.execute(
        "UPDATE tasks SET claim_expires_at = strftime('%Y-%m-%d %H:%M:%S', 'now', '+48 hours') "
        "WHERE claimed_by IS NOT NULL AND claim_expires_at > strftime('%Y-%m-%d %H:%M:%S', 'now')"
    )


def downgrade() -> None:
    raise RuntimeError("Restore the pre-deploy backup to go back before 0009.")
