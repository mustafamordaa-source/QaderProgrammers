"""Product areas and similar-task search.

Areas are an open list: anyone who can file work may add one, but the hub
first looks for an existing area with a similar name or alias and refuses the
new one (409, with suggestions) unless the caller confirms it differs. Leads
rename and merge; a merge moves every task and keeps the old name as an alias.
"""

from __future__ import annotations

import re

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session, selectinload

from app import lint
from app.deps import Auth, AuthCtx, DbSession, require_leader, require_scope
from app.models import Area, Task, User, utcnow
from app.paging import Page
from app.schemas import (
    AREA_SLUG_RE,
    AreaBrief,
    AreaCreate,
    AreaMerge,
    AreaOut,
    AreaSuggestion,
    AreaUpdate,
    SimilarMatch,
    SimilarOut,
    SimilarRequest,
)
from app.similarity import DUPLICATE, RELATED, Doc, name_score, normalize, rank, tokens

router = APIRouter(prefix="/areas", tags=["areas"])

SIMILAR_FLOOR = 50   # below this a match is not worth showing
SAME_AREA_BOOST = 5  # ranking only; the shown score stays the raw one
AUTO_AREA_MIN = 60   # an auto-picked area needs this score ...
AUTO_AREA_GAP = 10   # ... and this lead over the runner-up
NAME_CLASH = 60      # a new area name this close to an existing one needs confirm_new


# --- helpers used by the task routes --------------------------------------------


def active_areas(db: Session) -> list[Area]:
    return list(db.scalars(select(Area).where(Area.merged_into_id.is_(None)).order_by(Area.slug)))


def _follow(db: Session, area: Area) -> Area:
    seen = set()
    while area.merged_into_id is not None and area.id not in seen:
        seen.add(area.id)
        area = db.get(Area, area.merged_into_id)
    return area


def _name_matches(name: str, areas: list[Area], limit: int = 3) -> list[tuple[Area, int]]:
    scored = []
    for a in areas:
        best = max([name_score(name, a.slug.replace("-", " ")), name_score(name, a.name)]
                   + [name_score(name, x) for x in a.aliases or []])
        scored.append((a, best))
    scored.sort(key=lambda kv: -kv[1])
    return [kv for kv in scored[:limit] if kv[1] > 0]


def resolve_area(db: Session, ref: str) -> Area:
    """An area by slug, or by an exact name or alias; follows merges. 422 with
    suggestions when nothing matches."""
    ref = (ref or "").strip()
    area = db.scalar(select(Area).where(Area.slug == ref.lower()))
    if area is None:
        wanted = normalize(ref)
        for a in db.scalars(select(Area)):
            if wanted and (normalize(a.name) == wanted or wanted in [normalize(x) for x in a.aliases or []]):
                area = a
                break
    if area is None:
        close = [a.slug for a, s in _name_matches(ref, active_areas(db)) if s >= 40]
        hint = f" Did you mean: {', '.join(close)}?" if close else ""
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"No area '{ref}'.{hint} GET /areas lists them; POST /areas adds one.",
        )
    return _follow(db, area)


def area_and_children_ids(db: Session, area: Area) -> list[int]:
    ids = [area.id]
    todo = [area.id]
    while todo:
        current = todo.pop()
        kids = list(db.scalars(select(Area.id).where(Area.parent_id == current, Area.merged_into_id.is_(None))))
        ids += kids
        todo += kids
    return ids


def _task_doc(task: Task) -> Doc:
    body = "\n".join([task.description or ""] + [c.text for c in task.criteria])
    return Doc(task.id, task.title, body)


def _band(score: int) -> str:
    if score >= DUPLICATE:
        return "duplicate"
    if score >= RELATED:
        return "related"
    return "similar"


