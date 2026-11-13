import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../../api/client'
import { useAuth } from '../../auth/AuthContext'

const POLL_MS = 30_000

const NotificationsContext = createContext(null)

/**
 * The unread count behind the header bell. Polls every 30 s while someone is
 * signed in and the tab is visible, and again when the window regains focus.
 * Pages that mark notifications read call `refresh` so the bell follows.
 */
export function NotificationsProvider({ children }) {
  const { user } = useAuth()
  const [unread, setUnread] = useState(0)
  const signedIn = Boolean(user)
  const latest = useRef(0)

  const refresh = useCallback(async () => {
    if (!signedIn) return
    const id = ++latest.current
    try {
      const { unread: count } = await api.notificationCount()
      if (id === latest.current) setUnread(count ?? 0)
    } catch {
      // Keep the last count; the next poll tries again.
    }
  }, [signedIn])

  useEffect(() => {
    if (!signedIn) {
      setUnread(0)
      return undefined
    }
    refresh()
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') refresh()
    }, POLL_MS)
    function onFocus() {
      refresh()
    }
    function onVisible() {
      if (document.visibilityState === 'visible') refresh()
    }
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(timer)
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onVisible)
      // Drop any answer still in flight.
      latest.current += 1
    }
  }, [signedIn, refresh])

  const value = useMemo(() => ({ unread, setUnread, refresh }), [unread, refresh])
  return <NotificationsContext.Provider value={value}>{children}</NotificationsContext.Provider>
}

export function useNotifications() {
  const context = useContext(NotificationsContext)
  if (!context) throw new Error('useNotifications must be used inside a NotificationsProvider')
  return context
}
