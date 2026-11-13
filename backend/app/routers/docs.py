"""Task documents (versioned Markdown), file attachments, context links and the
docs index.

- A document is Markdown kept on the task: spec, plan, notes, test plan,
  decision record, hand-over. Every save stores a full new version with who,
  when (human or agent) and a note. A save names the version it edited; if
  someone saved since, the server answers 409 and nothing is lost.
- A file is an attachment (screenshot, PDF, log), stored on disk by content
  hash and served back as a download.
- A context link says where to read more: a file in a git repo (a plan in
  `plans/`, a doc, a contract section) or a page on an allowed host, with a
  short summary. Agents read the summary before they open anything.
- GET /library lists every hub document and context link the caller can see, so
  an agent can learn what already exists before it writes something new.
"""

from __future__ import annotations

import difflib
import hashlib
import mimetypes
import re
import unicodedata
from pathlib import Path, PurePosixPath
from urllib.parse import urlparse

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile, status
from fastapi.responses import FileResponse, PlainTextResponse
from sqlalchemy import func, select

from app import lint
from app.config import settings
from app.deps import Auth, AuthCtx, DbSession, require_scope
from app.events import record
from app.models import (
    ContextKind,
    ContextLink,
    EventType,
    Task,
    TaskDoc,
    TaskDocVersion,
    TaskFile,
    utcnow,
)
from app.routers.tasks import _assert_visible, _assert_worker, _can_see, _get_task_or_404, _touch
from app.schemas import (
    ContextCreate,
    ContextOut,
    DocCreate,
    DocMeta,
    DocOut,
    DocSave,
    DocsIndexItem,
    DocVersionMeta,
    FileOut,
)

router = APIRouter(tags=["docs"])

# Attachments the hub accepts, by extension. No SVG or HTML: both can carry
# scripts. Text types are served back as plain text.
ALLOWED_FILES: dict[str, str] = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".pdf": "application/pdf",
    ".txt": "text/plain",
    ".md": "text/markdown",
    ".csv": "text/csv",
    ".json": "application/json",
    ".log": "text/plain",
}
# The first bytes each binary type must start with.
MAGIC: dict[str, tuple[bytes, ...]] = {
    "image/png": (b"\x89PNG\r\n\x1a\n",),
    "image/jpeg": (b"\xff\xd8\xff",),
    "image/gif": (b"GIF87a", b"GIF89a"),
    "image/webp": (b"RIFF",),
    "application/pdf": (b"%PDF-",),
}
INLINE_TYPES = {"image/png", "image/jpeg", "image/gif", "image/webp"}


def _slugify(title: str) -> str:
    text = unicodedata.normalize("NFKD", title).encode("ascii", "ignore").decode().lower()
    slug = re.sub(r"[^a-z0-9]+", "-", text).strip("-")[:60]
    return slug or "doc"


def _assert_can_write_docs(task: Task, auth: Auth) -> None:
    _assert_visible(task, auth.user)
    if auth.user.is_bot:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Bots cannot write documents")
    _assert_worker(task, auth.user)


def _doc_or_404(task: Task, slug: str) -> TaskDoc:
    doc = next((d for d in task.docs if d.slug == slug), None)
    if doc is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"No document '{slug}' on this task")
    return doc


def _version(doc: TaskDoc, n: int | None) -> TaskDocVersion:
    n = n or doc.current_version
    version = next((v for v in doc.versions if v.n == n), None)
    if version is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"No version {n}")
    return version


def doc_meta(doc: TaskDoc) -> DocMeta:
    meta = DocMeta.model_validate(doc)
    if doc.versions:
        last = doc.versions[-1]
        who = last.author.handle or last.author.name
        meta.last_author = f"{who} (agent {last.agent_name})" if last.agent_name else who
        meta.last_actor_kind = last.actor_kind
    return meta


def _doc_out(doc: TaskDoc, version: TaskDocVersion) -> DocOut:
    return DocOut(
        **doc_meta(doc).model_dump(),
        version=version.n,
        body=version.body,
        note=version.note,
        version_author={"id": version.author.id, "name": version.author.name, "handle": version.author.handle},
        version_actor_kind=version.actor_kind,
        version_agent_name=version.agent_name,
        version_created_at=version.created_at,
    )


