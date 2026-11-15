"""Parts people can take: a criterion can point at the subtask made from it.
Imported tasks become pool tasks, so anyone on their side can claim them.

Data change: tasks imported with an external key and no assignee get
pool = 1. Way back: restore the pre-deploy backup.

Revision ID: 0007
Revises: 0006
"""

from alembic import op

revision = "0007"
down_revision = "0006"
branch_labels = None
depends_on = None

STATEMENTS = (
    "ALTER TABLE task_criteria ADD COLUMN subtask_id INTEGER REFERENCES tasks (id)",
    "CREATE INDEX ix_task_criteria_subtask_id ON task_criteria (subtask_id)",
    "UPDATE tasks SET pool = 1 WHERE fingerprint LIKE 'ext:%' "
    "AND assignee_1_id IS NULL AND assignee_2_id IS NULL",
)


def upgrade() -> None:
    for sql in STATEMENTS:
        op.execute(sql)


def downgrade() -> None:
    raise RuntimeError("Restore the pre-deploy backup to go back before 0007.")
