# TaskFlow

Internal task management and delivery metrics for a small software team — one
leader and a handful of programmers. Tasks move through a fixed five-stage
workflow, can be shared by two programmers at once, and every transition is
written to an append-only event log that the KPI dashboard is computed from.

- **Backend** — FastAPI, SQLAlchemy 2.0, SQLite, JWT auth
- **Frontend** — React (Vite), Tailwind CSS, Recharts

---

## Quick start

Two terminals. Python 3.11+ and Node 18+ required.

### 1. Backend

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -r requirements.txt

python seed.py --reset             # create the DB with demo data
uvicorn app.main:app --reload      # http://127.0.0.1:8000
```

Interactive API docs: <http://127.0.0.1:8000/docs>

### 2. Frontend

```bash
cd frontend
npm install
npm run dev                        # http://127.0.0.1:5173
```

The Vite dev server proxies `/auth`, `/tasks`, `/users` and `/kpi` to the backend, so the
browser only ever talks to one origin and there is nothing to configure. For a
production build pointed at another host, set `VITE_API_URL`.

### Demo accounts

| Role | Email | Password |
|---|---|---|
| Leader | `leader@qader.dev` | `password123` |
| Programmer | `sara@qader.dev` | `password123` |
| Programmer | `omar@qader.dev` | `password123` |
| Programmer | `lina@qader.dev` | `password123` |
| Programmer | `yusuf@qader.dev` | `password123` |

The seed script backdates roughly ten weeks of task history — varied cycle
times, some rejections, some missed deadlines — so the KPI dashboard has real
numbers on first run. Re-running it is a no-op unless you pass `--reset`.

### Tests

```bash
cd backend
.venv/bin/python -m pytest         # 122 tests
```

They cover the transition matrix, the role guards, task visibility, user
management and the KPI arithmetic, each against a fresh in-memory database.

```bash
cd frontend
npm run check:routes               # client routes vs API paths (also runs on build)
```

---

## Roles

**Leader** creates tasks, sets priority, due date and assignees, and is the only
role that can move a task to Done. Sees every task and every programmer's
metrics, can reassign or edit anything, and manages accounts (see
[People](#people)).

**Programmer** sees only tasks assigned to them. Can move their own work
forward through the in-progress stages and into review. Cannot create, delete,
reassign or complete tasks, and sees only their own metrics.

Roles are enforced by a FastAPI dependency (`app/deps.py`), not by ad-hoc checks
in each endpoint.

## Workflow

```
              ┌──────────────────────┐
              ▼                      │  (leader only, comment required)
to_do ──┬──▶ in_progress_front ──┬──▶ in_review ──▶ done   (leader only)
        │         ▲    │         │        │
        │         │    ▼         │        │
        └──▶ in_progress_back ───┘        │
                  ▲                       │
                  └───────────────────────┘
```

A task only passes through the stages its work actually needs — frontend-only,
backend-only, or both. The two in-progress stages are reachable from each other,
so a shared task can do backend work and then frontend work without a round
trip through review.

The whole matrix lives in `backend/app/transitions.py`. Nothing reaches `done`
except from `in_review`, no programmer can write `done`, and `done` is terminal.
The frontend mirrors these rules in `frontend/src/lib/constants.js` purely so
the UI offers only moves that will be accepted — the server re-validates every
request regardless.

## Dual assignment

A task has `assignee_1_id` and `assignee_2_id`, both nullable. With two
assignees it stays **one shared task**: both see it in their queue and either
one can move it along. It is never split into subtasks. Every transition
records which programmer made it, so the audit trail stays precise even though
the task is shared.

## People

The leader's **People** screen creates accounts, edits names, emails and roles,
resets passwords, and deactivates or reactivates people. Leaders can promote
other leaders, so the role is handed over rather than being a fixed singleton.

**Accounts are deactivated, never deleted.** `tasks` and `task_events` both
carry non-nullable foreign keys into `users`, so a hard delete would either be
refused by the database or take the audit log — and with it every KPI — along
with the account. Deactivating sets `is_active = false`, which:

- blocks login, and **revokes any token the person already holds** — the guard
  is in `get_current_user`, so an open session stops working on its next
  request rather than lasting until the token expires;
- removes them from the assignment pickers, and rejects any attempt to assign
  them new work;
- leaves their existing tasks, event history and metrics untouched.

Deactivating someone who still holds open tasks is allowed, but the dialog
shows how many and warns that those tasks will sit in a queue nobody can act
on. Reassign them from the board first if the work needs to continue.

One rule is enforced server-side and cannot be clicked past: **a change may not
leave the system with no active leader.** Demoting or deactivating the last
active leader returns `409`, because there would be no way left to approve work
or restore anyone's access. Handing over works fine — promote someone first,
then demote yourself.

## Data model

**users** — id, name, email, password_hash, role, is_active, created_at

**tasks** — id, title, description, priority, status, due_date, created_by,
assignee_1_id, assignee_2_id, created_at, updated_at

**task_events** — id, task_id, actor_id, event_type, from_status, to_status,
comment, timestamp

`task_events` is append-only and is the sole input to every KPI. Event types:

| Event | When |
|---|---|
| `created` | A leader creates the task |
| `status_changed` | Any ordinary move between stages |
| `rejected` | A leader sends work back out of review (comment required) |
| `approved` | A leader accepts work out of review |
| `closed` | The task's life cycle ends |

Approving writes `approved` **and** `closed` in one transaction. They are
separate KPI inputs: `approved` feeds the review pass rate, `closed` marks the
end of the cycle and anchors cycle time and the on-time check.

All timestamps are stored as naive UTC and converted to the viewer's local time
in the browser (`frontend/src/lib/format.js`).

## KPIs

Computed per programmer and for the team, over a selectable date range. All of
it is derived from `tasks` + `task_events`; there is no separate bookkeeping.

**Speed** — average and median cycle time (created → closed), plus average
dwell time in `to_do`, `in_progress_front`, `in_progress_back` and `in_review`,
and a per-week cycle-time series for the trend chart.

**Quality** — rejection rate (`rejected` events ÷ review submissions) and
first-pass rate (tasks approved on a single submission ÷ tasks completed).

**Volume** — completions per week and per month, plus currently-open tasks
broken down by status.

**On-time** — share of completed tasks closed on or before their due date.
Tasks without a due date are excluded from the denominator rather than counted
as successes.

### Two decisions worth knowing about

**Credit follows assignment, not the actor.** A leader performs every `done`
transition, so crediting `task_events.actor_id` would hand the leader every
completion in the system. Metrics are instead attributed to a task's assignees.
A dual-assigned task counts in full for *both* of them, while the team total
counts it once — so the per-programmer figures deliberately sum to more than
the team figure.

**Open stages are excluded from dwell-time averages.** A task sitting in review
right now has an unfinished stay; averaging it in would drag every figure toward
zero. Currently-open work is reported separately as a count by status. Dwell
time also merges consecutive events that leave the status unchanged, so a
reassignment does not split one six-hour stay into two three-hour ones.

## API

```
POST   /auth/login                 email + password → JWT
GET    /auth/me                    current user
GET    /auth/users?role=           active-user directory (for the assignment UI)

