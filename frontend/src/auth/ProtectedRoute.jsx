import { Navigate, useLocation } from 'react-router-dom'
import { useAuth } from './AuthContext'

export default function ProtectedRoute({ children, leaderOnly = false }) {
  const { user, loading, isLeader } = useAuth()
  const location = useLocation()

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center text-ink-muted">
        Loading…
      </div>
    )
  }
  if (!user) return <Navigate to="/login" state={{ from: location }} replace />
  if (leaderOnly && !isLeader) return <Navigate to="/board" replace />
  return children
}
