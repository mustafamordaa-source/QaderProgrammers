import { useCallback, useEffect, useState } from 'react'
import { api } from '../api/client'
import { useAuth } from '../auth/AuthContext'
import UserFormModal from '../components/users/UserFormModal'
import PasswordResetModal from '../components/users/PasswordResetModal'
import DeactivateModal from '../components/users/DeactivateModal'
import { formatDate, initials } from '../lib/format'

function RoleBadge({ role }) {
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${
        role === 'leader' ? 'border-series1/40 text-series1' : 'border-hairline text-ink-secondary'
      }`}
    >
      {role === 'leader' ? 'Leader' : 'Programmer'}
    </span>
  )
}

function StatusBadge({ active }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 text-[12px] ${
        active ? 'text-ink-secondary' : 'text-ink-muted'
      }`}
    >
      <span
        aria-hidden="true"
        className={`h-1.5 w-1.5 rounded-full ${active ? 'bg-good' : 'bg-baseline'}`}
      />
      {active ? 'Active' : 'Deactivated'}
    </span>
  )
}

const actionClass =
  'rounded-md border border-hairline px-2.5 py-1 text-[11px] text-ink-secondary transition hover:text-ink'

export default function UsersPage() {
  const { user: currentUser, logout } = useAuth()
  const [users, setUsers] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState(null)
  const [resetting, setResetting] = useState(null)
  const [deactivating, setDeactivating] = useState(null)

  const load = useCallback(async () => {
    try {
      setUsers(await api.adminUsers())
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

  function replace(updated) {
    setUsers((current) => current.map((row) => (row.id === updated.id ? updated : row)))
  }

  async function handleCreate(payload) {
    await api.createUser(payload)
    await load()
  }

  async function handleEdit(payload) {
    replace(await api.updateUser(editing.id, payload))
  }

  async function handleReset(password) {
    await api.resetPassword(resetting.id, password)
  }

  async function setActive(row, isActive) {
    const updated = await api.updateUser(row.id, { is_active: isActive })
    replace(updated)
    // Deactivating yourself revokes the token you are holding; every following
    // request would 403, so leave cleanly instead.
    if (!isActive && row.id === currentUser.id) logout()
  }

  const activeCount = users.filter((row) => row.is_active).length

  return (
    <>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">People</h1>
          <p className="mt-0.5 text-sm text-ink-secondary">
            {activeCount} active {activeCount === 1 ? 'account' : 'accounts'} of {users.length}.
            Accounts are deactivated, never deleted, so task history stays intact.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="rounded-lg bg-series1 px-4 py-2 text-sm font-medium text-white transition hover:opacity-90"
        >
          Add person
        </button>
      </div>

      {error && (
        <p
          role="alert"
          className="mb-4 rounded-lg border border-critical/40 px-3 py-2 text-sm text-critical"
        >
          {error}
        </p>
      )}

      {loading ? (
        <p className="text-sm text-ink-muted">Loading people…</p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-hairline bg-surface">
          <table className="w-full min-w-[720px] text-sm">
            <thead>
              <tr className="border-b border-hairline text-left">
                {['Name', 'Role', 'Status', 'Open tasks', 'Added', ''].map((column) => (
                  <th
                    key={column}
                    className="px-4 py-2.5 text-xs font-medium uppercase tracking-wide text-ink-secondary"
                  >
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {users.map((row) => {
                const isSelf = row.id === currentUser.id
                return (
                  <tr
                    key={row.id}
                    className={`border-b border-hairline/60 last:border-0 ${
                      row.is_active ? '' : 'opacity-60'
                    }`}
                  >
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2.5">
                        <span
                          aria-hidden="true"
                          className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-surface-raised text-[10px] font-semibold text-ink-secondary"
                        >
                          {initials(row.name)}
                        </span>
                        <div className="min-w-0">
                          <div className="font-medium leading-tight">
                            {row.name}
                            {isSelf && (
                              <span className="ml-1.5 text-[11px] font-normal text-ink-muted">
                                (you)
                              </span>
                            )}
                          </div>
                          <div className="truncate text-xs leading-tight text-ink-muted">
                            {row.email}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <RoleBadge role={row.role} />
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge active={row.is_active} />
                    </td>
                    <td className="tabular px-4 py-3 text-ink-secondary">
                      {row.open_task_count}
                    </td>
                    <td className="px-4 py-3 text-xs text-ink-muted">
                      {formatDate(row.created_at)}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap justify-end gap-1.5">
                        <button type="button" className={actionClass} onClick={() => setEditing(row)}>
                          Edit
                        </button>
                        <button
                          type="button"
                          className={actionClass}
                          onClick={() => setResetting(row)}
                        >
                          Reset password
                        </button>
                        {row.is_active ? (
                          <button
                            type="button"
                            onClick={() => setDeactivating(row)}
                            className="rounded-md border border-critical/40 px-2.5 py-1 text-[11px] text-critical transition hover:bg-critical/5"
                          >
                            Deactivate
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={() =>
                              setActive(row, true).catch((err) => setError(err.message))
                            }
                            className={actionClass}
                          >
                            Reactivate
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {creating && (
        <UserFormModal onClose={() => setCreating(false)} onSubmit={handleCreate} />
      )}
      {editing && (
        <UserFormModal user={editing} onClose={() => setEditing(null)} onSubmit={handleEdit} />
      )}
      {resetting && (
        <PasswordResetModal
          user={resetting}
          onClose={() => setResetting(null)}
          onSubmit={handleReset}
        />
      )}
      {deactivating && (
        <DeactivateModal
          user={deactivating}
          isSelf={deactivating.id === currentUser.id}
          onClose={() => setDeactivating(null)}
          onConfirm={() => setActive(deactivating, false)}
        />
      )}
    </>
  )
}