def _add_version(db, auth: Auth, doc: TaskDoc, *, title: str, body: str, note: str | None) -> TaskDocVersion:
    n = (doc.versions[-1].n if doc.versions else 0) + 1
    version = TaskDocVersion(
        doc_id=doc.id,
        n=n,
        title=title,
        body=body,
        note=note,
        author_id=auth.user.id,
        actor_kind=auth.kind,
        agent_name=auth.agent,
        created_at=utcnow(),
    )
    db.add(version)
    doc.versions.append(version)
    doc.current_version = n
    doc.title = title
    doc.updated_at = version.created_at
    return version


# --- documents --------------------------------------------------------------------


@router.get("/tasks/{task_id}/docs", response_model=list[DocMeta])
def list_docs(task_id: int, auth: AuthCtx, db: DbSession) -> list[DocMeta]:
    task = _get_task_or_404(db, task_id)
    _assert_visible(task, auth.user)
    return [doc_meta(d) for d in task.docs]


@router.post("/tasks/{task_id}/docs", response_model=DocOut, status_code=status.HTTP_201_CREATED)
def create_doc(
    task_id: int,
    payload: DocCreate,
    db: DbSession,
    auth: Auth = Depends(require_scope("docs:write")),
) -> DocOut:
    task = _get_task_or_404(db, task_id)
    _assert_can_write_docs(task, auth)
    slug = payload.slug or _slugify(payload.title)
    if any(d.slug == slug for d in task.docs):
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=f"A document '{slug}' already exists on this task")
    title = lint.clean(payload.title, field="title")
    body = lint.clean(payload.body, field="body") or ""
    now = utcnow()
    doc = TaskDoc(
        task_id=task.id, slug=slug, title=title, kind=payload.kind,
        current_version=1, created_by=auth.user.id, created_at=now, updated_at=now,
    )
    db.add(doc)
    db.flush()
    version = _add_version(db, auth, doc, title=title, body=body, note=lint.clean(payload.note, field="note"))
    _touch(task)
    record(db, auth, task_id=task.id, event_type=EventType.doc_saved,
           data={"slug": slug, "version": version.n, "created": True})
    db.commit()
    return _doc_out(doc, version)


@router.get("/tasks/{task_id}/docs/{slug}", response_model=DocOut)
def read_doc(
    task_id: int,
    slug: str,
    auth: AuthCtx,
    db: DbSession,
    version: int | None = Query(default=None, ge=1),
) -> DocOut:
    task = _get_task_or_404(db, task_id)
    _assert_visible(task, auth.user)
    doc = _doc_or_404(task, slug)
    return _doc_out(doc, _version(doc, version))


@router.get("/tasks/{task_id}/docs/{slug}/raw", response_class=PlainTextResponse)
def read_doc_raw(task_id: int, slug: str, auth: AuthCtx, db: DbSession, version: int | None = None) -> str:
    """The Markdown alone, for agents that want the text without JSON."""
    task = _get_task_or_404(db, task_id)
    _assert_visible(task, auth.user)
    return _version(_doc_or_404(task, slug), version).body


@router.put("/tasks/{task_id}/docs/{slug}", response_model=DocOut)
def save_doc(
    task_id: int,
    slug: str,
    payload: DocSave,
    db: DbSession,
    auth: Auth = Depends(require_scope("docs:write")),
) -> DocOut:
    task = _get_task_or_404(db, task_id)
    _assert_can_write_docs(task, auth)
    doc = _doc_or_404(task, slug)
    if payload.base_version != doc.current_version:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=(
                f"Someone saved version {doc.current_version} after the version {payload.base_version} "
                "you edited. Read it, merge your change, and save again."
            ),
        )
    current = _version(doc, None)
    body = lint.clean(payload.body, field="body") or ""
    title = lint.clean(payload.title, field="title") if payload.title else doc.title
    if body == current.body and title == doc.title and payload.kind in (None, doc.kind):
        return _doc_out(doc, current)  # nothing changed, no new version
    if payload.kind is not None:
        doc.kind = payload.kind
    version = _add_version(db, auth, doc, title=title, body=body, note=lint.clean(payload.note, field="note"))
    _touch(task)
    record(db, auth, task_id=task.id, event_type=EventType.doc_saved,
           data={"slug": slug, "version": version.n, "note": version.note})
    db.commit()
    return _doc_out(doc, version)


