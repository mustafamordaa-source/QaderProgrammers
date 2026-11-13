import { useState } from 'react'
import Modal from '../Modal'
import {
  ACCESS_ROLES,
  PERSON_SIDES,
  ROLE_HINTS,
  ROLE_LABELS,
  SIDES,
  SIDE_LABELS,
  isBot,
  rolesOf,
} from '../../lib/constants'

const inputClass =
  'mt-1.5 w-full rounded-lg border border-hairline bg-surface-raised px-3 py-2 text-sm outline-none focus:border-series1'

export const MIN_PASSWORD_LENGTH = 8

const ACCOUNT_TYPES = [
  ['person', 'Person'],
  ['bot', 'Bot'],
]

/** Create or edit a person or a bot account. On edit the password is left
 *  alone; resetting it is a separate, deliberate action. The server fixes a
 *  bot's roles, so the form neither shows nor sends them for a bot. */
export default function UserFormModal({ user, onClose, onSubmit }) {
  const editing = Boolean(user)
  const [form, setForm] = useState({
    name: user?.name ?? '',
    email: user?.email ?? '',
    password: '',
    account_type: user?.account_type ?? 'person',
    roles: user ? rolesOf(user) : ['member'],
    handle: user?.handle ?? '',
    github_login: user?.github_login ?? '',
    sides: user?.sides ?? [],
    wip_limit: user?.wip_limit ?? 2,
  })
  const [error, setError] = useState(null)
  const [saving, setSaving] = useState(false)
  const bot = editing ? isBot(user) : form.account_type === 'bot'
  // Keep a side the account already holds even if the picker no longer offers it.
  const sideChoices = [...PERSON_SIDES, ...form.sides.filter((s) => !PERSON_SIDES.includes(s))]

  const pickedRoles = ACCESS_ROLES.filter((role) => form.roles.includes(role))
  const viewerIgnored = pickedRoles.includes('viewer') && pickedRoles.length > 1

  function update(field, value) {
    setForm((current) => ({ ...current, [field]: value }))
  }

  function toggle(field, value) {
    setForm((current) => ({
      ...current,
      [field]: current[field].includes(value)
        ? current[field].filter((v) => v !== value)
        : [...current[field], value],
    }))
  }

  async function handleSubmit(event) {
    event.preventDefault()
    if (!bot && pickedRoles.length === 0) {
      setError('Pick at least one role.')
      return
    }
    setError(null)
    setSaving(true)
    const payload = {
      name: form.name.trim(),
      email: form.email.trim(),
      handle: form.handle.trim().toLowerCase() || null,
      github_login: form.github_login.trim() || null,
      sides: SIDES.filter((side) => form.sides.includes(side)),
      wip_limit: Number(form.wip_limit) || 2,
    }
    if (!bot) payload.roles = pickedRoles
    if (!editing) {
      payload.account_type = form.account_type
      if (!bot) payload.password = form.password
    }
    try {
      await onSubmit(payload)
      onClose()
    } catch (err) {
      // Includes the server's 409 when the change would leave no admin.
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  const title = editing ? `Edit ${user.name}` : bot ? 'Add a bot account' : 'Add a person'

  return (
    <Modal title={title} onClose={onClose} wide>
      <form onSubmit={handleSubmit}>
        {!editing && (
          <fieldset className="mb-4">
            <legend className="text-sm font-medium">Account type</legend>
            <div className="mt-1.5 flex gap-1.5">
              {ACCOUNT_TYPES.map(([value, label]) => (
                <label
                  key={value}
                  className={`flex-1 cursor-pointer rounded-lg border px-3 py-2 text-sm transition ${
                    form.account_type === value
                      ? 'border-series1 bg-series1/5 text-series1'
                      : 'border-hairline text-ink-secondary hover:text-ink'
                  }`}
                >
                  <input
                    type="radio"
                    name="account_type"
                    value={value}
                    checked={form.account_type === value}
                    onChange={() => update('account_type', value)}
                    className="sr-only"
                  />
                  {label}
                </label>
              ))}
            </div>
            {bot && (
              <p className="mt-1.5 text-xs text-ink-muted">
                A bot is a service account for an automated agent. It has no password and never
                signs in; you issue its tokens from its row. It reads tasks, files proposals for
                triage and comments on its own proposals.
              </p>
            )}
          </fieldset>
        )}
        {editing && bot && (
          <p className="mb-4 rounded-lg border border-series2/40 bg-series2/5 px-3 py-2 text-sm text-ink-secondary">
            Bot account. The server fixes its role (Member), and it signs in with tokens only.
          </p>
        )}

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

        {!editing && !bot && (
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
              it on. You can reset it later from their row.
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
              placeholder={bot ? 'scanner' : 'sara'}
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
          <legend className="text-sm font-medium">Works on</legend>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {sideChoices.map((side) => {
              const on = form.sides.includes(side)
              return (
                <button
                  key={side}
                  type="button"
                  aria-pressed={on}
                  onClick={() => toggle('sides', side)}
                  className={`rounded-lg border px-3 py-1.5 text-sm transition ${
                    on
                      ? 'border-series1 bg-series1/5 text-series1'
                      : 'border-hairline text-ink-secondary hover:text-ink'
                  }`}
                >
                  {SIDE_LABELS[side] ?? side}
                </button>
              )
            })}
          </div>
          <p className="mt-1.5 text-xs text-ink-muted">
            The kinds of work this account picks up. Pick as many as apply.
          </p>
        </fieldset>

        {!bot && (
          <fieldset className="mt-4">
            <legend className="text-sm font-medium">Roles</legend>
            <div className="mt-1.5 grid gap-2 sm:grid-cols-2">
              {ACCESS_ROLES.map((role) => (
                <label
                  key={role}
                  className="flex items-start gap-2 rounded-lg border border-hairline px-3 py-2 text-sm"
                >
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={form.roles.includes(role)}
                    onChange={() => toggle('roles', role)}
                  />
                  <span>
                    <span className="font-medium">{ROLE_LABELS[role]}</span>
                    <span className="block text-xs text-ink-muted">{ROLE_HINTS[role]}</span>
                  </span>
                </label>
              ))}
            </div>
            <p className="mt-1.5 text-xs text-ink-muted">
              Rights add up. Admin includes lead rights. Only members can be assigned tasks.
              {viewerIgnored && ' Viewer is ignored next to the other roles you picked.'}
            </p>
          </fieldset>
        )}

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
            {saving ? 'Saving…' : editing ? 'Save changes' : bot ? 'Add bot' : 'Add person'}
          </button>
        </div>
      </form>
    </Modal>
  )
}