def find_similar(
    db: Session,
    user: User,
    *,
    title: str,
    description: str | None,
    criteria: list[str],
    area_id: int | None,
    exclude_ids: set[int],
    limit: int,
) -> SimilarOut:
    """Tasks the user can see that look like this text, best first, and the
    areas the text fits. Compares against every task (open, done, dropped), so a
    duplicate filed under another area is still found."""
    from app.routers.tasks import _can_see  # visibility rules live with the task routes

    tasks = [
        t for t in db.scalars(select(Task).options(selectinload(Task.criteria))).unique()
        if t.id not in exclude_ids and _can_see(t, user)
    ]
    by_id = {t.id: t for t in tasks}
    query = Doc(0, title, "\n".join([description or ""] + list(criteria)))
    ranked = rank(query, [_task_doc(t) for t in tasks])

    matches = []
    for task_id, score in ranked:
        if score < SIMILAR_FLOOR:
            break
        t = by_id[task_id]
        matches.append(SimilarMatch(
            id=t.id, title=t.title, status=t.status, kind=t.kind,
            area=AreaBrief.model_validate(t.area) if t.area else None,
            score=score, same_area=area_id is not None and t.area_id == area_id, band=_band(score),
        ))
    matches.sort(key=lambda m: -(m.score + (SAME_AREA_BOOST if m.same_area else 0)))
    return SimilarOut(matches=matches[:limit], suggested_areas=suggest_areas(db, query, ranked, by_id))


def suggest_areas(db: Session, query: Doc, ranked: list[tuple[int, int]], by_id: dict[int, Task]) -> list[AreaSuggestion]:
    words = set(tokens(query.title + " " + query.body))
    evidence: dict[int, list[int]] = {}
    for task_id, score in ranked:
        t = by_id.get(task_id)
        if t is not None and t.area_id is not None and score >= 30:
            evidence.setdefault(_follow(db, t.area).id if t.area.merged_into_id else t.area_id, []).append(score)
    out = []
    for a in active_areas(db):
        keyword = 0
        for term in [a.slug.replace("-", " "), a.name] + list(a.aliases or []):
            term_words = set(tokens(term))
            if term_words and term_words <= words:
                keyword = max(keyword, 80)
            elif term_words & words:
                keyword = max(keyword, round(60 * len(term_words & words) / len(term_words)))
        top = sorted(evidence.get(a.id, []), reverse=True)[:3]
        from_tasks = round(sum(top) / len(top)) if top else 0
        score = max(keyword, from_tasks)
        if score >= 30:
            out.append(AreaSuggestion(area=AreaBrief.model_validate(a), score=score))
    out.sort(key=lambda s: -s.score)
    return out[:3]


def clear_pick(suggestions: list[AreaSuggestion]) -> AreaSuggestion | None:
    if not suggestions or suggestions[0].score < AUTO_AREA_MIN:
        return None
    if len(suggestions) > 1 and suggestions[0].score - suggestions[1].score < AUTO_AREA_GAP:
        return None
    return suggestions[0]


# --- routes -------------------------------------------------------------------


def _area_out(db: Session, a: Area) -> AreaOut:
    from app.models import CLOSED_STATUSES

    total = db.scalar(select(func.count(Task.id)).where(Task.area_id == a.id)) or 0
    open_ = db.scalar(select(func.count(Task.id)).where(
        Task.area_id == a.id, Task.status.not_in(list(CLOSED_STATUSES)))) or 0
    parent = db.get(Area, a.parent_id) if a.parent_id else None
    merged = db.get(Area, a.merged_into_id) if a.merged_into_id else None
    return AreaOut(
        id=a.id, slug=a.slug, name=a.name, description=a.description, aliases=a.aliases or [],
        parent=parent.slug if parent else None, merged_into=merged.slug if merged else None,
        created_at=a.created_at, open_count=open_, total_count=total,
    )


@router.get("", response_model=list[AreaOut])
def list_areas(
    auth: AuthCtx,
    db: DbSession,
    response: Response,
    paging: Page,
    q: str | None = Query(default=None, max_length=100, description="Match name, slug, alias or description"),
    include_merged: bool = False,
) -> list[AreaOut]:
    rows = list(db.scalars(select(Area).order_by(Area.slug)))
    if not include_merged:
        rows = [a for a in rows if a.merged_into_id is None]
    if q:
        wanted = normalize(q)
        def hit(a: Area) -> bool:
            hay = " ".join([a.slug, a.name, a.description or ""] + list(a.aliases or []))
            return wanted in normalize(hay) or max(
                [name_score(q, a.name)] + [name_score(q, x) for x in a.aliases or []]) >= 60
        rows = [a for a in rows if hit(a)]
    if paging.on:
        # Counts are worked out for the rows of this page only.
        rows = paging.slice(rows, response)
    return [_area_out(db, a) for a in rows]


def _slugify(name: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:59]
    return slug


