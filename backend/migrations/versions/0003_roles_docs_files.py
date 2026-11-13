"""Access roles (several per person), bot accounts, task documents with
versions, file attachments and context links.

Data change: `users.roles` is filled from the old single role:
leader -> admin + lead, programmer -> member, viewer -> viewer. The old `role`
column stays and the app keeps it in step for older clients.

Way back: deploy.sh copies the database to /data/backups before this runs.
Restore that file to undo it.

Revision ID: 0003
Revises: 0002
"""

from alembic import op

revision = "0003"
down_revision = "0002"
branch_labels = None
depends_on = None

STATEMENTS = (
    "ALTER TABLE users ADD COLUMN roles JSON NOT NULL DEFAULT '[]'",
    "ALTER TABLE users ADD COLUMN account_type VARCHAR(6) NOT NULL DEFAULT 'person'",
    """UPDATE users SET roles = CASE role
        WHEN 'leader' THEN '["admin", "lead"]'
        WHEN 'programmer' THEN '["member"]'
        ELSE '["viewer"]' END""",
    """CREATE TABLE task_docs (
        id INTEGER NOT NULL,
        task_id INTEGER NOT NULL,
        slug VARCHAR(60) NOT NULL,
        title VARCHAR(200) NOT NULL,
        kind VARCHAR(9) NOT NULL,
        current_version INTEGER NOT NULL,
        created_by INTEGER NOT NULL,
        created_at DATETIME NOT NULL,
        updated_at DATETIME NOT NULL,
        PRIMARY KEY (id),
        CONSTRAINT uq_task_docs_slug UNIQUE (task_id, slug),
        FOREIGN KEY(task_id) REFERENCES tasks (id),
        FOREIGN KEY(created_by) REFERENCES users (id)
    )""",
    "CREATE INDEX ix_task_docs_task_id ON task_docs (task_id)",
    """CREATE TABLE task_doc_versions (
        id INTEGER NOT NULL,
        doc_id INTEGER NOT NULL,
        n INTEGER NOT NULL,
        title VARCHAR(200) NOT NULL,
        body TEXT NOT NULL,
        note VARCHAR(300),
        author_id INTEGER NOT NULL,
        actor_kind VARCHAR(6) NOT NULL,
        agent_name VARCHAR(80),
        created_at DATETIME NOT NULL,
        PRIMARY KEY (id),
        CONSTRAINT uq_task_doc_versions_n UNIQUE (doc_id, n),
        FOREIGN KEY(doc_id) REFERENCES task_docs (id),
        FOREIGN KEY(author_id) REFERENCES users (id)
    )""",
    "CREATE INDEX ix_task_doc_versions_doc_id ON task_doc_versions (doc_id)",
    # Versions are history: like the event log, they are never edited.
    "CREATE TRIGGER IF NOT EXISTS task_doc_versions_no_update BEFORE UPDATE ON task_doc_versions "
    "BEGIN SELECT RAISE(ABORT, 'task_doc_versions is append-only'); END",
    """CREATE TABLE task_files (
        id INTEGER NOT NULL,
        task_id INTEGER NOT NULL,
        name VARCHAR(200) NOT NULL,
        mime VARCHAR(100) NOT NULL,
        size INTEGER NOT NULL,
        sha256 VARCHAR(64) NOT NULL,
        note VARCHAR(300),
        uploaded_by INTEGER NOT NULL,
        actor_kind VARCHAR(6) NOT NULL,
        agent_name VARCHAR(80),
        removed_at DATETIME,
        created_at DATETIME NOT NULL,
        PRIMARY KEY (id),
        FOREIGN KEY(task_id) REFERENCES tasks (id),
        FOREIGN KEY(uploaded_by) REFERENCES users (id)
    )""",
    "CREATE INDEX ix_task_files_task_id ON task_files (task_id)",
    """CREATE TABLE task_context (
        id INTEGER NOT NULL,
        task_id INTEGER NOT NULL,
        kind VARCHAR(9) NOT NULL,
        repo VARCHAR(200),
        path VARCHAR(400),
        ref VARCHAR(200),
        "commit" VARCHAR(40),
        url VARCHAR(500),
        title VARCHAR(200) NOT NULL,
        summary TEXT,
        added_by INTEGER NOT NULL,
        actor_kind VARCHAR(6) NOT NULL,
        agent_name VARCHAR(80),
        created_at DATETIME NOT NULL,
        PRIMARY KEY (id),
        FOREIGN KEY(task_id) REFERENCES tasks (id),
        FOREIGN KEY(added_by) REFERENCES users (id)
    )""",
    "CREATE INDEX ix_task_context_task_id ON task_context (task_id)",
)


def upgrade() -> None:
    for sql in STATEMENTS:
        op.execute(sql)


def downgrade() -> None:
    raise RuntimeError("Restore the pre-deploy backup to go back before 0003.")
