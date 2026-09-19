"""Test fixtures: an isolated in-memory database per test, plus logged-in clients."""

from __future__ import annotations

from datetime import datetime, timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base, get_db
from app.main import app
from app.models import Priority, Role, Task, TaskStatus, User
from app import security as security_module

PASSWORD = "test-password"


@pytest.fixture(autouse=True)
def _fast_password_hashing(monkeypatch):
    """Drop bcrypt to its minimum cost.

    The suite hashes a password for every fixture user; at the production work
    factor that alone dominates the run time.
    """
    from passlib.context import CryptContext

    monkeypatch.setattr(
        security_module,
        "pwd_context",
        CryptContext(schemes=["bcrypt"], deprecated="auto", bcrypt__rounds=4),
    )


@pytest.fixture()
def db_session():
    # StaticPool keeps every connection pointed at the same in-memory database,
    # so the app and the test share one view of it.
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(bind=engine)
    TestingSession = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    session = TestingSession()
    try:
        yield session
    finally:
        session.close()
        Base.metadata.drop_all(bind=engine)
        engine.dispose()


@pytest.fixture()
def client(db_session):
    def override_get_db():
        yield db_session

    app.dependency_overrides[get_db] = override_get_db
    with TestClient(app) as test_client:
        yield test_client
    app.dependency_overrides.clear()


def make_user(db, name: str, email: str, role: Role) -> User:
    user = User(
        name=name,
        email=email,
        password_hash=security_module.hash_password(PASSWORD),
        role=role,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


@pytest.fixture()
def leader(db_session) -> User:
    return make_user(db_session, "Lead", "lead@example.com", Role.leader)


@pytest.fixture()
def alice(db_session) -> User:
    return make_user(db_session, "Alice", "alice@example.com", Role.programmer)


@pytest.fixture()
def bob(db_session) -> User:
    return make_user(db_session, "Bob", "bob@example.com", Role.programmer)


@pytest.fixture()
def carol(db_session) -> User:
    return make_user(db_session, "Carol", "carol@example.com", Role.programmer)


@pytest.fixture()
def auth(client):
    """Return an Authorization header factory for a given user."""

    def _auth(user: User) -> dict[str, str]:
        response = client.post(
            "/auth/login", json={"email": user.email, "password": PASSWORD}
        )
        assert response.status_code == 200, response.text
        return {"Authorization": f"Bearer {response.json()['access_token']}"}

    return _auth


@pytest.fixture()
def make_task(db_session, leader):
    """Insert a task directly, bypassing the API, for arranging test state."""

    def _make(
        *,
        title: str = "Task",
        status: TaskStatus = TaskStatus.to_do,
        assignee_1: User | None = None,
        assignee_2: User | None = None,
        due_in_days: int | None = None,
        created_at: datetime | None = None,
    ) -> Task:
        created = created_at or datetime(2026, 1, 1, 9, 0, 0)
        task = Task(
            title=title,
            description=None,
            priority=Priority.medium,
            status=status,
            due_date=created + timedelta(days=due_in_days) if due_in_days is not None else None,
            created_by=leader.id,
            assignee_1_id=assignee_1.id if assignee_1 else None,
            assignee_2_id=assignee_2.id if assignee_2 else None,
            created_at=created,
            updated_at=created,
        )
        db_session.add(task)
        db_session.commit()
        db_session.refresh(task)
        return task

    return _make