@router.post("", response_model=AreaOut, status_code=status.HTTP_201_CREATED)
def create_area(payload: AreaCreate, db: DbSession, auth: AuthCtx) -> AreaOut:
    user = auth.user
    if user.is_read_only:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Viewers cannot add areas")
    if auth.kind.value != "human" and not (auth.has("tasks:create") or auth.has("tasks:propose")):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN,
                            detail="Adding an area needs the tasks:create or tasks:propose scope")
    name = lint.clean(" ".join(payload.name.split()), field="name")
    slug = payload.slug or _slugify(name)
    if not AREA_SLUG_RE.match(slug or ""):
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                            detail="Give a slug (lowercase letters, digits, dashes) for this name")
    existing = db.scalar(select(Area).where(Area.slug == slug))
    if existing is not None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail={
            "message": f"Area '{slug}' already exists" + (
                f" (merged into '{_follow(db, existing).slug}')" if existing.merged_into_id else "") + ". Use it.",
            "suggestions": [AreaBrief.model_validate(_follow(db, existing)).model_dump()],
        })
    if not payload.confirm_new:
        close = []
        for term in [name] + payload.aliases:
            close += [(a, s) for a, s in _name_matches(term, active_areas(db)) if s >= NAME_CLASH]
        if close:
            best: dict[int, tuple[Area, int]] = {}
            for a, s in close:
                if a.id not in best or best[a.id][1] < s:
                    best[a.id] = (a, s)
            ordered = sorted(best.values(), key=lambda kv: -kv[1])[:3]
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail={
                "message": "Similar areas exist: " + ", ".join(f"{a.slug} ({s}%)" for a, s in ordered)
                + ". Use one of them, or send confirm_new=true if yours is different.",
                "suggestions": [{**AreaBrief.model_validate(a).model_dump(), "score": s} for a, s in ordered],
            })
    parent = resolve_area(db, payload.parent) if payload.parent else None
    area = Area(
        slug=slug, name=name, description=lint.clean(payload.description, field="description"),
        aliases=[lint.clean(a, field="alias") for a in payload.aliases],
        parent_id=parent.id if parent else None, created_by=user.id, actor_kind=auth.kind,
        created_at=utcnow(),
    )
    db.add(area)
    db.commit()
    return _area_out(db, area)


@router.patch("/{slug}", response_model=AreaOut)
def update_area(slug: str, payload: AreaUpdate, db: DbSession, _lead: User = Depends(require_leader)) -> AreaOut:
    area = resolve_area(db, slug)
    fields = payload.model_dump(exclude_unset=True)
    if "name" in fields and fields["name"]:
        area.name = lint.clean(" ".join(fields["name"].split()), field="name")
    if "description" in fields:
        area.description = lint.clean(fields["description"], field="description")
    if "aliases" in fields and fields["aliases"] is not None:
        area.aliases = [lint.clean(a, field="alias") for a in fields["aliases"]]
    if "parent" in fields:
        if not fields["parent"]:
            area.parent_id = None
        else:
            parent = resolve_area(db, fields["parent"])
            node, seen = parent, set()
            while node is not None and node.id not in seen:
                if node.id == area.id:
                    raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="That parent would make a loop")
                seen.add(node.id)
                node = db.get(Area, node.parent_id) if node.parent_id else None
            area.parent_id = parent.id
    db.commit()
    return _area_out(db, area)


@router.post("/{slug}/merge", response_model=AreaOut)
def merge_area(slug: str, payload: AreaMerge, db: DbSession, _lead: User = Depends(require_leader)) -> AreaOut:
    source = resolve_area(db, slug)
    target = resolve_area(db, payload.into)
    if source.id == target.id:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="An area cannot merge into itself")
    for task in db.scalars(select(Task).where(Task.area_id == source.id)):
        task.area_id = target.id
    for child in db.scalars(select(Area).where(Area.parent_id == source.id)):
        child.parent_id = target.id if child.id != target.id else target.parent_id
    names = [target.name.lower()] + [x.lower() for x in target.aliases or []]
    extra = [x for x in [source.name] + list(source.aliases or []) if x.lower() not in names]
    target.aliases = (list(target.aliases or []) + extra)[:15]
    source.merged_into_id = target.id
    db.commit()
    return _area_out(db, target)


def similar_tasks(payload: SimilarRequest, db: DbSession, auth: Auth) -> SimilarOut:
    area = resolve_area(db, payload.area) if payload.area else None
    exclude = {i for i in (payload.exclude_id, payload.parent_id) if i}
    return find_similar(
        db, auth.user, title=payload.title, description=payload.description, criteria=payload.criteria,
        area_id=area.id if area else None, exclude_ids=exclude, limit=payload.limit,
    )
