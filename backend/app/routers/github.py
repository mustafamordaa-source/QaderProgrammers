"""GitHub webhook: PRs, pushes and deploy runs move hub tasks along.

GitHub calls `POST /github/webhook` (behind nginx: /api/github/webhook) for
the repos it is set up on. Nothing here costs GitHub Actions minutes.

Rules:

- The request must carry a valid `X-Hub-Signature-256` for
  `GITHUB_WEBHOOK_SECRET`, and come from a repo in `GITHUB_REPOS`.
- A task is matched by its hub ID (`HUB-12`) in the branch name or the PR
  title. The PR body does not count: anyone who can open a PR could write
  any ID there. PRs from people outside the repo (author_association not
  OWNER, MEMBER or COLLABORATOR) are ignored.
- push: links the branch and up to 20 commits to each matched task.
- pull_request: links the PR (state, base branch, merge time). When it
  merges and the task is in progress with no open criteria, the task moves
  to in_review and the leads hear about it. The hub never moves a task to
  done; a lead does.
- workflow_run (completed, success): `GITHUB_DEPLOY_RULES` maps a branch to a
  deploy state, for example `develop=staging,main=production`. Every task
  with a PR merged into that branch (for production: into any branch in the
  rules) before the run started moves its deploy state forward. It never
  moves back.

Changes are recorded as the `github` bot account with actor kind "system".
"""

from __future__ import annotations

import hashlib
import hmac
import json
import re
import secrets
from datetime import datetime, timezone

from fastapi import APIRouter, Header, HTTPException, Request, status
from sqlalchemy import select

from app.config import settings
from app.deps import Auth, DbSession
from app.events import record
from app.models import (
    CLOSED_STATUSES,
    AccessRole,
    AccountType,
    ActorKind,
    CriterionState,
    DeployState,
    EventType,
    GitLink,
    GitLinkKind,
    NotifyKind,
    Role,
    Task,
    TaskStatus,
    User,
    utcnow,
)
from app.notify import leads, notify
from app.security import hash_password

router = APIRouter(prefix="/github", tags=["github"])

TRUSTED_AUTHORS = {"OWNER", "MEMBER", "COLLABORATOR"}
DEPLOY_ORDER = {DeployState.none: 0, DeployState.staging: 1, DeployState.production: 2}
MAX_COMMITS = 20


def _hub_ids(*texts: str | None) -> list[int]:
    pattern = re.compile(rf"\b{re.escape(settings.hub_id_prefix)}-(\d+)\b", re.IGNORECASE)
    ids: list[int] = []
    for text in texts:
        for m in pattern.findall(text or ""):
            if int(m) not in ids:
                ids.append(int(m))
    return ids


def _naive(ts: str | None) -> datetime | None:
    if not ts:
        return None
    return datetime.fromisoformat(ts.replace("Z", "+00:00")).astimezone(timezone.utc).replace(tzinfo=None)


def _system_user(db) -> User:
    user = db.scalar(select(User).where(User.handle == "github"))
    if user is None:
        user = User(
            name="GitHub",
            email="github-bot@users.noreply.github.com",
            password_hash=hash_password(secrets.token_urlsafe(32)),
            role=Role.programmer,
            is_active=True,
            handle="github",
            account_type=AccountType.bot,
        )
        user.set_roles([AccessRole.member.value])
        db.add(user)
        db.flush()
    return user


def _deploy_rules() -> dict[str, DeployState]:
    rules: dict[str, DeployState] = {}
    for part in settings.github_deploy_rules.split(","):
        branch, _, state = part.strip().partition("=")
        if branch and state in ("staging", "production"):
            rules[branch.strip()] = DeployState(state)
    return rules


def _verify(body: bytes, signature: str | None) -> None:
    if not settings.github_webhook_secret:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")
    expected = "sha256=" + hmac.new(settings.github_webhook_secret.encode(), body, hashlib.sha256).hexdigest()
    if not signature or not hmac.compare_digest(expected, signature):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Bad signature")


def _upsert_link(db, task: Task, *, repo: str, kind: GitLinkKind, ref: str, **fields) -> tuple[GitLink, bool]:
    link = db.scalar(select(GitLink).where(
        GitLink.task_id == task.id, GitLink.repo == repo, GitLink.kind == kind, GitLink.ref == ref))
    now = utcnow()
    created = link is None
    if created:
        link = GitLink(task_id=task.id, repo=repo, kind=kind, ref=ref, actor_kind=ActorKind.system,
                       created_at=now, updated_at=now)
        db.add(link)
    for key, value in fields.items():
        if value is not None:
            setattr(link, key, value)
    link.updated_at = now
    return link, created


def _tasks(db, ids: list[int]) -> list[Task]:
    return [t for t in (db.get(Task, i) for i in ids) if t is not None]