@router.get("/tasks/{task_id}/docs/{slug}/history", response_model=list[DocVersionMeta])
def doc_history(task_id: int, slug: str, auth: AuthCtx, db: DbSession) -> list[DocVersionMeta]:
    task = _get_task_or_404(db, task_id)
    _assert_visible(task, auth.user)
    doc = _doc_or_404(task, slug)
    out = []
    for v in reversed(doc.versions):
        meta = DocVersionMeta.model_validate(v)
        meta.size = len(v.body)
        out.append(meta)
    return out


@router.get("/tasks/{task_id}/docs/{slug}/diff", response_class=PlainTextResponse)
def doc_diff(
    task_id: int,
    slug: str,
    auth: AuthCtx,
    db: DbSession,
    from_version: int = Query(alias="from", ge=1),
    to_version: int | None = Query(default=None, alias="to", ge=1),
) -> str:
    """Unified diff between two versions (default: to the current one)."""
    task = _get_task_or_404(db, task_id)
    _assert_visible(task, auth.user)
    doc = _doc_or_404(task, slug)
    a, b = _version(doc, from_version), _version(doc, to_version)
    lines = difflib.unified_diff(
        a.body.splitlines(keepends=True),
        b.body.splitlines(keepends=True),
        fromfile=f"{slug} v{a.n}",
        tofile=f"{slug} v{b.n}",
    )
    return "".join(lines) or "(no changes)\n"


@router.post("/tasks/{task_id}/docs/{slug}/restore/{n}", response_model=DocOut)
def restore_doc(
    task_id: int,
    slug: str,
    n: int,
    db: DbSession,
    auth: Auth = Depends(require_scope("docs:write")),
    base_version: int | None = Query(default=None, ge=1),
) -> DocOut:
    """Save an old version again as the newest. History keeps everything.
    Pass base_version to refuse the restore if someone saved meanwhile."""
    task = _get_task_or_404(db, task_id)
    _assert_can_write_docs(task, auth)
    doc = _doc_or_404(task, slug)
    if base_version is not None and base_version != doc.current_version:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Someone saved version {doc.current_version} after version {base_version}.",
        )
    old = _version(doc, n)
    version = _add_version(db, auth, doc, title=old.title, body=old.body, note=f"Restored version {n}")
    _touch(task)
    record(db, auth, task_id=task.id, event_type=EventType.doc_saved,
           data={"slug": slug, "version": version.n, "restored_from": n})
    db.commit()
    return _doc_out(doc, version)


# --- files ------------------------------------------------------------------------


def _files_root() -> Path:
    root = Path(settings.files_dir)
    root.mkdir(parents=True, exist_ok=True)
    return root


def _blob_path(sha: str) -> Path:
    return _files_root() / sha[:2] / sha


@router.post("/tasks/{task_id}/files", response_model=FileOut, status_code=status.HTTP_201_CREATED)
async def upload_file(
    task_id: int,
    db: DbSession,
    upload: UploadFile = File(...),
    note: str | None = Form(default=None, max_length=300),
    auth: Auth = Depends(require_scope("docs:write")),
) -> TaskFile:
    task = _get_task_or_404(db, task_id)
    _assert_can_write_docs(task, auth)

    name = PurePosixPath((upload.filename or "file").replace("\\", "/")).name[:200] or "file"
    ext = PurePosixPath(name).suffix.lower()
    mime = ALLOWED_FILES.get(ext)
    if mime is None:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"File type not accepted. Allowed: {', '.join(sorted(ALLOWED_FILES))}",
        )
    limit = settings.file_max_mb * 1024 * 1024
    data = await upload.read(limit + 1)
    if len(data) > limit:
        raise HTTPException(status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, detail=f"A file is at most {settings.file_max_mb} MB")
    if not data:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="The file is empty")
    if mime in MAGIC and not data.startswith(MAGIC[mime]):
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=f"The content is not a real {ext} file")
    if mime.startswith("text/") or mime == "application/json":
        try:
            text = data.decode("utf-8")
        except UnicodeDecodeError:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Text files must be UTF-8") from None
        lint.clean(text, field=name)

    used = db.scalar(select(func.coalesce(func.sum(TaskFile.size), 0)).where(TaskFile.removed_at.is_(None))) or 0
    if used + len(data) > settings.files_total_mb * 1024 * 1024:
        raise HTTPException(
            status_code=status.HTTP_507_INSUFFICIENT_STORAGE,
            detail=f"The hub's attachment space ({settings.files_total_mb} MB) is full. Remove old files first.",
        )

    sha = hashlib.sha256(data).hexdigest()
    path = _blob_path(sha)
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".part")
        tmp.write_bytes(data)
        tmp.replace(path)

    row = TaskFile(
        task_id=task.id, name=name, mime=mime, size=len(data), sha256=sha,
        note=lint.clean(note, field="note"), uploaded_by=auth.user.id,
        actor_kind=auth.kind, agent_name=auth.agent, created_at=utcnow(),
    )
    db.add(row)
    db.flush()
    record(db, auth, task_id=task.id, event_type=EventType.file_added,
           data={"file_id": row.id, "name": name, "size": len(data)})
    db.commit()
    db.refresh(row)
    return row


