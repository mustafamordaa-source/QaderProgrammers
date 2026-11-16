import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../../api/client'

let cache = null

/** The area list, loaded once per page load and refreshed after an add. */
export async function loadAreas(force = false) {
  if (!cache || force) cache = api.areas()
  try {
    return await cache
  } catch (err) {
    cache = null
    throw err
  }
}

function matches(area, q) {
  if (!q) return true
  const hay = [area.slug, area.name, area.description ?? '', ...(area.aliases ?? []), ...(area.path ?? [])]
    .join(' ')
    .toLowerCase()
  return hay.includes(q.toLowerCase())
}

/** The flat list in tree order (each parent followed by its sub-areas), each with its depth. */
function inTreeOrder(areas) {
  const bySlug = new Map(areas.map((a) => [a.slug, a]))
  const kids = new Map()
  const tops = []
  for (const a of areas) {
    if (a.parent && bySlug.has(a.parent)) {
      if (!kids.has(a.parent)) kids.set(a.parent, [])
      kids.get(a.parent).push(a)
    } else tops.push(a)
  }
  const out = []
  const walk = (list, depth, seen) => {
    for (const a of [...list].sort((x, y) => x.name.localeCompare(y.name))) {
      if (seen.has(a.slug)) continue
      out.push({ area: a, depth })
      walk(kids.get(a.slug) ?? [], depth + 1, new Set([...seen, a.slug]))
    }
  }
  walk(tops, 0, new Set())
  return out
}

const parentPath = (area) => (area.path?.length > 1 ? area.path.slice(0, -1).join(' › ') : '')

/**
 * Pick a product area, search by name, slug or alias, or add one. Adding goes
 * through the hub's reuse check: a name close to an existing area comes back
 * with suggestions, and "Add anyway" confirms it is different.
 * `value` is a slug or ''.
 */
