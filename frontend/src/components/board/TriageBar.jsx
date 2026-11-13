import { useState } from 'react'
import { api } from '../../api/client'
import {
  PRIORITIES,
  PRIORITY_LABELS,
  SIDES,
  SIDE_LABELS,
  STATUS_LABELS,
} from '../../lib/constants'
import { dangerButton, primaryButton, secondaryButton, smallInputClass } from './detail/ui'

const selectClass =
  'rounded-lg border border-hairline bg-surface-raised px-2.5 py-1.5 text-sm outline-none focus:border-series1'

/**
 * Bulk triage for leads: accept the ticked proposals into Backlog or To do
 * (with an optional assignee, priority and side), or drop them with a reason.
 * The server checks each task on its own, so the bar shows a line per task.
 */
export default function TriageBar({ tasks, selectedIds, programmers, onClear, onDone }) {
  const [assignee, setAssignee] = useState('')
  const [priority, setPriority] = useState('')
  const [side, setSide] = useState('')
  const [dropping, setDropping] = useState(false)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [results, setResults] = useState(null)

  const ids = [...selectedIds]
  const titles = Object.fromEntries(tasks.map((t) => [t.id, t.title]))

  async function send(to) {
    setError(null)
    setBusy(true)
    const payload = { task_ids: ids, to }
    if (to === 'dropped') {
      payload.reason = reason.trim()
    } else {
      if (assignee) payload.assignee_1_id = Number(assignee)
      if (priority) payload.priority = priority
      if (side) payload.side = side
    }
    try {
      const answer = await api.triage(payload)
      setResults(answer.map((r) => ({ ...r, title: titles[r.id] })))
      if (to === 'dropped' && answer.some((r) => r.ok)) {
        setReason('')
        setDropping(false)
      }
      onDone(answer.filter((r) => r.ok).map((r) => r.id))
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  if (ids.length === 0 && !results) return null

  return (
    <section
      aria-label="Bulk triage"
      className="mb-4 rounded-xl border border-series1/40 bg-surface p-3"
    >
      {ids.length > 0 && (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">
              {ids.length} selected for triage
            </span>
            <button type="button" onClick={onClear} className="text-xs text-ink-secondary underline-offset-2 hover:text-ink hover:underline">
              Clear selection
            </button>
          </div>

          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            <select aria-label="Assignee when accepted" value={assignee} onChange={(e) => setAssignee(e.target.value)} className={selectClass}>
              <option value="">No assignee</option>
              {programmers.map((person) => (
                <option key={person.id} value={person.id}>
                  {person.name}
                </option>
              ))}
            </select>
            <select aria-label="Priority when accepted" value={priority} onChange={(e) => setPriority(e.target.value)} className={selectClass}>
              <option value="">Keep priority</option>
              {PRIORITIES.map((p) => (
                <option key={p} value={p}>{PRIORITY_LABELS[p]}</option>
              ))}
            </select>
            <select aria-label="Side when accepted" value={side} onChange={(e) => setSide(e.target.value)} className={selectClass}>
              <option value="">Keep side</option>
              {SIDES.map((s) => (
                <option key={s} value={s}>{SIDE_LABELS[s]}</option>
              ))}
            </select>
            <button type="button" disabled={busy} onClick={() => send('backlog')} className={secondaryButton}>
              Accept to Backlog
            </button>
            <button type="button" disabled={busy} onClick={() => send('to_do')} className={primaryButton}>
              Accept to To do
            </button>
            <button type="button" disabled={busy} onClick={() => setDropping((v) => !v)} className={dangerButton}>
              Drop…
            </button>
          </div>
          <p className="mt-1.5 text-xs text-ink-muted">
            Assignee, priority and side apply when you accept. Leave them as they are to keep each
            task’s own values.
          </p>

          {dropping && (
            <div className="mt-3 rounded-lg border border-critical/40 p-3">
              <label htmlFor="triage-reason" className="block text-sm font-medium">
                Why drop {ids.length === 1 ? 'this task' : `these ${ids.length} tasks`}?
              </label>
              <textarea
                id="triage-reason"
                rows={2}
                dir="auto"
                maxLength={2000}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                className={`${smallInputClass} mt-1.5`}
              />
              <div className="mt-2 flex justify-end gap-2">
                <button type="button" onClick={() => setDropping(false)} className={secondaryButton}>
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={busy || !reason.trim()}
                  onClick={() => send('dropped')}
                  className={dangerButton}
                >
                  Drop {ids.length === 1 ? 'task' : `${ids.length} tasks`}
                </button>
              </div>
            </div>
          )}
        </>
      )}

      {error && (
        <p role="alert" dir="auto" className="mt-3 text-sm text-critical">
          {error}
        </p>
      )}

      {results && (
        <div className="mt-3" role="status">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-secondary">
              Last triage: {results.filter((r) => r.ok).length} of {results.length} done
            </h3>
            <button type="button" onClick={() => setResults(null)} className="text-xs text-ink-secondary underline-offset-2 hover:text-ink hover:underline">
              Hide
            </button>
          </div>
          <ul className="mt-1.5 space-y-1 text-sm">
            {results.map((r) => (
              <li key={r.id} className="flex flex-wrap items-baseline gap-2">
                <span className={r.ok ? 'text-good' : 'text-critical'} aria-hidden="true">
                  {r.ok ? '✓' : '✕'}
                </span>
                <span className="tabular text-xs text-ink-muted">#{r.id}</span>
                {r.title && (
                  <span dir="auto" className="min-w-0 truncate">{r.title}</span>
                )}
                <span dir="auto" className={`text-xs ${r.ok ? 'text-ink-secondary' : 'text-critical'}`}>
                  {r.ok ? `now ${STATUS_LABELS[r.status] ?? r.status}` : r.error}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}