@router.get("/tasks/{task_id}/files/{file_id}")
def download_file(task_id: int, file_id: int, auth: AuthCtx, db: DbSession):
    task = _get_task_or_404(db, task_id)
    _assert_visible(task, auth.user)
    row = db.get(TaskFile, file_id)
    if row is None or row.task_id != task.id or row.removed_at is not None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="File not found")
    path = _blob_path(row.sha256)
    if not path.exists():
        raise HTTPException(status_code=status.HTTP_410_GONE, detail="The file is missing on disk")
    media = "text/plain; charset=utf-8" if row.mime.startswith("text/") or row.mime == "application/json" else row.mime
    disposition = "inline" if row.mime in INLINE_TYPES else "attachment"
    return FileResponse(
        path,
        media_type=media,
        filename=row.name,
        content_disposition_type=disposition,
        headers={"X-Content-Type-Options": "nosniff", "Content-Security-Policy": "sandbox"},
    )


@router.delete("/tasks/{task_id}/files/{file_id}", response_model=FileOut)
def remove_file(
    task_id: int,
    file_id: int,
    db: DbSession,
    auth: Auth = Depends(require_scope("docs:write")),
) -> TaskFile:
    """Hide an attachment. The blob is deleted once no live row uses it."""
    task = _get_task_or_404(db, task_id)
    _assert_visible(task, auth.user)
    row = db.get(TaskFile, file_id)
    if row is None or row.task_id != task.id or row.removed_at is not None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="File not found")
    if not auth.user.is_lead and row.uploaded_by != auth.user.id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Only the uploader or a lead can remove a file")
    row.removed_at = utcnow()
    still_used = db.scalar(
        select(func.count(TaskFile.id)).where(
            TaskFile.sha256 == row.sha256, TaskFile.removed_at.is_(None), TaskFile.id != row.id
        )
    )
    if not still_used:
        _blob_path(row.sha256).unlink(missing_ok=True)
    record(db, auth, task_id=task.id, event_type=EventType.file_removed,
           data={"file_id": row.id, "name": row.name})
    db.commit()
    db.refresh(row)
    return row


# --- context links ----------------------------------------------------------------


def _check_repo_path(path: str) -> str:
    path = path.strip().replace("\\", "/")
    parts = PurePosixPath(path).parts
    if (
        not path
        or path.startswith("/")
        or path.startswith("~")
        or re.match(r"^[A-Za-z]:", path)
        or ".." in parts
    ):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="path: a path inside the repo, like plans/cross-team/2026-11-13/feature.md",
        )
    return path


def _check_url(url: str) -> str:
    parsed = urlparse(url.strip())
    host = (parsed.hostname or "").lower()
    allowed = [h.strip().lower() for h in settings.context_url_hosts.split(",") if h.strip()]
    if parsed.scheme != "https" or not any(host == h or host.endswith("." + h) for h in allowed):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"url: https on an allowed host only ({', '.join(allowed)})",
        )
    return url.strip()


