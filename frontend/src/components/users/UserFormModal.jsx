import { useState } from 'react'
import Modal from '../Modal'
import { ROLES, ROLE_LABELS, SIDES, SIDE_LABELS } from '../../lib/constants'

const inputClass =
  'mt-1.5 w-full rounded-lg border border-hairline bg-surface-raised px-3 py-2 text-sm outline-none focus:border-series1'

export const MIN_PASSWORD_LENGTH = 8

const ROLE_HINTS = {
  programmer:
    'Members read the team’s tasks, create tasks into the backlog and work on tasks assigned to them or pool tasks they claim.',
  leader: 'Leaders triage, assign, approve and drop work, and manage people.',
  viewer: 'Viewers read the board and nothing else. Good for a manager who follows along.',
}

/** Create or edit a person. On edit the password is left alone — resetting it
 *  is a separate, deliberate action. */
export default function UserFormModal({ user, onClose, onSubmit }) {
  const editing = Boolean(user)
  const [form, setForm] = useState({
    name: user?.name ?? '',
    email: user?.email ?? '',
    password: '',
    role: user?.role ?? 'programmer',
    handle: user?.handle ?? '',
    github_login: user?.github_login ?? '',
    sides: user?.sides ?? [],
    wip_limit: user?.wip_limit ?? 2,
  })
  const [error, setError] = useState(null)
  const [saving, setSaving] = useState(false)

  function update(field, value) {
    setForm((current) => ({ ...current, [field]: value }))
  }

  function toggleSide(side) {
    setForm((current) => ({
      ...current,
      sides: current.sides.includes(side)
        ? current.sides.filter((s) => s !== side)
        : [...current.sides, side],
    }))
  }

  async function handleSubmit(event) {
    event.preventDefault()
    setError(null)
    setSaving(true)
    const profile = {
      name: form.name.trim(),
      email: form.email.trim(),
      role: form.role,
      handle: form.handle.trim().toLowerCase() || null,
      github_login: form.github_login.trim() || null,
      sides: SIDES.filter((side) => form.sides.includes(side)),
      wip_limit: Number(form.wip_limit) || 2,
    }
    try {
      await onSubmit(editing ? profile : { ...profile, password: form.password })
      onClose()
    } catch (err) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal title={editing ? `Edit ${user.name}` : 'Add a person'} onClose={onClose} wide>
      <form onSubmit={handleSubmit}>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="block text-sm font-medium" htmlFor="user-name">
              Name
            </label>
            <input
              id="user-name"
              required
              maxLength={120}
              dir="auto"
              value={form.name}
              onChange={(event) => update('name', event.target.value)}
              className={inputClass}
            />
          </div>
          <div>
            <label className="block text-sm font-medium" htmlFor="user-email">
              Email
            </label>
            <input
              id="user-email"
              type="email"
              required
              autoComplete="off"
              dir="ltr"
              value={form.email}
              onChange={(event) => update('email', event.target.value)}
              className={inputClass}
            />
          </div>
        </div>

        {!editing && (
          <>
            <label className="mt-4 block text-sm font-medium" htmlFor="user-password">
              Initial password
            </label>
            <input
              id="user-password"
              type="text"
              required
              minLength={MIN_PASSWORD_LENGTH}
              autoComplete="new-password"
              dir="ltr"
              value={form.password}
              onChange={(event) => update('password', event.target.value)}
              className={inputClass}
            />
            <p className="mt-1.5 text-xs text-ink-muted">
              At least {MIN_PASSWORD_LENGTH} characters. Shown in the clear so you can pass
              it on — you can reset it later from their row.
            </p>
          </>
        )}

        <div className="mt-4 grid gap-4 sm:grid-cols-3">
          <div>
            <label className="block text-sm font-medium" htmlFor="user-handle">
              Handle
            </label>
            <input
              id="user-handle"
              dir="ltr"
              maxLength={40}
              pattern="[a-z0-9][a-z0-9_\-]{1,39}"
              title="2 to 40 characters: lowercase letters, digits, - or _"
              placeholder="sara"
              value={form.handle}
              onChange={(event) => update('handle', event.target.value.toLowerCase())}
              className={inputClass}
            />
          </div>
          <div>
            <label className="block text-sm font-medium" htmlFor="user-github">
              GitHub login
            </label>
            <input
              id="user-github"
              dir="ltr"
              maxLength={80}
              value={form.github_login}
              onChange={(event) => update('github_login', event.target.value)}
              className={inputClass}
            />
          </div>
          <div>
            <label className="block text-sm font-medium" htmlFor="user-wip">
              WIP limit
            </label>
            <input
              id="user-wip"
              type="number"
              min={1}
              max={10}
              value={form.wip_limit}
              onChange={(event) => update('wip_limit', event.target.value)}
              className={inputClass}
            />
          </div>
        </div>
        <p className="mt-1.5 text-xs text-ink-muted">
          The handle is how people and agents address questions (@sara). Claims past the WIP
          limit get a warning, not a refusal.
        </p>

        <fieldset className="mt-4">
          <legend className="text-sm font-medium">Sides</legend>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {SIDES.map((side) => {
              const on = form.sides.includes(side)
              return (
                <button
                  key={side}
                  type="button"
                  aria-pressed={on}
                  onClick={() => toggleSide(side)}
                  className={`rounded-lg border px-3 py-1.5 text-sm transition ${
                    on
                      ? 'border-series1 bg-series1/5 text-series1'
                      : 'border-hairline text-ink-secondary hover:text-ink'
                  }`}
                >
                  {SIDE_LABELS[side]}
                </button>
              )
            })}
          </div>
        </fieldset>

        <label className="mt-4 block text-sm font-medium" htmlFor="user-role">
          Role
        </label>
        <select
          id="user-role"
          value={form.role}
          onChange={(event) => update('role', event.target.value)}
          className={inputClass}
        >
          {ROLES.map((role) => (
            <option key={role} value={role}>
              {ROLE_LABELS[role]}
            </option>
          ))}
        </select>
        <p className="mt-1.5 text-xs text-ink-muted">{ROLE_HINTS[form.role]}</p>

        {error && (
          <p role="alert" dir="auto" className="mt-4 text-sm text-critical">
            {error}
          </p>
        )}

        <div className="mt-6 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-hairline px-4 py-2 text-sm text-ink-secondary transition hover:text-ink"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={saving}
            className="rounded-lg bg-series1 px-4 py-2 text-sm font-medium text-white transition hover:opacity-90 disabled:opacity-60"
          >
            {saving ? 'Saving…' : editing ? 'Save changes' : 'Add person'}
          </button>
        </div>
      </form>
    </Modal>
  )
}
