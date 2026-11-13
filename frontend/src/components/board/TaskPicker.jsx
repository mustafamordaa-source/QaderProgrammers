import { useEffect, useRef, useState } from 'react'
import { api } from '../../api/client'
import { KindBadge, StatusBadge } from '../Badges'
import { isClosed } from '../../lib/constants'

const inputClass =
  'w-full rounded-lg border border-hairline bg-surface-raised px-2.5 py-1.5 text-sm outline-none focus:border-series1'

/**
 * Search tasks by title, description or summary (GET /tasks?q=), or type
 * "#12" for one task by ID. Results show in place, not in a floating menu,
 * so they never sit under the modal's edge.
 *
 * `accept(task)` returns null when the task may be picked, or the reason it
 * may not (shown greyed out next to it).
 */
export default function TaskPicker({
  id,
  value,
  onChange,
  accept = () => null,
  includeClosed = false,
  placeholder = 'Search tasks, or #ID',
  clearLabel = 'Change',
}) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const requestId = useRef(0)

  useEffect(() => {
    const text = query.trim()
    if (!text) {
      setResults([])
      setError(null)
      return undefined
    }
    const timer = setTimeout(async () => {
      const current = ++requestId.current
      setLoading(true)
      setError(null)
      try {
        const byId = /^#?(\d+)$/.exec(text)
        let list
        if (byId) {
          try {
            list = [await api.task(Number(byId[1]))]
          } catch (err) {
            if (err.status !== 404 && err.status !== 403) throw err
            list = []
          }
          if (!includeClosed) list = list.filter((task) => !isClosed(task.status))
        } else {
          list = await api.tasks({ q: text, include_closed: includeClosed ? undefined : false, limit: 20 })
        }
        if (current === requestId.current) setResults(list)
      } catch (err) {
        if (current === requestId.current) setError(err.message)
      } finally {
        if (current === requestId.current) setLoading(false)
      }
    }, 300)
    return () => clearTimeout(timer)
  }, [query, includeClosed])

  if (value) {
    return (
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-hairline bg-surface-raised px-2.5 py-1.5 text-sm">
        <span className="tabular text-xs text-ink-muted">#{value.id}</span>
        <span dir="auto" className="min-w-0 flex-1 truncate" title={value.title}>
          {value.title}
        </span>
        {value.status && <StatusBadge status={value.status} />}
        <button
          type="button"
          onClick={() => onChange(null)}
          className="text-xs text-ink-secondary underline-offset-2 hover:text-ink hover:underline"
        >
          {clearLabel}
        </button>
      </div>
    )
  }

  return (
    <div>
      <input
        id={id}
        type="search"
        dir="auto"
        autoComplete="off"
        placeholder={placeholder}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        className={inputClass}
      />
      {query.trim() && (
        <div className="mt-1 max-h-56 overflow-y-auto rounded-lg border border-hairline">
          {loading && results.length === 0 ? (
            <p className="px-3 py-2 text-xs text-ink-muted">Searching…</p>
          ) : error ? (
            <p dir="auto" className="px-3 py-2 text-xs text-critical">{error}</p>
          ) : results.length === 0 ? (
            <p className="px-3 py-2 text-xs text-ink-muted">No matching tasks.</p>
          ) : (
            <ul className="divide-y divide-hairline">
              {results.map((task) => {
                const reason = accept(task)
                return (
                  <li key={task.id}>
                    <button
                      type="button"
                      disabled={Boolean(reason)}
                      title={reason ?? undefined}
                      onClick={() => {
                        onChange(task)
                        setQuery('')
                      }}
                      className="flex w-full flex-wrap items-center gap-2 px-3 py-1.5 text-left text-sm transition hover:bg-surface-raised disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <span className="tabular text-xs text-ink-muted">#{task.id}</span>
                      <span dir="auto" className="min-w-0 flex-1 truncate">{task.title}</span>
                      <KindBadge kind={task.kind} hideTask />
                      <StatusBadge status={task.status} />
                      {reason && <span className="w-full text-[11px] text-ink-muted">{reason}</span>}
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
