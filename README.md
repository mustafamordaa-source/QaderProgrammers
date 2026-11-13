# TaskFlow

Task tracking and delivery metrics for a small software team and its AI
agents. People work in the browser; agents work through personal API tokens
and a small CLI. Every change is written to an append-only event log, marked
human, agent or system, and the KPI dashboard is computed from that log.

What agents get on top of a plain board: claims with leases (two agents never
take the same task), acceptance criteria that need evidence before review,
questions that park a task until answered, a fixed hand-back format, git
links and deploy state on each task, a 2 KB "brief" read, and a text check
that refuses secrets and server details.

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

python seed.py --email you@example.com --name "Your Name"   # migrates, creates the leader
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

### First sign-in

`seed.py` runs the migrations and creates one account, the leader. There is no
default password: pass `--password`, or the script generates a random one and
prints it once. Add the rest of the team from the **People** screen.

`python migrate.py` brings the schema up to date on its own; the server
container runs it on every start.

### Tests

```bash
cd backend
.venv/bin/python -m pytest         # 228 tests
```

They cover the transition matrix, the role guards, task visibility, user
management, the difficulty scale, the KPI arithmetic, API tokens and scopes,
claims, comments and questions, acceptance criteria, git links, the text
check, rate limits, and migrating an old database file in place.

```bash
cd frontend
npm run check:routes               # client routes vs API paths (also runs on build)
```

---

## Roles

**Leader** creates and assigns tasks, triages proposals and the backlog, and
is the only role that can move a task to Done or drop it. Sees every task,
including restricted ones, and every member's metrics. Manages accounts.

**Member** (stored as `programmer`) reads every task except restricted ones
and other people's proposals, so frontend and backend can follow each other's
work. Works on tasks assigned to them, or pool tasks they claimed: moves them,
edits summary, tags, areas and side, manages criteria, links commits and PRs,
sets deploy state. Creates tasks; they land in the backlog for the leader.

**Viewer** reads, nothing else. Meant for a manager who follows the board.

Roles are enforced by FastAPI dependencies (`app/deps.py`) and the checks in
`app/routers/tasks.py`. A personal API token acts for its owner with the same
rights, narrowed by the token's scopes.

## Workflow

```
proposed ──▶ backlog ──▶ to_do ──▶ in_progress ──▶ in_review ──▶ done
                                       ▲               │
                                       └───────────────┘  leader: reject (comment required)

any open working status ──▶ blocked / needs_confirm ──▶ back to where it was
leader only: proposed/backlog triage, done, dropped (reason required)
```

- `side` (fe, be, mobile, content, infra, qa, other) says what kind of work a
  task is. It replaced the old `in_progress_front` / `in_progress_back`
  statuses; old event rows keep those values and the KPIs read them as
  `in_progress`.
- Moving to `in_review` or `done` is refused while any acceptance criterion
  is open. An agent must post a hand-back comment before moving to review.
- A question with `wait` parks the task in `needs_confirm`; the answer to the
  last open question returns it to where it was.
- Every write may send `expected_version`; a stale version gets `409`.

The whole matrix lives in `backend/app/transitions.py`. The frontend mirrors
it in `frontend/src/lib/constants.js` only so the UI offers valid moves; the
server re-validates every request.

## Roles in more detail

A person holds one or more **access roles**; their rights add up.

| Role | Can |
|---|---|
| Admin | Everything a lead can, plus people, bot accounts, everyone's tokens |
| Lead | Triage proposals and the backlog (one by one or in bulk), assign, approve, reject, drop, see restricted work |
| Member | Be assigned, claim, move and document their own tasks, create tasks into the backlog |
| Viewer | Read; ignored when combined with another role |

**Works on** (fe, be, mobile, content, infra, qa, design) is separate: it says
which kinds of work a person picks up, and it can hold several. A full-stack
admin is `roles: [admin, lead, member]`, `sides: [fe, be, infra]`.

A **bot** account (`account_type: bot`) is for an automated agent, such as a
server-side scanner. It cannot log in with a password; an admin issues its
tokens from `POST /users/{id}/tokens`, limited to `tasks:read`,
`tasks:propose` and `comments:write`. Everything it files lands in
`proposed`, and it can comment only on its own proposals.

## Documents, files and context

- **Documents**: Markdown on a task (spec, plan, notes, test plan, decision,
  hand-over). Each save is a full new version with author, human or agent,
  and a note. A save names the version it edited; a newer save in between
  gets `409`. History, diffs between any two versions and restore are built
  in. Version rows cannot be edited in the database.
