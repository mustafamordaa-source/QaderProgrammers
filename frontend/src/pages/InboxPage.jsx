import { useCallback, useEffect, useState } from 'react'
import { api } from '../api/client'
import { useAuth } from '../auth/AuthContext'
import TaskDetailModal from '../components/board/TaskDetailModal'
import { PlainText } from '../components/Badges'
import { INBOX_REASON_LABELS } from '../lib/constants'
import { formatDateTime } from '../lib/format'

const REASON_STYLES = {
  question: 'border-warning/50 text-warning',
  blocked: 'border-critical/40 text-critical',
  needs_confirm: 'border-warning/50 text-warning',
  review: 'border-series3/40 text-series3',
  triage: 'border-series2/40 text-series2',
}

export default function InboxPage() {
  const { user } = useAuth()
  const [items, setItems] = useState([])
  const [people, setPeople] = useState([])
  const [selected, setSelected] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const load = useCallback(async () => {
    try {
      setItems(await api.inbox())
      setError(null)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  useEffect(() => {
    api.directory().then(setPeople).catch(() => setPeople([]))
  }, [])

  async function open(item) {
    setError(null)
    try {
      setSelected(await api.task(item.task_id))
    } catch (err) {
      setError(err.message)
    }
  }

  function handleChanged(updated) {
    setSelected(updated)
    load()
  }

  return (
    <>
      <div className="mb-5">
        <h1 className="text-xl font-semibold tracking-tight">Inbox</h1>
        <p className="mt-0.5 text-sm text-ink-secondary">
          What waits on you: questions addressed to you, your parked tasks
          {user.role === 'leader' ? ', and the review and triage queues.' : '.'}
        </p>
      </div>

      {error && (
        <p role="alert" dir="auto" className="mb-4 rounded-lg border border-critical/40 px-3 py-2 text-sm text-critical">
          {error}
        </p>
      )}

      {loading ? (
        <p className="text-sm text-ink-muted">Loading inbox…</p>
      ) : items.length === 0 ? (
        <div className="rounded-xl border border-dashed border-hairline px-6 py-12 text-center">
          <p className="text-sm font-medium">Nothing waits on you.</p>
        </div>
      ) : (
        <ul className="divide-y divide-hairline overflow-hidden rounded-xl border border-hairline bg-surface">
          {items.map((item, index) => (
            <li key={`${item.reason}-${item.task_id}-${item.comment_id ?? index}`}>
              <button
                type="button"
                onClick={() => open(item)}
                className="block w-full px-4 py-3 text-left transition hover:bg-surface-raised"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${
                      REASON_STYLES[item.reason] ?? 'border-hairline text-ink-secondary'
                    }`}
                  >
                    {INBOX_REASON_LABELS[item.reason] ?? item.reason}
                  </span>
                  <span className="tabular text-xs text-ink-muted">#{item.task_id}</span>
                  <span dir="auto" className="min-w-0 flex-1 break-words text-sm font-medium">
                    {item.task_title}
                  </span>
                  <time className="text-xs text-ink-muted">{formatDateTime(item.at)}</time>
                </div>
                {item.text && (
                  <PlainText className="mt-1.5 line-clamp-3 text-sm text-ink-secondary">{item.text}</PlainText>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}

      {selected && (
        <TaskDetailModal
          task={selected}
          user={user}
          people={people}
          onClose={() => setSelected(null)}
          onChanged={handleChanged}
        />
      )}
    </>
  )
}
