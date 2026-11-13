import { useCallback, useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { api } from '../api/client'
import { useAuth } from '../auth/AuthContext'
import TaskDetailModal from '../components/board/TaskDetailModal'
import { PlainText } from '../components/Badges'
import NotificationItem from '../components/notifications/NotificationItem'
import { useNotifications } from '../components/notifications/NotificationsContext'
import { INBOX_REASON_LABELS } from '../lib/constants'
import { formatDateTime } from '../lib/format'

const REASON_STYLES = {
  question: 'border-warning/50 text-warning',
  blocked: 'border-critical/40 text-critical',
  needs_confirm: 'border-warning/50 text-warning',
  review: 'border-series3/40 text-series3',
  triage: 'border-series2/40 text-series2',
}

const NOTIFICATION_LIMIT = 100

function tabClass(active) {
  return [
    'rounded-lg px-3 py-1.5 text-sm font-medium transition',
    active ? 'bg-surface-raised text-ink' : 'text-ink-secondary hover:text-ink',
  ].join(' ')
}

/** Everything the hub told you about, newest first. */
function NotificationsSection({ onOpenTask }) {
  const { unread, setUnread, refresh } = useNotifications()
  const [items, setItems] = useState([])
  const [unreadOnly, setUnreadOnly] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const load = useCallback(async () => {
    try {
      setItems(await api.notifications({ unread: unreadOnly, limit: NOTIFICATION_LIMIT }))
      setError(null)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [unreadOnly])

  // Reload when the filter changes and when the bell's count moves.
  useEffect(() => {
    load()
  }, [load, unread])

  function markLocal(ids) {
    const now = new Date().toISOString()
    setItems((current) =>
      current
        .map((n) => (ids.includes(n.id) && !n.read_at ? { ...n, read_at: now } : n))
        .filter((n) => !unreadOnly || !n.read_at),
    )
  }

  async function markRead(n) {
    setError(null)
    try {
      await api.markNotificationsRead([n.id])
      markLocal([n.id])
      setUnread((count) => Math.max(0, count - 1))
      refresh()
    } catch (err) {
      setError(err.message)
    }
  }

  async function markAll() {
    setError(null)
    try {
      await api.markAllNotificationsRead()
      markLocal(items.map((n) => n.id))
      setUnread(0)
    } catch (err) {
      setError(err.message)
    }
  }

  function open(n) {
    if (!n.read_at) markRead(n)
    onOpenTask(n.task_id)
  }

  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <label className="inline-flex items-center gap-2 rounded-lg border border-hairline px-3 py-1.5 text-sm">
          <input type="checkbox" checked={unreadOnly} onChange={(event) => {
              setLoading(true)
              setUnreadOnly(event.target.checked)
            }} />
          Unread only
        </label>
        <span className="text-xs text-ink-muted">{unread} unread</span>
        <button
          type="button"
          onClick={markAll}
          disabled={unread === 0}
          className="ms-auto rounded-lg border border-hairline px-3 py-1.5 text-sm text-ink-secondary transition hover:text-ink disabled:opacity-60"
        >
          Mark all read
        </button>
      </div>

      {error && (
        <p role="alert" dir="auto" className="mb-4 rounded-lg border border-critical/40 px-3 py-2 text-sm text-critical">
          {error}
        </p>
      )}

      {loading ? (
        <p className="text-sm text-ink-muted">Loading notifications…</p>
      ) : items.length === 0 ? (
        <div className="rounded-xl border border-dashed border-hairline px-6 py-12 text-center">
          <p className="text-sm font-medium">{unreadOnly ? 'No unread notifications.' : 'No notifications yet.'}</p>
          <p className="mt-1 text-sm text-ink-muted">
            You hear here when someone assigns you, asks or answers you, mentions you, or reviews your work.
          </p>
        </div>
      ) : (
        <>
          <ul className="divide-y divide-hairline overflow-hidden rounded-xl border border-hairline bg-surface">
            {items.map((n) => (
              <li key={n.id}>
                <NotificationItem notification={n} onOpen={open} onMarkRead={markRead} />
              </li>
            ))}
          </ul>
          {items.length >= NOTIFICATION_LIMIT && (
            <p className="mt-2 text-xs text-ink-muted">Showing the latest {NOTIFICATION_LIMIT}.</p>
          )}
        </>
      )}
    </>
  )
}

export default function InboxPage() {
  const { user, isLead } = useAuth()
  const { unread } = useNotifications()
  const [searchParams, setSearchParams] = useSearchParams()
  const tab = searchParams.get('tab') === 'notifications' ? 'notifications' : 'waiting'
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

  async function openTask(taskId) {
    setError(null)
    try {
      setSelected(await api.task(taskId))
    } catch (err) {
      setError(err.message)
    }
  }

  function open(item) {
    openTask(item.task_id)
  }

  function switchTab(next) {
    setSearchParams(next === 'notifications' ? { tab: 'notifications' } : {}, { replace: true })
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
          {isLead ? ', and the review and triage queues.' : '.'} Notifications list what the hub told you about.
        </p>
      </div>

      <div role="tablist" aria-label="Inbox sections" className="mb-4 flex gap-1">
        <button type="button" role="tab" aria-selected={tab === 'waiting'} onClick={() => switchTab('waiting')} className={tabClass(tab === 'waiting')}>
          Waiting on you{!loading && items.length > 0 ? ` (${items.length})` : ''}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'notifications'}
          onClick={() => switchTab('notifications')}
          className={tabClass(tab === 'notifications')}
        >
          Notifications{unread > 0 ? ` (${unread} unread)` : ''}
        </button>
      </div>

      {error && (
        <p role="alert" dir="auto" className="mb-4 rounded-lg border border-critical/40 px-3 py-2 text-sm text-critical">
          {error}
        </p>
      )}

      {tab === 'notifications' ? (
        <NotificationsSection onOpenTask={openTask} />
      ) : loading ? (
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
          key={selected.id}
          task={selected}
          user={user}
          people={people}
          onClose={() => setSelected(null)}
          onChanged={handleChanged}
          onOpenTask={(id) => openTask(id)}
        />
      )}
    </>
  )
}
