import { useState } from 'react'
import Modal from '../Modal'
import { MIN_PASSWORD_LENGTH } from './UserFormModal'

export default function PasswordResetModal({ user, onClose, onSubmit }) {
  const [password, setPassword] = useState('')
  const [error, setError] = useState(null)
  const [saving, setSaving] = useState(false)

  async function handleSubmit(event) {
    event.preventDefault()
    setError(null)
    setSaving(true)
    try {
      await onSubmit(password)
      onClose()
    } catch (err) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal title={`Reset password for ${user.name}`} onClose={onClose}>
      <form onSubmit={handleSubmit}>
        <label className="block text-sm font-medium" htmlFor="new-password">
          New password
        </label>
        <input
          id="new-password"
          type="text"
          required
          autoFocus
          minLength={MIN_PASSWORD_LENGTH}
          autoComplete="new-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          className="mt-1.5 w-full rounded-lg border border-hairline bg-surface-raised px-3 py-2 text-sm outline-none focus:border-series1"
        />
        <p className="mt-1.5 text-xs text-ink-muted">
          At least {MIN_PASSWORD_LENGTH} characters. Their old password stops working
          immediately, so pass this on before you close the dialog.
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
            {saving ? 'Resetting…' : 'Reset password'}
          </button>
        </div>
      </form>
    </Modal>
  )
}