- **Files**: PNG, JPEG, GIF, WebP, PDF, TXT, MD, CSV, JSON, LOG; 10 MB each,
  200 MB in total. No SVG or HTML. Images are checked by their first bytes,
  text files pass the text check, and downloads are served with `nosniff`
  and a sandbox CSP.
- **Context links**: where to read more, either a file in a git repo (repo,
  path, branch, commit) or an https page on an allowed host, each with a
  summary. Use them for plans in a repo's `plans/` folder, API contract
  sections and docs, so the repo stays the source of truth and the task says
  where to look.
- **Library** (`GET /library`): every hub document and linked repo file or
  page you can see, searchable, with shared repo files listed once. Agents
  read it before writing a new plan.

## Task kinds, links and subtasks

- **Kinds**: task, bug, feature, chore, content, docs, research. Each kind has
  a template (`GET /tasks/templates`): a description skeleton, headings that
  must have text (a bug needs `Steps:`, `Expected:`, `Actual:`; a feature
  needs `Goal:` and `Scope:`) and starter acceptance criteria, used when the
  task brings none.
- **Links**: `blocks`, `relates`, `duplicates`. An open blocker keeps a task
  out of `?ready=true`, refuses its claim and its move to in_progress. Loops
  are refused.
- **Subtasks**: `parent_id`, two levels only. A parent cannot reach done while
  a subtask is open.
- **Split by side**: `POST /tasks/{id}/split` with `parts` (one per side:
  fe, be, content...) turns a task that needs several roles into one subtask
  per side, copying priority, tags, areas and due date. A part with
  `assignee_id` goes to that person; one without goes to the pool for its
  side, and only people whose "Works on" includes that side (or a lead) can
  claim it. `order` (`[{"before": "be", "after": "fe"}]`) makes one part
  block another. The parent lists every part with its side, people, claim
  and status; it starts when the first part starts, and leads hear when
  every part is closed. A member may split a task they work on into pool
  parts; only a lead assigns parts.
- **Fingerprints**: a creator (usually a scanner) may send a `fingerprint`
  such as `rule:path:symbol`. While a task with that fingerprint is open, a
  new one is not created: the open task gets a `seen_again` event and comes
  back with `duplicate_of_existing: true`. A task dropped with that
  fingerprint in the last 90 days refuses it.

## GitHub webhook

Set `GITHUB_WEBHOOK_SECRET` and `GITHUB_REPOS` on the server, then a repo
admin adds a webhook pointing at `https://tasks.qader.vip/api/github/webhook`
with the same secret (`.env.example` has the steps). It costs no Actions
minutes: GitHub calls the hub.

- Put the hub ID in the branch name: `feat/HUB-12-ready-accounts`. The PR
  title also counts; the PR body does not, and PRs from people outside the
  repo are ignored.
- **push**: links the branch and its commits (up to 20 per push) to the task.
- **pull_request**: links the PR with its state, base branch and merge time.
  When it merges and the task is in progress with every criterion closed,
  the task moves to in_review and leads are notified. Only a lead moves a
  task to done.
- **workflow_run**: a successful run on a branch in `GITHUB_DEPLOY_RULES`
  (`develop=staging,main=production`) moves the deploy state forward on
  every task whose PR merged into that branch before the run started; for
  production, into any branch in the rules. It never moves back.

Changes made this way show as the `github` account with actor kind
`system`.

## Notifications and email

The hub tells a person when they are assigned, asked a question, answered,
`@mentioned` (by handle, in a comment or a task description), when their
work is approved or sent back, and, for leads, when work waits for review or
a new task is proposed. Nobody is told about their own action; bots,
deactivated people and people who cannot see the task are never told. For a
restricted task the notification carries no text.

Every notification shows in the app (bell and `GET /notifications`). Email
is a channel on top:

- Turn it on by setting `SMTP_HOST`, `SMTP_FROM` and, for Gmail,
  `SMTP_USER` plus an **app password** in `SMTP_PASSWORD` on the server
  (`.env.example` lists them). The password never goes in the repo.
- A sender thread in the API batches: once a person's oldest unsent
  notification is `EMAIL_BATCH_SECONDS` old, they get one email listing
  everything pending. Failed sends retry up to 5 times. Caps per person per
  hour and per day keep the hub inside Gmail's limits.
- Each person picks which kinds they get by email, or turns email off, on
  **Settings**, and may send it to an address other than their login email.
  `POST /notifications/test` sends them a test email.
- Admins see the sender's state at `GET /notifications/status` (never the
  password).

## Agents

