import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api/client'
import { useAuth } from '../auth/AuthContext'
import { loadAreas } from '../components/board/AreaPicker'
import LoadMore from '../components/LoadMore'
import { usePagedList } from '../lib/usePagedList'

const input =
  'w-full rounded-lg border border-hairline bg-surface-raised px-3 py-2 text-sm outline-none focus:border-series1'

const OPEN_KEY = 'taskflow.areas.expanded'
const SORT_KEY = 'taskflow.areas.sort'

function readStored(key, fallback) {
  try {
    const raw = localStorage.getItem(key)
    return raw === null ? fallback : JSON.parse(raw)
  } catch {
    return fallback
  }
}

function writeStored(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // Private window or blocked storage: the page works without it.
  }
}

const pathText = (area) => (area.path?.length ? area.path.join(' › ') : area.name)
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`

/** Slugs of `slug` and every area below it, from the flat list (parent links). */
function subtreeSlugs(areas, slug) {
  const out = new Set([slug])
  let grew = true
  while (grew) {
    grew = false
    for (const a of areas) {
      if (a.parent && out.has(a.parent) && !out.has(a.slug)) {
        out.add(a.slug)
        grew = true
      }
    }
  }
  return out
}

/** The flat list in tree order: each parent followed by its sub-areas. */
function treeOrder(areas) {
  const bySlug = new Map(areas.map((a) => [a.slug, a]))
  const kids = new Map()
  const tops = []
  for (const a of areas) {
    if (a.parent && bySlug.has(a.parent)) {
      if (!kids.has(a.parent)) kids.set(a.parent, [])
      kids.get(a.parent).push(a)
    } else tops.push(a)
  }
  const byName = (x, y) => x.name.localeCompare(y.name)
  const out = []
  const walk = (list, seen) => {
    for (const a of [...list].sort(byName)) {
      if (seen.has(a.slug)) continue
      out.push(a)
      walk(kids.get(a.slug) ?? [], new Set([...seen, a.slug]))
    }
  }
  walk(tops, new Set())
  return out
}

function AreaRow({ area, areas, isLead, onSaved, showPath = false, expanded, onToggle }) {
  const [editing, setEditing] = useState(false)
  const [form, setForm] = useState(null)
  const [mergeInto, setMergeInto] = useState('')
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const hasKids = (area.children_count ?? 0) > 0
  const kids = area.subareas ?? []

  // An area cannot sit under itself or under one of its own sub-areas.
  const parentChoices = useMemo(() => {
    if (!editing) return []
    const blocked = subtreeSlugs(areas, area.slug)
    return treeOrder(areas).filter((a) => !blocked.has(a.slug))
  }, [editing, areas, area.slug])
  const mergeChoices = useMemo(
    () => (editing ? treeOrder(areas).filter((a) => a.slug !== area.slug) : []),
    [editing, areas, area.slug],
  )

  function start() {
    setForm({
      name: area.name,
      description: area.description ?? '',
      aliases: (area.aliases ?? []).join(', '),
      parent: area.parent ?? '',
    })
    setEditing(true)
    setError(null)
  }

  async function save() {
    setBusy(true)
    setError(null)
    try {
      await api.updateArea(area.slug, {
        name: form.name.trim(),
        description: form.description.trim() || null,
        aliases: form.aliases.split(',').map((a) => a.trim()).filter(Boolean),
        parent: form.parent,
      })
      setEditing(false)
      onSaved()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  async function merge() {
    if (!mergeInto) return
    if (!window.confirm(`Move every task from ${area.name} into ${mergeInto} and retire ${area.slug}?`)) return
    setBusy(true)
    setError(null)
    try {
      await api.mergeArea(area.slug, mergeInto)
      onSaved()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <li className="rounded-lg border border-hairline p-3">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        {onToggle && (
          hasKids ? (
            <button type="button" onClick={() => onToggle(area.slug)} aria-expanded={expanded}
              aria-label={`${expanded ? 'Hide' : 'Show'} sub-areas of ${area.name}`}
              className="w-5 shrink-0 text-center text-ink-secondary hover:text-ink">
              <span aria-hidden="true" className={`inline-block transition-transform ${expanded ? 'rotate-90' : 'rtl:rotate-180'}`}>›</span>
            </button>
          ) : (
            <span className="w-5 shrink-0" aria-hidden="true" />
          )
        )}
        <span className="min-w-0">
          {showPath && area.path?.length > 1 && (
            <span dir="auto" className="block text-xs text-ink-muted">{area.path.slice(0, -1).join(' › ')} ›</span>
          )}
          <Link to={`/board?area=${encodeURIComponent(area.slug)}`} dir="auto"
            className="font-medium text-series2 hover:underline">
            {area.name}
          </Link>{' '}
          <code className="text-xs text-ink-muted">{area.slug}</code>
        </span>
        <span className="ms-auto flex flex-wrap items-baseline justify-end gap-x-3 text-xs tabular text-ink-secondary">
          {hasKids && (
            <span>
              {plural(area.children_count, 'sub-area', 'sub-areas')} · {area.subtree_open} open
              <span className="text-ink-muted"> of {area.subtree_total}</span>
            </span>
          )}
          <span className={hasKids ? 'text-ink-muted' : undefined} title="Tasks in this area alone">
            {hasKids && 'itself: '}{area.open_count} open · {area.total_count} total
          </span>
          {isLead && !editing && (
            <button type="button" onClick={start} className="text-ink-secondary hover:text-ink">
              Edit
            </button>
          )}
        </span>
      </div>
      {!editing && (area.description || area.aliases?.length > 0) && (
        <p dir="auto" className={`mt-1 text-sm text-ink-secondary ${onToggle ? 'ps-7' : ''}`}>
          {area.description}
          {area.aliases?.length > 0 && (
            <span className="block text-xs text-ink-muted">Also called: {area.aliases.join(', ')}</span>
          )}
        </p>
      )}
      {editing && (
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          <input aria-label="Name" dir="auto" className={input} value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <select aria-label="Parent area" className={input} value={form.parent}
            onChange={(e) => setForm({ ...form, parent: e.target.value })}>
            <option value="">No parent (top level)</option>
            {parentChoices.map((a) => (
              <option key={a.slug} value={a.slug}>{pathText(a)}</option>
            ))}
          </select>
          <input aria-label="Description" dir="auto" className={`${input} sm:col-span-2`} placeholder="One line: what belongs here"
            value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          <input aria-label="Aliases" dir="auto" className={`${input} sm:col-span-2`} placeholder="Other words people use, comma separated (any language)"
            value={form.aliases} onChange={(e) => setForm({ ...form, aliases: e.target.value })} />
          <div className="flex flex-wrap items-center gap-2 sm:col-span-2">
            <button type="button" disabled={busy} onClick={save}
              className="rounded-lg bg-series1 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-60">Save</button>
            <button type="button" onClick={() => setEditing(false)} className="text-sm text-ink-secondary hover:text-ink">Cancel</button>
            <span className="flex min-w-0 flex-wrap items-center gap-2 text-sm sm:ms-auto">
              <select aria-label="Merge into" className="min-w-0 max-w-full rounded-lg border border-hairline bg-surface-raised px-2 py-1.5 text-sm"
                value={mergeInto} onChange={(e) => setMergeInto(e.target.value)}>
                <option value="">Merge into…</option>
                {mergeChoices.map((a) => (
                  <option key={a.slug} value={a.slug}>{pathText(a)}</option>
                ))}
              </select>
              <button type="button" disabled={busy || !mergeInto} onClick={merge}
                className="rounded-lg border border-hairline px-3 py-1.5 text-sm disabled:opacity-50">Merge</button>
            </span>
          </div>
        </div>
      )}
      {error && <p role="alert" dir="auto" className="mt-1 text-sm text-critical">{error}</p>}
      {expanded && kids.length > 0 && (
        <ul className="mt-2 space-y-2 border-s border-hairline ps-2 sm:ps-4">
          {kids.map((k) => (
            <TreeNode key={k.slug} area={k} areas={areas} isLead={isLead} onSaved={onSaved} />
          ))}
        </ul>
      )}
    </li>
  )
}

// The expanded parents (slugs) and the toggle, shared by every row of the tree.
const TreeState = createContext({ open: new Set(), toggle: () => {} })

/** One area in the tree, expanded or not by the shared state. */
function TreeNode(props) {
  const { open, toggle } = useContext(TreeState)
  return <AreaRow {...props} expanded={open.has(props.area.slug)} onToggle={toggle} />
}

const areaKey = (area) => area.slug

function parentSlugs(nodes, out = []) {
  for (const a of nodes) {
    if (a.subareas?.length) {
      out.push(a.slug)
      parentSlugs(a.subareas, out)
    }
  }
  return out
}

function countBelow(nodes) {
  let n = 0
  for (const a of nodes) n += (a.subareas?.length ?? 0) + countBelow(a.subareas ?? [])
  return n
}

/** The shared list of product areas as a tree: search, add (with the reuse check), and for leads edit and merge. */
export default function AreasPage() {
  const { isLead } = useAuth()
  const [q, setQ] = useState('')
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState(() => (readStored(SORT_KEY, 'name') === 'open' ? 'open' : 'name'))
  const [open, setOpen] = useState(() => {
    const stored = readStored(OPEN_KEY, [])
    return new Set(Array.isArray(stored) ? stored : [])
  })
  // Wait until typing stops before asking the server.
  useEffect(() => {
    const timer = setTimeout(() => setSearch(q.trim()), 300)
    return () => clearTimeout(timer)
  }, [q])

  // The tree: top-level areas with their sub-areas nested (the whole tree, it is small).
  const [tree, setTree] = useState([])
  const [treeLoading, setTreeLoading] = useState(true)
  const [treeError, setTreeError] = useState(null)
  const loadTree = useCallback(async () => {
    setTreeLoading(true)
    try {
      setTree(await api.areaTree(sort))
      setTreeError(null)
    } catch (err) {
      setTreeError(err.message)
    } finally {
      setTreeLoading(false)
    }
  }, [sort])
  useEffect(() => {
    loadTree()
  }, [loadTree])

  // A search answers flat, 20 at a time; each match shows its path.
  const fetchPage = useCallback(
    (pageNumber, pageSize) =>
      search ? api.areasPage(search, pageNumber, pageSize, { sort }) : Promise.resolve({ items: [], total: 0 }),
    [search, sort],
  )
  const { items: found, total, loading, loadingMore, error: listError, hasMore, loadMore, reload } =
    usePagedList(fetchPage, { keyOf: areaKey })

  // Every area, flat, for the parent and merge pickers (shared with the board's cache).
  const [areas, setAreas] = useState([])
  const [error, setError] = useState(null)
  const [adding, setAdding] = useState({ name: '', description: '', aliases: '' })
  const [clash, setClash] = useState(null)
  const [busy, setBusy] = useState(false)

  function toggle(slug) {
    setOpen((current) => {
      const next = new Set(current)
      if (next.has(slug)) next.delete(slug)
      else next.add(slug)
      writeStored(OPEN_KEY, [...next])
      return next
    })
  }

  function chooseSort(value) {
    setSort(value)
    writeStored(SORT_KEY, value)
  }

  function setAll(expand) {
    const next = expand ? new Set(parentSlugs(tree)) : new Set()
    setOpen(next)
    writeStored(OPEN_KEY, [...next])
  }

  async function refresh() {
    try {
      const [all] = await Promise.all([loadAreas(true), reload(), loadTree()])
      setAreas(all)
      setError(null)
    } catch (err) {
      setError(err.message)
    }
  }

  useEffect(() => {
    if (!isLead) return
    loadAreas().then(setAreas).catch(() => setAreas([]))
  }, [isLead])

  async function add(event, confirmNew = false) {
    event?.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await api.createArea({
        name: adding.name.trim(),
        description: adding.description.trim() || null,
        aliases: adding.aliases.split(',').map((a) => a.trim()).filter(Boolean),
        confirm_new: confirmNew,
      })
      setAdding({ name: '', description: '', aliases: '' })
      setClash(null)
      await refresh()
    } catch (err) {
      if (err.status === 409 && err.detail?.suggestions) setClash(err.detail)
      else setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  const subCount = useMemo(() => countBelow(tree), [tree])
  const openTotal = useMemo(() => tree.reduce((sum, a) => sum + (a.subtree_open ?? 0), 0), [tree])
  const parents = tree.filter((a) => a.children_count > 0).length
  const pickerAreas = areas.length ? areas : found
  const shownError = error || (search ? listError : treeError)

  return (
    <div className="mx-auto max-w-4xl px-4 py-6 sm:px-6">
      <h1 className="text-xl font-semibold">Areas</h1>
      <p className="mt-1 text-sm text-ink-secondary">
        The product areas tasks belong to, with their sub-areas. Reuse one before you add one: the hub refuses a
        new name close to an existing area or alias. Click an area to see its tasks on the board; a parent
        includes its sub-areas.
      </p>

      {!treeLoading && !treeError && tree.length > 0 && (
        <p className="mt-3 text-sm tabular text-ink-secondary">
          {plural(tree.length, 'top-level area', 'top-level areas')} · {plural(subCount, 'sub-area', 'sub-areas')} ·{' '}
          <span className="font-medium text-ink">{openTotal} open tasks</span>
        </p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <input aria-label="Search areas" dir="auto" placeholder="Search by name, alias or description"
          className={`${input} min-w-0 flex-1 basis-56`} value={q} onChange={(e) => setQ(e.target.value)} />
        <div role="group" aria-label="Sort areas" className="flex rounded-lg border border-hairline p-0.5 text-sm">
          {[['name', 'By name'], ['open', 'By open work']].map(([value, label]) => (
            <button key={value} type="button" aria-pressed={sort === value} onClick={() => chooseSort(value)}
              className={`rounded-md px-2.5 py-1 ${sort === value ? 'bg-surface-raised font-medium text-ink' : 'text-ink-secondary hover:text-ink'}`}>
              {label}
            </button>
          ))}
        </div>
        {!search && parents > 0 && (
          <span className="flex gap-2 text-xs">
            <button type="button" onClick={() => setAll(true)} className="text-ink-secondary hover:text-ink">Expand all</button>
            <button type="button" onClick={() => setAll(false)} className="text-ink-secondary hover:text-ink">Collapse all</button>
          </span>
        )}
      </div>

      {shownError && <p role="alert" dir="auto" className="mt-3 text-sm text-critical">{shownError}</p>}

      {search ? (
        <>
          {loading && found.length === 0 && !listError && <p className="mt-4 text-sm text-ink-muted">Loading…</p>}
          {!(loading && found.length === 0) && (
            <ul className="mt-4 space-y-2">
              {found.map((a) => (
                <AreaRow key={a.slug} area={a} areas={pickerAreas} isLead={isLead} onSaved={refresh} showPath />
              ))}
              {found.length === 0 && <p className="text-sm text-ink-muted">No area matches.</p>}
            </ul>
          )}
          <LoadMore shown={found.length} total={total} hasMore={hasMore} loading={loadingMore} onMore={loadMore} noun="areas" />
        </>
      ) : (
        <>
          {treeLoading && tree.length === 0 && !treeError && <p className="mt-4 text-sm text-ink-muted">Loading…</p>}
          {!(treeLoading && tree.length === 0) && (
            <TreeState.Provider value={{ open, toggle }}>
              <ul className="mt-4 space-y-2">
                {tree.map((a) => (
                  <TreeNode key={a.slug} area={a} areas={areas.length ? areas : tree} isLead={isLead} onSaved={refresh} />
                ))}
                {tree.length === 0 && !treeError && <p className="text-sm text-ink-muted">No areas yet.</p>}
              </ul>
            </TreeState.Provider>
          )}
        </>
      )}

      <form onSubmit={add} className="mt-6 rounded-lg border border-hairline p-3">
        <h2 className="text-sm font-semibold">Add an area</h2>
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          <input required minLength={2} aria-label="New area name" dir="auto" placeholder="Name, for example Payments"
            className={input} value={adding.name} onChange={(e) => { setAdding({ ...adding, name: e.target.value }); setClash(null) }} />
          <input aria-label="New area aliases" dir="auto" placeholder="Aliases, comma separated"
            className={input} value={adding.aliases} onChange={(e) => setAdding({ ...adding, aliases: e.target.value })} />
          <input aria-label="New area description" dir="auto" placeholder="One line: what belongs here"
            className={`${input} sm:col-span-2`} value={adding.description}
            onChange={(e) => setAdding({ ...adding, description: e.target.value })} />
        </div>
        {clash && (
          <div role="alert" className="mt-2 rounded-lg border border-warning/50 p-2 text-sm">
            <p dir="auto">{clash.message}</p>
            <button type="button" disabled={busy} onClick={() => add(null, true)}
              className="mt-1 text-sm text-series1 hover:underline">It is different: add it anyway</button>
          </div>
        )}
        <button type="submit" disabled={busy}
          className="mt-2 rounded-lg bg-series1 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-60">
          Add area
        </button>
      </form>
    </div>
  )
}