@router.post("/tasks/{task_id}/context", response_model=ContextOut, status_code=status.HTTP_201_CREATED)
def add_context(
    task_id: int,
    payload: ContextCreate,
    db: DbSession,
    auth: Auth = Depends(require_scope("docs:write")),
) -> ContextLink:
    task = _get_task_or_404(db, task_id)
    _assert_can_write_docs(task, auth)
    kind = ContextKind(payload.kind)
    row = ContextLink(
        task_id=task.id,
        kind=kind,
        title=lint.clean(payload.title, field="title"),
        summary=lint.clean(payload.summary, field="summary"),
        added_by=auth.user.id,
        actor_kind=auth.kind,
        agent_name=auth.agent,
        created_at=utcnow(),
    )
    if kind is ContextKind.repo_path:
        if not payload.repo or not payload.path:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="A repo_path link needs repo and path")
        row.repo = payload.repo
        row.path = lint.clean(_check_repo_path(payload.path), field="path")
        row.ref = payload.ref
        row.commit = payload.commit
    else:
        if not payload.url:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="A url link needs url")
        row.url = lint.clean(_check_url(payload.url), field="url")
    db.add(row)
    db.flush()
    record(db, auth, task_id=task.id, event_type=EventType.context_added,
           data={"context_id": row.id, "kind": kind.value, "repo": row.repo, "path": row.path, "url": row.url})
    db.commit()
    db.refresh(row)
    return row


@router.delete("/tasks/{task_id}/context/{context_id}", response_model=ContextOut)
def remove_context(
    task_id: int,
    context_id: int,
    db: DbSession,
    auth: Auth = Depends(require_scope("docs:write")),
) -> ContextLink:
    task = _get_task_or_404(db, task_id)
    _assert_can_write_docs(task, auth)
    row = db.get(ContextLink, context_id)
    if row is None or row.task_id != task.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Context link not found")
    out = ContextOut.model_validate(row)
    record(db, auth, task_id=task.id, event_type=EventType.context_removed,
           data={"context_id": row.id, "title": row.title})
    db.delete(row)
    db.commit()
    return out


# --- docs index -------------------------------------------------------------------


@router.get("/library", response_model=list[DocsIndexItem])
def docs_index(
    auth: AuthCtx,
    db: DbSession,
    q: str | None = Query(default=None, max_length=100),
    repo: str | None = None,
    kind: str | None = Query(default=None, pattern=r"^(hub_doc|repo_path|url)$"),
    limit: int = Query(default=200, ge=1, le=1000),
) -> list[DocsIndexItem]:
    """Everything written down that you can see: hub documents and the repo
    files and pages tasks link to. Repo files linked from several tasks show
    once, with the newest link."""
    needle = (q or "").strip().lower()
    items: list[DocsIndexItem] = []

    if kind in (None, "hub_doc") and repo is None:
        for doc in db.scalars(select(TaskDoc).order_by(TaskDoc.updated_at.desc())):
            if not _can_see(doc.task, auth.user):
                continue
            text = f"{doc.title} {doc.slug} {doc.task.title}".lower()
            if needle and needle not in text:
                continue
            items.append(DocsIndexItem(
                kind="hub_doc", title=doc.title, summary=doc.kind.value, task_id=doc.task_id,
                task_title=doc.task.title, slug=doc.slug, version=doc.current_version,
                updated_at=doc.updated_at,
            ))

    seen: set[tuple] = set()
    if kind in (None, "repo_path", "url"):
        for link in db.scalars(select(ContextLink).order_by(ContextLink.created_at.desc())):
            if kind and link.kind.value != kind:
                continue
            if repo and link.repo != repo:
                continue
            if not _can_see(link.task, auth.user):
                continue
            key = (link.kind.value, link.repo, link.path, link.url)
            if key in seen:
                continue
            text = f"{link.title} {link.summary or ''} {link.path or ''} {link.url or ''}".lower()
            if needle and needle not in text:
                continue
            seen.add(key)
            items.append(DocsIndexItem(
                kind=link.kind.value, title=link.title, summary=link.summary, task_id=link.task_id,
                task_title=link.task.title, repo=link.repo, path=link.path, ref=link.ref,
                url=link.url, updated_at=link.created_at,
            ))

    items.sort(key=lambda i: i.updated_at, reverse=True)
    return items[:limit]