1. A person creates a token on **Settings** (browser login only, so a leaked
   token cannot mint more). Scopes: `tasks:read`, `tasks:write`,
   `tasks:create`, `comments:write`, `claims`, `git:write`. Expiry is
   required, 90 days at most. Only a SHA-256 of the secret is stored.
2. The agent sends `Authorization: Bearer qhub_...` and, on every write,
   `X-Agent: <agent name>`. Everything it writes is marked `actor_kind=agent`
   with that name; nobody can set that flag by hand.
3. `POST /tasks/{id}/claim` takes a lease (2 hours by default, 8 at most,
   renewed by claiming again). One SQL statement decides the race, so a
   second agent gets `409`. Claims warn when a person goes over their WIP
   limit or another claimed task shares a file area.
4. `GET /tasks/{id}/brief` returns what an agent needs in about 2 KB.
   `GET /tasks/{id}/events?since=ID` returns only what changed.
5. Hand-back comments need `Summary:`, `Checks run:` and `Left:` lines; the
   summary becomes the task's rolling summary.
6. Text checks (`app/lint.py`) refuse private keys, tokens, `KEY=value`
   secrets, IP addresses and private paths, and strip invisible characters
   that can hide instructions. Arabic text and its direction marks pass.
7. Rate limits: login 5 per minute per address, token reads 300 and writes
   60 per minute.

The CLI and the agent skill that drive this API live in the Qader monorepo.

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

## Difficulty points

Every task carries a difficulty, set by the leader when it is created and
editable afterwards from the task detail view. The scale is Fibonacci —
**1, 2, 3, 5, 8, 13** — labelled Trivial through Huge. Off-scale values are
rejected by the API and by a `CHECK` constraint on the table; the allowed set
lives in one place, `POINT_VALUES` in `backend/app/models.py`.

The widening gaps are the reason for a Fibonacci scale rather than 1–5: they
remove the argument over whether something is a 6 or a 7, and they give a
genuinely large task a bucket of its own instead of squashing it into the top
of a linear range alongside work half its size.

**Difficulty is not priority.** Priority is urgency — when this needs to be
done. Points are effort — how much work it is. A one-line config fix can be
urgent and trivial at the same time, so the two are separate fields and the
picker says so.

## Data model

**users**: id, name, email, password_hash, role, is_active, created_at,
handle, github_login, sides, wip_limit

**tasks**: id, title, description, priority, points, status, due_date,
created_by, assignee_1_id, assignee_2_id, created_at, updated_at, side, tags,
areas, summary, version, restricted, pool, resume_status, created_kind,
created_agent, claimed_by, claim_agent, claim_branch, claim_expires_at,
deploy_state, deploy_note, deployed_at, drop_reason

**task_events**: id, task_id, actor_id, event_type, from_status, to_status,
comment, timestamp, actor_kind, agent_name, token_id, data

**comments**, **task_criteria**, **git_links**, **api_tokens**: see
`backend/app/models.py`.

`task_events` is append-only: SQLite triggers refuse UPDATE and DELETE. It is
the sole input to every KPI. The KPI layer reads five event types:

| Event | When |
|---|---|
| `created` | A task is created |
| `status_changed` | Any ordinary move between stages |
| `rejected` | A leader sends work back out of review (comment required) |
| `approved` | A leader accepts work out of review |
| `closed` | The task's life cycle ends |

The other event types (claimed, released, assigned, field_changed, commented,
question_asked, question_answered, criterion_added, criterion_changed,
git_linked, deployed, dropped) feed the history view.

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
a per-week cycle-time series for the trend chart, and **hours per point**.

**Quality** — rejection rate (`rejected` events ÷ review submissions) and
first-pass rate (tasks approved on a single submission ÷ tasks completed).

**Volume** — completions per week and per month and open work by status, each
reported twice: as a task count and as a points total, plus average points per
completed task.

**On-time** — share of completed tasks closed on or before their due date.
Tasks without a due date are excluded from the denominator rather than counted
as successes.

### Three decisions worth knowing about

**Volume is reported in points and in tasks, with points leading.** Counting
tasks alone rates a 13-point rewrite the same as a 1-point copy change, which
is what difficulty points exist to fix. But counting only points would hide
that someone shipped twelve things. Both figures are computed everywhere, the
dashboard leads with points, and the chart table views show both columns.

