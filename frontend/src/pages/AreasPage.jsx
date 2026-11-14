import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api/client'
import { useAuth } from '../auth/AuthContext'
import { loadAreas } from '../components/board/AreaPicker'

const input =
  'w-full rounded-lg border border-hairline bg-surface-raised px-3 py-2 text-sm outline-none focus:border-series1'

function AreaRow({ area, areas, isLead, onSaved }) {
  const [editing, setEditing] = useState(false)
  const [form, setForm] = useState(null)
  const [mergeInto, setMergeInto] = useState('')
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)

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
      <div className="flex flex-wrap items-baseline gap-2">
        <Link to={`/board?area=${area.slug}`} dir="auto" className="font-medium text-series2 hover:underline">
          {area.name}
        </Link>
        <code className="text-xs text-ink-muted">{area.slug}</code>
        {area.parent && <span className="text-xs text-ink-muted">in {area.parent}</span>}
        <span className="ms-auto text-xs tabular text-ink-secondary">
          {area.open_count} open · {area.total_count} total
        </span>
        {isLead && !editing && (
          <button type="button" onClick={start} className="text-xs text-ink-secondary hover:text-ink">
            Edit
          </button>
        )}
      </div>
      {!editing && (area.description || area.aliases?.length > 0) && (
        <p dir="auto" className="mt-1 text-sm text-ink-secondary">
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
            <option value="">No parent</option>
            {areas.filter((a) => a.slug !== area.slug).map((a) => (
              <option key={a.slug} value={a.slug}>{a.name}</option>
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
            <span className="ms-auto flex items-center gap-2 text-sm">
              <select aria-label="Merge into" className="rounded-lg border border-hairline bg-surface-raised px-2 py-1.5 text-sm"
                value={mergeInto} onChange={(e) => setMergeInto(e.target.value)}>
                <option value="">Merge into…</option>
                {areas.filter((a) => a.slug !== area.slug).map((a) => (
                  <option key={a.slug} value={a.slug}>{a.name}</option>
                ))}
              </select>
              <button type="button" disabled={busy || !mergeInto} onClick={merge}
                className="rounded-lg border border-hairline px-3 py-1.5 text-sm disabled:opacity-50">Merge</button>
            </span>
          </div>
        </div>
      )}
      {error && <p role="alert" dir="auto" className="mt-1 text-sm text-critical">{error}</p>}
    </li>
  )
}

/** The shared list of product areas: search, add (with the reuse check), and for leads edit and merge. */
export default function AreasPage() {
  const { isLead } = useAuth()
  const [areas, setAreas] = useState(null)
  const [q, setQ] = useState('')
  const [error, setError] = useState(null)
  const [adding, setAdding] = useState({ name: '', description: '', aliases: '' })
  const [clash, setClash] = useState(null)
  const [busy, setBusy] = useState(false)

  async function refresh() {
    try {
      setAreas(await loadAreas(true))
      setError(null)
    } catch (err) {
      setError(err.message)
    }
  }

  useEffect(() => {
    refresh()
  }, [])

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase()
    if (!areas) return []
    if (!needle) return areas
    return areas.filter((a) =>
      [a.slug, a.name, a.description ?? '', ...(a.aliases ?? [])].join(' ').toLowerCase().includes(needle),
    )
  }, [areas, q])

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

  return (
    <div className="mx-auto max-w-4xl px-4 py-6 sm:px-6">
      <h1 className="text-xl font-semibold">Areas</h1>
      <p className="mt-1 text-sm text-ink-secondary">
        The product areas tasks belong to. Reuse one before you add one: the hub refuses a new name close to
        an existing area or alias. Click an area to see its tasks on the board.
      </p>

      <input aria-label="Search areas" dir="auto" placeholder="Search by name, alias or description"
        className={`${input} mt-4`} value={q} onChange={(e) => setQ(e.target.value)} />

      {error && <p role="alert" dir="auto" className="mt-3 text-sm text-critical">{error}</p>}
      {areas === null && !error && <p className="mt-4 text-sm text-ink-muted">Loading…</p>}
      {areas && (
        <ul className="mt-4 space-y-2">
          {shown.map((a) => (
            <AreaRow key={a.slug} area={a} areas={areas} isLead={isLead} onSaved={refresh} />
          ))}
          {shown.length === 0 && <p className="text-sm text-ink-muted">No area matches.</p>}
        </ul>
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
