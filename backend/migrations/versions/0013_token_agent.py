"""One identity per agent on a shared bot: `api_tokens.agent_name` fixes the
agent a token acts as, and `notifications.for_agent` gives each such agent its
own copy (and read state) of a notification.

Adds two nullable columns and one index; existing rows keep NULL, which means
the old behaviour. Way back: restore the pre-deploy backup.

Revision ID: 0013
Revises: 0012
"""

from alembic import op

revision = "0013"
down_revision = "0012"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("ALTER TABLE api_tokens ADD COLUMN agent_name VARCHAR(80)")
    op.execute("ALTER TABLE notifications ADD COLUMN for_agent VARCHAR(80)")
    op.execute("CREATE INDEX ix_notifications_user_for_agent ON notifications (user_id, for_agent)")


def downgrade() -> None:
    raise RuntimeError("Restore the pre-deploy backup to go back before 0013.")