**Hours per point is total hours over total points**, not the average of each
task's own ratio. It is a rate, and the honest way to aggregate a rate is total
over total. Averaging per-task ratios lets a handful of 1-pointers — where a
few hours of ordinary latency dominates the number — swamp the figure: two
tasks at 100h/1pt and 20h/13pt average to 51 hours per point that way, against
a true 120/14 ≈ 8.6. Raw cycle time is kept alongside it, because that is what
a deadline is promised against.

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

Full, interactive reference: `/api/docs` on the server, `/docs` locally.

```
POST   /auth/login                  email + password -> JWT (rate limited)
GET    /auth/me                     current user
GET    /auth/users?role=            active-user directory
GET    /auth/scopes                 token scopes
GET    /auth/tokens                 your API tokens (browser login only)
POST   /auth/tokens                 create one; the secret is shown once
DELETE /auth/tokens/{id}            revoke (yours; a leader: anyone's)

GET    /users                       leader: everyone, with open-task counts
POST   /users                       leader: create an account
PATCH  /users/{id}                  leader: name, email, role, profile, is_active
POST   /users/{id}/password         leader: reset a password

POST   /tasks                       create (members: into backlog)
GET    /tasks                       ?mine ?ready ?side ?tag ?q ?status_filter ?include_closed
GET    /tasks/inbox                 questions to you, your parked tasks, leader queues
GET    /tasks/{id}                  full detail: events, comments, criteria, links
GET    /tasks/{id}/brief            what an agent needs, about 2 KB
GET    /tasks/{id}/events?since=    events after an id
PATCH  /tasks/{id}                  edit fields (expected_version optional)
PATCH  /tasks/{id}/status           move a task; validated server-side
PATCH  /tasks/{id}/assign           leader: reassign
POST   /tasks/{id}/reject           leader: back to in_progress, comment required
POST   /tasks/{id}/claim            take or renew a lease; 409 if someone holds it
POST   /tasks/{id}/release          drop your claim
GET    /tasks/{id}/comments
POST   /tasks/{id}/comments         note, question, answer, decision, review, handback
POST   /tasks/{id}/comments/{cid}/resolve
POST   /tasks/{id}/criteria         add an acceptance criterion
PATCH  /tasks/{id}/criteria/{n}     met (evidence required), dropped, open
POST   /tasks/{id}/git              link a branch, PR or commit (upserts)
PATCH  /tasks/{id}/deploy           none, staging, production + note
POST   /tasks/triage                lead: move many proposals at once
GET    /tasks/{id}/docs             documents on a task
POST   /tasks/{id}/docs             new document (Markdown)
GET    /tasks/{id}/docs/{slug}      read (?version=n); /raw for the text alone
PUT    /tasks/{id}/docs/{slug}      save a new version (base_version required)
GET    /tasks/{id}/docs/{slug}/history | /diff?from=&to= | POST /restore/{n}
POST   /tasks/{id}/files            upload (multipart field "upload")
GET    /tasks/{id}/files/{fid}      download; DELETE to remove
POST   /tasks/{id}/context          link a repo file or page; DELETE to remove
GET    /library                     documents and linked files, ?q ?repo ?kind
POST   /users/{id}/tokens           admin: issue a bot token
GET    /notifications               yours (?unread); /count; POST /read {ids | all}
GET    /notifications/preferences   your email settings; PATCH to change (browser only)
POST   /notifications/test          send yourself a test email
GET    /notifications/status        admin: is email on, pending, failed, last error
GET    /tasks/templates             skeleton, required headings, criteria per kind
POST   /tasks/{id}/links            {kind: blocks|relates|duplicates, to_task_id}; DELETE /links/{lid}
POST   /tasks/{id}/split            one subtask per side: {parts: [{side, assignee_id?}], order?}
POST   /github/webhook              GitHub only (signed)

GET    /kpi/team   /kpi/me   /kpi/programmer/{id}
GET    /health
```

Error conventions: `401` unauthenticated, `403` wrong role or missing scope,
`404` missing *or not visible to you*, `409` an illegal transition, a claim
held by someone else, open criteria or a stale version, `422` invalid input or
text the hub refuses, `429` rate limited.

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

The client routes are `/login`, `/board`, `/inbox`, `/documents`, `/metrics`, `/people` and `/settings`. None of them
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
| `APP_ENV` | `development` | `production` refuses a known or short `SECRET_KEY`; docker-compose sets it |
| `SECRET_KEY` | `dev-secret-change-me` | **Change this outside local development** |
| `DATABASE_URL` | `sqlite:///./taskflow.db` | |
| `ACCESS_TOKEN_EXPIRE_MINUTES` | `480` | |
| `CORS_ORIGINS` | Vite's dev origins | |
| `API_TOKEN_MAX_DAYS` | `90` | Longest API token lifetime |
| `RATE_LOGIN_PER_MINUTE` | `5` | Per address and email |
| `RATE_TOKEN_READS_PER_MINUTE` / `RATE_TOKEN_WRITES_PER_MINUTE` | `300` / `60` | Per token |
| `LINT_BLOCKED_ID_PREFIXES` | empty | Task ID prefixes the text check refuses |

