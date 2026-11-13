"""Agent hub: people profiles, claims, comments, criteria, git links, API
tokens, actor kind on events, append-only triggers, one in_progress status.

Data change: tasks in in_progress_front / in_progress_back move to
in_progress with side fe / be. Event rows keep their old values (the log is
append-only); the app reads them as in_progress.

Way back: migrate.py takes no backup itself; deploy.sh copies the database to
/data/backups before running this. Restore that file to undo it.

Revision ID: 0002
Revises: 0001
"""

from alembic import op

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None

STATEMENTS = (
    # --- people -----------------------------------------------------------
    "ALTER TABLE users ADD COLUMN handle VARCHAR(40)",
    "ALTER TABLE users ADD COLUMN github_login VARCHAR(80)",
    "ALTER TABLE users ADD COLUMN sides JSON NOT NULL DEFAULT '[]'",
    "ALTER TABLE users ADD COLUMN wip_limit INTEGER NOT NULL DEFAULT 2",
    "CREATE UNIQUE INDEX ux_users_handle ON users (handle)",
    # --- tokens (before task_events.token_id refers to it) -----------------
    """CREATE TABLE api_tokens (
        id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        name VARCHAR(80) NOT NULL,
        prefix VARCHAR(16) NOT NULL,
        secret_hash VARCHAR(64) NOT NULL,
        scopes JSON NOT NULL,
        created_at DATETIME NOT NULL,
        expires_at DATETIME NOT NULL,
        last_used_at DATETIME,
        revoked_at DATETIME,
        PRIMARY KEY (id),
        UNIQUE (prefix),
        FOREIGN KEY(user_id) REFERENCES users (id)
    )""",
    "CREATE INDEX ix_api_tokens_user_id ON api_tokens (user_id)",
    # --- tasks ------------------------------------------------------------
    "ALTER TABLE tasks ADD COLUMN side VARCHAR(7)",
    "ALTER TABLE tasks ADD COLUMN tags JSON NOT NULL DEFAULT '[]'",
    "ALTER TABLE tasks ADD COLUMN areas JSON NOT NULL DEFAULT '[]'",
    "ALTER TABLE tasks ADD COLUMN summary TEXT",
    "ALTER TABLE tasks ADD COLUMN version INTEGER NOT NULL DEFAULT 1",
    "ALTER TABLE tasks ADD COLUMN restricted BOOLEAN NOT NULL DEFAULT 0",
    "ALTER TABLE tasks ADD COLUMN pool BOOLEAN NOT NULL DEFAULT 0",
    "ALTER TABLE tasks ADD COLUMN resume_status VARCHAR(17)",
    "ALTER TABLE tasks ADD COLUMN created_kind VARCHAR(6) NOT NULL DEFAULT 'human'",
    "ALTER TABLE tasks ADD COLUMN created_agent VARCHAR(80)",
    "ALTER TABLE tasks ADD COLUMN claimed_by INTEGER REFERENCES users (id)",
    "ALTER TABLE tasks ADD COLUMN claim_agent VARCHAR(80)",
    "ALTER TABLE tasks ADD COLUMN claim_branch VARCHAR(200)",
    "ALTER TABLE tasks ADD COLUMN claim_expires_at DATETIME",
    "ALTER TABLE tasks ADD COLUMN deploy_state VARCHAR(10) NOT NULL DEFAULT 'none'",
    "ALTER TABLE tasks ADD COLUMN deploy_note TEXT",
    "ALTER TABLE tasks ADD COLUMN deployed_at DATETIME",
    "ALTER TABLE tasks ADD COLUMN drop_reason TEXT",
    "CREATE INDEX ix_tasks_side ON tasks (side)",
    "UPDATE tasks SET side = 'fe', status = 'in_progress' WHERE status = 'in_progress_front'",
    "UPDATE tasks SET side = 'be', status = 'in_progress' WHERE status = 'in_progress_back'",
    # --- events -------------------------------------------------------------
    "ALTER TABLE task_events ADD COLUMN actor_kind VARCHAR(6) NOT NULL DEFAULT 'human'",
    "ALTER TABLE task_events ADD COLUMN agent_name VARCHAR(80)",
    "ALTER TABLE task_events ADD COLUMN token_id INTEGER REFERENCES api_tokens (id)",
    "ALTER TABLE task_events ADD COLUMN data JSON",
    "CREATE TRIGGER IF NOT EXISTS task_events_no_update BEFORE UPDATE ON task_events "
    "BEGIN SELECT RAISE(ABORT, 'task_events is append-only'); END",
    "CREATE TRIGGER IF NOT EXISTS task_events_no_delete BEFORE DELETE ON task_events "
    "BEGIN SELECT RAISE(ABORT, 'task_events is append-only'); END",
    # --- comments, criteria, git links -------------------------------------
    """CREATE TABLE comments (
        id INTEGER NOT NULL,
        task_id INTEGER NOT NULL,
        author_id INTEGER NOT NULL,
        actor_kind VARCHAR(6) NOT NULL,
        agent_name VARCHAR(80),
        kind VARCHAR(8) NOT NULL,
        body TEXT NOT NULL,
        parent_id INTEGER,
        to_user_id INTEGER,
        resolved_at DATETIME,
        resolved_by INTEGER,
        created_at DATETIME NOT NULL,
        PRIMARY KEY (id),
        FOREIGN KEY(task_id) REFERENCES tasks (id),
        FOREIGN KEY(author_id) REFERENCES users (id),
        FOREIGN KEY(parent_id) REFERENCES comments (id),
        FOREIGN KEY(to_user_id) REFERENCES users (id),
        FOREIGN KEY(resolved_by) REFERENCES users (id)
    )""",
    "CREATE INDEX ix_comments_task_id ON comments (task_id)",
    "CREATE INDEX ix_comments_to_user_id ON comments (to_user_id)",
    """CREATE TABLE task_criteria (
        id INTEGER NOT NULL,
        task_id INTEGER NOT NULL,
        n INTEGER NOT NULL,
        text TEXT NOT NULL,
        state VARCHAR(7) NOT NULL,
        evidence TEXT,
        checked_by INTEGER,
        checked_kind VARCHAR(6),
        checked_at DATETIME,
        created_at DATETIME NOT NULL,
        PRIMARY KEY (id),
        CONSTRAINT uq_task_criteria_n UNIQUE (task_id, n),
        FOREIGN KEY(task_id) REFERENCES tasks (id),
        FOREIGN KEY(checked_by) REFERENCES users (id)
    )""",
    "CREATE INDEX ix_task_criteria_task_id ON task_criteria (task_id)",
    """CREATE TABLE git_links (
        id INTEGER NOT NULL,
        task_id INTEGER NOT NULL,
        repo VARCHAR(200) NOT NULL,
        kind VARCHAR(6) NOT NULL,
        ref VARCHAR(200) NOT NULL,
        url VARCHAR(500),
        title VARCHAR(300),
        state VARCHAR(20),
        actor_kind VARCHAR(6) NOT NULL,
        added_by INTEGER,
        created_at DATETIME NOT NULL,
        updated_at DATETIME NOT NULL,
        PRIMARY KEY (id),
        CONSTRAINT uq_git_links_ref UNIQUE (task_id, repo, kind, ref),
        FOREIGN KEY(task_id) REFERENCES tasks (id),
        FOREIGN KEY(added_by) REFERENCES users (id)
    )""",
    "CREATE INDEX ix_git_links_task_id ON git_links (task_id)",
)


def upgrade() -> None:
    for sql in STATEMENTS:
        op.execute(sql)


def downgrade() -> None:
    # SQLite cannot drop columns on the versions some servers run; restore the
    # pre-deploy backup instead (see the module docstring).
    raise RuntimeError("Restore the pre-deploy backup to go back before 0002.")
