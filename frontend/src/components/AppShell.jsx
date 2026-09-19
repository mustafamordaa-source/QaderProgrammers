import { NavLink, Outlet } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import { initials } from '../lib/format'
import ThemeToggle from './ThemeToggle'

function navClass({ isActive }) {
  return [
    'rounded-lg px-3 py-1.5 text-sm font-medium transition',
    isActive ? 'bg-surface-raised text-ink' : 'text-ink-secondary hover:text-ink',
  ].join(' ')
}

export default function AppShell() {
  const { user, logout, isLeader } = useAuth()

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-20 border-b border-hairline bg-surface/90 backdrop-blur">
        <div className="mx-auto flex max-w-[1400px] items-center gap-4 px-4 py-3 sm:px-6">
          <span className="text-base font-semibold tracking-tight">TaskFlow</span>

          <nav className="flex items-center gap-1">
            <NavLink to="/board" className={navClass}>
              Board
            </NavLink>
            <NavLink to="/kpi" className={navClass}>
              {isLeader ? 'Team KPIs' : 'My KPIs'}
            </NavLink>
          </nav>

          <div className="ml-auto flex items-center gap-3">
            <ThemeToggle />
            <div className="hidden text-right sm:block">
              <div className="text-sm font-medium leading-tight">{user?.name}</div>
              <div className="text-xs capitalize leading-tight text-ink-muted">
                {user?.role}
              </div>
            </div>
            <span
              aria-hidden="true"
              className="grid h-8 w-8 place-items-center rounded-full bg-surface-raised text-xs font-semibold text-ink-secondary"
            >
              {initials(user?.name)}
            </span>
            <button
              type="button"
              onClick={logout}
              className="rounded-lg border border-hairline px-3 py-1.5 text-sm text-ink-secondary transition hover:text-ink"
            >
              Sign out
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[1400px] px-4 py-6 sm:px-6">
        <Outlet />
      </main>
    </div>
  )
}