## Deployment

A push to `main` deploys to `https://tasks.qader.vip`. GitHub Actions
(`.github/workflows/deploy.yml`) runs one job on a self-hosted runner on the
Qader staging server (label `taskflow`), so it uses no GitHub-hosted minutes.
`scripts/deploy.sh` then:

1. takes the shared deploy lock (`/tmp/qader-deploy.lock`), so it never
   builds while the Qader staging deploy builds;
2. waits for the lock and then for 2 GB of free memory (30 minutes at most each);
3. runs the test suite in a Docker build stage; a failure stops here;
4. backs up the database from the running container to `/data/backups`
   (newest 14 kept);
5. rebuilds and restarts; the API container runs `python migrate.py` first;
6. waits for `/api/health`, or prints the logs and the restore steps.

Never add a `pull_request` trigger to the workflow: the runner sits on the
staging server.

### How the pieces connect

- `docker-compose.yml` runs two containers under the project name `taskflow`:
  `taskflow_api` (uvicorn, one worker) and `taskflow_web` (nginx serving the
  Vite build).
- Both join the external Docker network `qader_qader_network`. The Qader nginx
  container owns ports 80 and 443, terminates TLS, and forwards every request
  for `tasks.qader.vip` to `taskflow_web:80`. Neither TaskFlow container
  publishes a host port.
- The frontend is built with `VITE_API_URL=/api`. `taskflow_web` strips `/api`
  and forwards the rest to FastAPI, so the backend routes keep their plain
  paths. The API docs live at `/api/docs`.
- Keep uvicorn at one worker. Several workers writing to one SQLite file cause
  `database is locked` errors.
- Keep the project name, both container names and the network name as they
  are. The Qader nginx config addresses `taskflow_web` by name.

### Server state

- Secrets live in `/opt/docker/taskflow/.env` on the server, never in the repo.
  Copy `.env.example` there, set a real `SECRET_KEY`, and `chmod 600` it.
- The database lives in the Docker volume `taskflow_taskflow_data`, at
  `/data/taskflow.db` inside `taskflow_api`. Deploys keep it.
- Seed the first leader account once, after the first deploy:
  ```sh
  docker exec -it taskflow_api python seed.py --email <you> --name "<name>"
  ```
  It prints a random password once. `seed.py --reset` is refused when
  `APP_ENV=production`.
- Back up by hand: `docker exec taskflow_api python backup.py /data/backups --label manual`.

### Schema changes

Alembic manages the schema (`backend/migrations/`). Add a revision under
`migrations/versions/` for every model change; the API container applies it
on start, after `deploy.sh` has taken a backup. `migrate.py` stamps a
database made by the old `create_all` start-up at the baseline before
upgrading it, so the staging database moves over without manual SQL.

### Running the containers locally

The compose file reads its env file from `TASKFLOW_ENV_FILE`, falling back to
the server path. To try the production build on your machine:

```sh
docker network create qader_qader_network
printf 'SECRET_KEY=%s\nDATABASE_URL=sqlite:////data/taskflow.db\n' "$(python3 -c 'import secrets;print(secrets.token_urlsafe(48))')" > /tmp/taskflow.env
TASKFLOW_ENV_FILE=/tmp/taskflow.env docker compose up -d --build
docker exec taskflow_web wget -qO- http://127.0.0.1/api/health   # {"status":"ok"}
docker exec taskflow_api python seed.py --email lead@example.com --password test-password-1234
```

To click through the UI, add `ports: ["8080:80"]` to `web` for the test only
and open `http://localhost:8080`. Remove the port before you commit. Clean up
with `docker compose down -v && docker network rm qader_qader_network`.

## Notes for future work

- Browser logins keep their token in `localStorage`, which is fine for an
  internal tool but is not XSS-proof. Move to an httpOnly cookie if this is
  ever exposed more widely.
- KPI aggregation folds tasks in Python rather than in SQL. That is the right
  trade at this team's scale. Revisit if the task table reaches the tens of
  thousands.
- Next steps: GitHub webhook for PR and deploy state, task documents with
  version history, task links and subtasks, templates per task kind, a triage
  queue for machine-filed proposals.
