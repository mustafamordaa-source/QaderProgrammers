import { useState } from 'react'
import Modal from '../Modal'

const inputClass =
  'mt-1.5 w-full rounded-lg border border-hairline bg-surface-raised px-3 py-2 text-sm outline-none focus:border-series1'

export const MIN_PASSWORD_LENGTH = 8

/** Create or edit a person. On edit the password is left alone — resetting it
 *  is a separate, deliberate action. */
export default function UserFormModal({ user, onClose, onSubmit }) {
  const editing = Boolean(user)
  const [form, setForm] = useState({
    name: user?.name ?? '',
    email: user?.email ?? '',
    password: '',
    role: user?.role ?? 'programmer',
  })
  const [error, setError] = useState(null)
  const [saving, setSaving] = useState(false)

  function update(field, value) {
    setForm((current) => ({ ...current, [field]: value }))
  }

  async function handleSubmit(event) {
    event.preventDefault()
    setError(null)
    setSaving(true)
    try {
      await onSubmit(
        editing
          ? { name: form.name.trim(), email: form.email.trim(), role: form.role }
          : {
              name: form.name.trim(),
              email: form.email.trim(),
              password: form.password,
              role: form.role,
            },
      )
      onClose()
    } catch (err) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal title={editing ? `Edit ${user.name}` : 'Add a person'} onClose={onClose}>
      <form onSubmit={handleSubmit}>
        <label className="block text-sm font-medium" htmlFor="user-name">
          Name
        </label>
        <input
          id="user-name"
          required
          maxLength={120}
          value={form.name}
          onChange={(event) => update('name', event.target.value)}
          className={inputClass}
        />

        <label className="mt-4 block text-sm font-medium" htmlFor="user-email">
          Email
        </label>
        <input
          id="user-email"
          type="email"
          required
          autoComplete="off"
          value={form.email}
          onChange={(event) => update('email', event.target.value)}
          className={inputClass}
        />

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

        <label className="mt-4 block text-sm font-medium" htmlFor="user-role">
          Role
        </label>
        <select
          id="user-role"
          value={form.role}
          onChange={(event) => update('role', event.target.value)}
          className={inputClass}
        >
          <option value="programmer">Programmer</option>
          <option value="leader">Leader</option>
        </select>
        <p className="mt-1.5 text-xs text-ink-muted">
          Leaders can approve work out of review and manage people. Programmers see only
          their own tasks and metrics.
        </p>

        {error && (
          <p role="alert" className="mt-4 text-sm text-critical">
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