@router.post("/webhook")
async def webhook(
    request: Request,
    db: DbSession,
    x_github_event: str = Header(default=""),
    x_hub_signature_256: str | None = Header(default=None),
) -> dict:
    body = await request.body()
    _verify(body, x_hub_signature_256)
    payload = json.loads(body or b"{}")
    if x_github_event == "ping":
        return {"ok": True, "event": "ping"}

    repo = (payload.get("repository") or {}).get("full_name", "")
    allowed = {r.strip().lower() for r in settings.github_repos.split(",") if r.strip()}
    if repo.lower() not in allowed:
        return {"ok": True, "ignored": f"repo {repo or '?'} is not in GITHUB_REPOS"}

    bot = _system_user(db)
    auth = Auth(user=bot, kind=ActorKind.system, agent="github", scopes=set())
    handler = {"push": _push, "pull_request": _pull_request, "workflow_run": _workflow_run}.get(x_github_event)
    if handler is None:
        return {"ok": True, "ignored": f"event {x_github_event}"}
    result = handler(db, auth, repo, payload)
    db.commit()
    return {"ok": True, "event": x_github_event, **result}


def _push(db, auth: Auth, repo: str, payload: dict) -> dict:
    ref = payload.get("ref", "")
    if not ref.startswith("refs/heads/") or payload.get("deleted"):
        return {"tasks": []}
    branch = ref[len("refs/heads/"):]
    commits = (payload.get("commits") or [])[:MAX_COMMITS]
    ids = _hub_ids(branch)
    touched = []
    for task in _tasks(db, ids):
        _, created = _upsert_link(db, task, repo=repo, kind=GitLinkKind.branch, ref=branch,
                                  url=f"https://github.com/{repo}/tree/{branch}", state="open")
        added = 0
        for c in commits:
            sha = c.get("id", "")
            if not re.fullmatch(r"[0-9a-f]{40}", sha):
                continue
            _, new = _upsert_link(db, task, repo=repo, kind=GitLinkKind.commit, ref=sha,
                                  url=c.get("url"), title=(c.get("message") or "").splitlines()[0][:300] or None)
            added += int(new)
        if created or added:
            record(db, auth, task_id=task.id, event_type=EventType.git_linked,
                   data={"repo": repo, "branch": branch, "commits": added})
        touched.append(task.id)
    return {"tasks": touched}


def _pull_request(db, auth: Auth, repo: str, payload: dict) -> dict:
    pr = payload.get("pull_request") or {}
    if pr.get("author_association") not in TRUSTED_AUTHORS:
        return {"ignored": "PR author is not a repo member", "tasks": []}
    head = (pr.get("head") or {}).get("ref", "")
    base = (pr.get("base") or {}).get("ref", "")
    ids = _hub_ids(head, pr.get("title"))
    merged = bool(pr.get("merged"))
    state = "merged" if merged else ("closed" if pr.get("state") == "closed" else "open")
    touched = []
    for task in _tasks(db, ids):
        _, created = _upsert_link(
            db, task, repo=repo, kind=GitLinkKind.pr, ref=str(pr.get("number")),
            url=pr.get("html_url"), title=(pr.get("title") or "")[:300], state=state,
            base_ref=base, merged_at=_naive(pr.get("merged_at")) if merged else None,
        )
        if head:
            _upsert_link(db, task, repo=repo, kind=GitLinkKind.branch, ref=head,
                         url=f"https://github.com/{repo}/tree/{head}", state="merged" if merged else None)
        record(db, auth, task_id=task.id, event_type=EventType.git_linked,
               data={"repo": repo, "pr": pr.get("number"), "state": state, "base": base})
        moved = False
        if merged and task.status is TaskStatus.in_progress and not any(
            c.state is CriterionState.open for c in task.criteria
        ) and not task.open_blockers():
            record(db, auth, task_id=task.id, event_type=EventType.status_changed,
                   from_status=task.status, to_status=TaskStatus.in_review,
                   comment=f"PR #{pr.get('number')} merged into {base}")
            task.status = TaskStatus.in_review
            task.claimed_by = task.claim_agent = task.claim_expires_at = None
            task.version += 1
            task.updated_at = utcnow()
            notify(db, auth, users=leads(db), task=task, kind=NotifyKind.review,
                   text=f"PR #{pr.get('number')} merged into {base}")
            moved = True
        touched.append({"task": task.id, "moved_to_review": moved})
    return {"tasks": touched}


def _workflow_run(db, auth: Auth, repo: str, payload: dict) -> dict:
    run = payload.get("workflow_run") or {}
    if payload.get("action") != "completed" or run.get("conclusion") != "success":
        return {"tasks": []}
    rules = _deploy_rules()
    branch = run.get("head_branch", "")
    target = rules.get(branch)
    if target is None:
        return {"ignored": f"no deploy rule for branch {branch}", "tasks": []}
    started = _naive(run.get("run_started_at") or run.get("created_at")) or utcnow()
    bases = set(rules) if target is DeployState.production else {branch}
    links = db.scalars(select(GitLink).where(
        GitLink.repo == repo, GitLink.kind == GitLinkKind.pr, GitLink.state == "merged",
        GitLink.base_ref.in_(sorted(bases)), GitLink.merged_at <= started,
    ))
    touched = []
    for link in links:
        task = link.task
        if task.id in touched or DEPLOY_ORDER[task.deploy_state] >= DEPLOY_ORDER[target]:
            continue
        old = task.deploy_state
        task.deploy_state = target
        task.deployed_at = utcnow()
        task.deploy_note = f"{run.get('name') or 'deploy'} run {run.get('id')} on {branch}"
        task.version += 1
        record(db, auth, task_id=task.id, event_type=EventType.deployed,
               data={"from": old.value, "to": target.value, "run": run.get("id"), "branch": branch})
        touched.append(task.id)
    return {"tasks": touched, "deploy_state": target.value}