GET    /users                      leader only — everyone, with open-task counts
POST   /users                      leader only — create an account
PATCH  /users/{id}                 leader only — name, email, role, is_active
POST   /users/{id}/password        leader only — reset a password

POST   /tasks                      leader only — create and assign
GET    /tasks                      leader: all · programmer: own queue only
GET    /tasks/{id}                 includes the full event log
PATCH  /tasks/{id}                 leader only — edit title/priority/due date
PATCH  /tasks/{id}/status          move a task; validated server-side
PATCH  /tasks/{id}/assign          leader only — reassign
POST   /tasks/{id}/reject          leader only — back to in-progress, comment required

GET    /kpi/team                   leader only — team totals + per-programmer
GET    /kpi/me                     own metrics
GET    /kpi/programmer/{id}        leader only
GET    /health
```

KPI endpoints accept optional `range_start` and `range_end` (ISO 8601, UTC);
they default to the last 90 days.

Error conventions: `401` unauthenticated, `403` wrong role, `404` missing *or
not visible to you* (so the API never confirms a task exists to someone who
shouldn't see it), `409` an illegal status transition, `422` invalid input.

## Project layout

```
backend/
  app/
    main.py            app wiring, CORS, create_all
    config.py          settings from the environment
    database.py        engine, session factory, get_db
    models.py          User, Task, TaskEvent
    schemas.py         request/response models
    security.py        password hashing, JWT encode/decode
    deps.py            get_current_user + role guards
    transitions.py     the transition matrix — the workflow rules
    events.py          audit-log helper
    kpi/service.py     all KPI computation
    routers/           auth, tasks, kpi
  seed.py              demo accounts + backdated history
  tests/               pytest suite

frontend/
  src/
    api/client.js      fetch wrapper, token storage, error shaping
    auth/              AuthContext + route guard
    lib/               status constants, UTC → local formatting
    components/        board (kanban, cards, modals), kpi (charts, tiles), users
    pages/             Login, Board, KPI, Users
  scripts/
    check-routes.mjs   guards against client routes colliding with API paths
```

### Client routes vs API paths

The client routes are `/login`, `/board`, `/metrics` and `/people`. None of them
may share a prefix with an API path (`/auth`, `/tasks`, `/users`, `/kpi`,
`/health`), because the Vite dev proxy matches by prefix: a client route named
after an API prefix gets handed to the backend on any hard page load — a
refresh, a pasted link, a bookmark — while clicking through the app still works.
That is why the metrics page is `/metrics` and not `/kpi`, and the people page
is `/people` and not `/users`.

`npm run check:routes` enforces this, and `npm run build` runs it first.

## Configuration

Backend settings come from the environment (or a `backend/.env` file):

| Variable | Default | Notes |
|---|---|---|
| `SECRET_KEY` | `dev-secret-change-me` | **Change this outside local development** |
| `DATABASE_URL` | `sqlite:///./taskflow.db` | |
| `ACCESS_TOKEN_EXPIRE_MINUTES` | `480` | |
| `CORS_ORIGINS` | Vite's dev origins | |

## Notes for future work

- The schema is created with `Base.metadata.create_all`, which adds new tables
  but **not new columns to existing ones**. An existing `taskflow.db` from
  before `users.is_active` was added will fail on startup; re-run
  `python seed.py --reset`. This is the point at which Alembic stops being
  optional — the next schema change that has to preserve real data needs it.
- Tokens are stored in `localStorage`, which is appropriate for an internal tool
  but is not XSS-proof. Move to an httpOnly cookie if this is ever exposed more
  widely.
- KPI aggregation folds tasks in Python rather than in SQL. That is the right
  trade at this team's scale — the per-task event walk needs ordering and
  look-ahead, and it stays readable and directly unit-testable. Revisit if the
  task table reaches the tens of thousands.
