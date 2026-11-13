import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api } from '../../api/client'
import { useNotifications } from './NotificationsContext'
import NotificationItem from './NotificationItem'

const DROPDOWN_LIMIT = 20

function BellIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.6">
      <path d="M10 2.5a5 5 0 0 0-5 5v2.6c0 .6-.2 1.2-.6 1.7L3.5 13h13l-.9-1.2a2.8 2.8 0 0 1-.6-1.7V7.5a5 5 0 0 0-5-5Z" strokeLinejoin="round" />
      <path d="M8 15.5a2 2 0 0 0 4 0" strokeLinecap="round" />
    </svg>
  )
}

/** Header bell: unread count, and a dropdown of the latest notifications. */
export default function NotificationBell() {
  const { unread, setUnread, refresh } = useNotifications()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const rootRef = useRef(null)

  async function load() {
    setLoading(true)
    try {
      setItems(await api.notifications({ limit: DROPDOWN_LIMIT }))
      setError(null)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  function toggle() {
    const next = !open
    setOpen(next)
    if (next) {
      load()
      refresh()
    }
  }

  // Close on a click outside or on Escape.
  useEffect(() => {
    if (!open) return undefined
    function onPointer(event) {
      if (rootRef.current && !rootRef.current.contains(event.target)) setOpen(false)
    }
    function onKey(event) {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  async function openItem(n) {
    setOpen(false)
    if (!n.read_at) {
      setItems((current) => current.map((x) => (x.id === n.id ? { ...x, read_at: new Date().toISOString() } : x)))
      setUnread((count) => Math.max(0, count - 1))
      api.markNotificationsRead([n.id]).catch(() => {}).finally(refresh)
    }
    navigate(`/board?task=${n.task_id}`)
  }

  async function markAll() {
    setError(null)
    try {
      await api.markAllNotificationsRead()
      const now = new Date().toISOString()
      setItems((current) => current.map((x) => (x.read_at ? x : { ...x, read_at: now })))
      setUnread(0)
    } catch (err) {
      setError(err.message)
    }
  }

  const label = unread > 0 ? `Notifications, ${unread} unread` : 'Notifications'

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={toggle}
        aria-label={label}
        aria-expanded={open}
        aria-haspopup="true"
        title={label}
        className="relative grid h-8 w-8 place-items-center rounded-lg border border-hairline text-ink-secondary transition hover:text-ink"
      >
        <BellIcon />
        {unread > 0 && (
          <span className="tabular absolute -end-1.5 -top-1.5 min-w-[1.1rem] rounded-full bg-critical px-1 text-center text-[10px] font-semibold leading-[1.1rem] text-white">
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute end-0 top-full z-30 mt-2 w-[min(24rem,calc(100vw-2rem))] overflow-hidden rounded-xl border border-hairline bg-surface shadow-xl">
          <div className="flex items-center justify-between border-b border-hairline px-3 py-2">
            <span className="text-sm font-semibold">Notifications</span>
            <button
              type="button"
              onClick={markAll}
              disabled={unread === 0 && items.every((x) => x.read_at)}
              className="text-xs text-ink-secondary underline-offset-2 hover:text-ink hover:underline disabled:opacity-50 disabled:hover:no-underline"
            >
              Mark all read
            </button>
          </div>

          <div className="max-h-[60vh] overflow-y-auto">
            {error && (
              <p role="alert" dir="auto" className="px-3 py-2 text-sm text-critical">{error}</p>
            )}
            {loading && items.length === 0 ? (
              <p className="px-3 py-6 text-center text-sm text-ink-muted">Loading…</p>
            ) : items.length === 0 && !error ? (
              <p className="px-3 py-6 text-center text-sm text-ink-muted">No notifications yet.</p>
            ) : (
              <ul className="divide-y divide-hairline">
                {items.map((n) => (
                  <li key={n.id}>
                    <NotificationItem notification={n} onOpen={openItem} compact />
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="border-t border-hairline px-3 py-2 text-center">
            <Link
              to="/inbox?tab=notifications"
              onClick={() => setOpen(false)}
              className="text-xs font-medium text-series1 underline-offset-2 hover:underline"
            >
              All notifications
            </Link>
          </div>
        </div>
      )}
    </div>
  )
}
