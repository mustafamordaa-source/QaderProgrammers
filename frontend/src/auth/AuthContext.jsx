import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { api, getToken, setToken } from '../api/client'
import {
  hasAdminRights,
  hasLeadRights,
  hasMemberRights,
  isReadOnlyUser,
  rolesOf,
} from '../lib/constants'

const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null)
  const [loading, setLoading] = useState(true)

  // Restore the session from a stored token on first load.
  useEffect(() => {
    let cancelled = false
    async function restore() {
      if (!getToken()) {
        setLoading(false)
        return
      }
      try {
        const me = await api.me()
        if (!cancelled) setUser(me)
      } catch {
        // The token is expired or otherwise unusable — start clean.
        setToken(null)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    restore()
    return () => {
      cancelled = true
    }
  }, [])

  const login = useCallback(async (email, password) => {
    const result = await api.login(email, password)
    setToken(result.access_token)
    setUser(result.user)
    return result.user
  }, [])

  // Pick up changes to the signed-in person, such as roles an admin edited.
  const refreshUser = useCallback(async () => {
    setUser(await api.me())
  }, [])

  const logout = useCallback(() => {
    setToken(null)
    setUser(null)
  }, [])

  const value = useMemo(
    () => ({
      user,
      loading,
      login,
      logout,
      refreshUser,
      // Rights add up across `roles`; the old single `role` is the fallback.
      roles: rolesOf(user),
      isAdmin: hasAdminRights(user),
      isLead: hasLeadRights(user),
      isMember: hasMemberRights(user),
      isReadOnly: Boolean(user) && isReadOnlyUser(user),
    }),
    [user, loading, login, logout, refreshUser],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const context = useContext(AuthContext)
  if (!context) throw new Error('useAuth must be used inside an AuthProvider')
  return context
}