export default function AreaPicker({ id, value, onChange, suggestion = null }) {
  const [areas, setAreas] = useState([])
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [clash, setClash] = useState(null) // { name, message, suggestions }
  const [error, setError] = useState(null)
  const boxRef = useRef(null)

  useEffect(() => {
    loadAreas().then(setAreas).catch((err) => setError(err.message))
  }, [])

  useEffect(() => {
    function onDown(event) {
      if (boxRef.current && !boxRef.current.contains(event.target)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [])

  const selected = areas.find((a) => a.slug === value) ?? null
  const ordered = useMemo(() => inTreeOrder(areas), [areas])
  // With no search, the whole tree; with one, the matches (still grouped under their parents).
  const shownRows = useMemo(() => {
    const q = query.trim()
    // Matches show their path in the label instead of the indent.
    return q ? ordered.filter((row) => matches(row.area, q)).slice(0, 30).map((row) => ({ ...row, depth: 0 })) : ordered
  }, [ordered, query])
  const shown = shownRows.map((row) => row.area)
  const exact = areas.some((a) => a.name.toLowerCase() === query.trim().toLowerCase() || a.slug === query.trim())

  function pick(slug) {
    onChange(slug)
    setQuery('')
    setOpen(false)
    setClash(null)
  }

  async function add(confirmNew = false) {
    const name = (clash?.name ?? query).trim()
    if (name.length < 2) return
    setBusy(true)
    setError(null)
    try {
      const created = await api.createArea({ name, confirm_new: confirmNew })
      setAreas(await loadAreas(true))
      pick(created.slug)
    } catch (err) {
      if (err.status === 409 && err.detail?.suggestions) {
        setClash({ name, message: err.message, suggestions: err.detail.suggestions })
      } else {
        setError(err.message)
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <div ref={boxRef} className="relative mt-1.5">
      {selected && !open ? (
        <div className="flex items-center gap-2 rounded-lg border border-hairline bg-surface-raised px-3 py-2 text-sm">
          <span className="min-w-0 truncate" dir="auto">
            {parentPath(selected) && <span className="text-ink-muted">{parentPath(selected)} › </span>}
            <span className="font-medium">{selected.name}</span>
          </span>
          <code className="hidden text-xs text-ink-muted sm:inline">{selected.slug}</code>
          <button type="button" className="ms-auto text-xs text-ink-secondary hover:text-ink" onClick={() => setOpen(true)}>
            Change
          </button>
          <button type="button" className="text-xs text-ink-secondary hover:text-ink" onClick={() => onChange('')}>
            Clear
          </button>
        </div>
      ) : (
        <input
          id={id}
          dir="auto"
          autoComplete="off"
          placeholder="Search areas, or type a new one"
          value={query}
          onFocus={() => setOpen(true)}
          onChange={(event) => {
            setQuery(event.target.value)
            setOpen(true)
            setClash(null)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') setOpen(false)
            if (event.key === 'Enter') {
              event.preventDefault()
              if (shown[0]) pick(shown[0].slug)
            }
          }}
          className="w-full rounded-lg border border-hairline bg-surface-raised px-3 py-2 text-sm outline-none focus:border-series1"
        />
      )}
      {!value && suggestion && (
        <button
          type="button"
          onClick={() => pick(suggestion.area.slug)}
          className="mt-1.5 rounded-full border border-series1/40 px-2.5 py-0.5 text-xs text-series1 hover:bg-series1/5"
        >
          Suggested: {suggestion.area.name} ({suggestion.score}%)
        </button>
      )}
      {open && (
        <div className="absolute z-20 mt-1 max-h-72 w-full overflow-auto rounded-lg border border-hairline bg-surface p-1 shadow-lg">
          {shownRows.map(({ area: a, depth }) => (
            <button
              key={a.slug}
              type="button"
              onClick={() => pick(a.slug)}
              title={a.path?.join(' › ')}
              style={{ paddingInlineStart: `${0.5 + Math.min(depth, 4) * 1.25}rem` }}
              className={`block w-full rounded-md py-1.5 pe-2 text-start text-sm hover:bg-surface-raised ${
                a.slug === value ? 'bg-surface-raised' : ''
              } ${depth === 0 && a.children_count > 0 ? 'mt-1 first:mt-0' : ''}`}
            >
              <span className="float-end ms-2 text-xs tabular text-ink-muted">
                {a.children_count > 0 ? `${a.subtree_open} open with sub-areas` : `${a.open_count} open`}
              </span>
              {depth > 0 && <span aria-hidden="true" className="text-ink-muted">└ </span>}
              {parentPath(a) && (
                <span className={query.trim() ? 'text-xs text-ink-muted' : 'sr-only'} dir="auto">{parentPath(a)} › </span>
              )}
              <span className={depth === 0 ? 'font-medium' : ''} dir="auto">{a.name}</span>{' '}
              <code className="text-xs text-ink-muted">{a.slug}</code>
              {(a.description || a.aliases?.length > 0) && (
                <span className="block truncate text-xs text-ink-muted" dir="auto">
                  {[a.description, a.aliases?.length ? `also: ${a.aliases.join(', ')}` : null].filter(Boolean).join(' · ')}
                </span>
              )}
            </button>
          ))}
          {shown.length === 0 && <p className="px-2 py-1.5 text-xs text-ink-muted">No area matches.</p>}
          {query.trim().length >= 2 && !exact && !clash && (
            <button
              type="button"
              disabled={busy}
              onClick={() => add(false)}
              className="mt-1 block w-full rounded-md border-t border-hairline px-2 py-1.5 text-start text-sm text-series1 hover:bg-surface-raised"
            >
              + Add area “{query.trim()}”
            </button>
          )}
          {clash && (
            <div role="alert" className="mt-1 rounded-md border border-warning/50 p-2 text-xs">
              <p dir="auto" className="text-ink-secondary">{clash.message}</p>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {clash.suggestions.map((s) => (
                  <button key={s.slug} type="button" onClick={() => pick(s.slug)}
                    className="rounded-full border border-hairline px-2 py-0.5 hover:border-series1">
                    Use {s.name}{s.score ? ` (${s.score}%)` : ''}
                  </button>
                ))}
                <button type="button" disabled={busy} onClick={() => add(true)}
                  className="rounded-full px-2 py-0.5 text-ink-secondary hover:text-ink">
                  Add “{clash.name}” anyway
                </button>
              </div>
            </div>
          )}
        </div>
      )}
      {error && <p dir="auto" className="mt-1 text-xs text-critical">{error}</p>}
    </div>
  )
}
