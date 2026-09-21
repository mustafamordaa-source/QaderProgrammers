import { useState } from 'react'
import Modal from '../Modal'

/**
 * Confirmation for deactivating someone. The open-task count is the whole point
 * of the dialog: the server allows the change, so the leader needs to see what
 * they are about to strand.
 */
export default function DeactivateModal({ user, isSelf, onClose, onConfirm }) {
  const [error, setError] = useState(null)
  const [saving, setSaving] = useState(false)
  const openTasks = user.open_task_count ?? 0

  async function confirm() {
    setError(null)
    setSaving(true)
    try {
      await onConfirm()
      onClose()
    } catch (err) {
      setError(err.message)
      setSaving(false)
    }
  }

  return (
    <Modal title={`Deactivate ${user.name}?`} onClose={onClose}>
      <p className="text-sm leading-relaxed text-ink-secondary">
        They will be signed out immediately and will not be able to log back in. Their
        past work, task history and metrics stay exactly as they are — accounts are
        deactivated, never deleted.
      </p>

      {openTasks > 0 && (
        <div className="mt-4 rounded-lg border border-warning/40 bg-warning/5 px-3 py-2.5">
          <p className="text-sm font-medium text-ink">
            They still hold {openTasks} open task{openTasks === 1 ? '' : 's'}.
          </p>
          <p className="mt-1 text-xs leading-relaxed text-ink-secondary">
            Those stay assigned to them and will sit in a queue nobody can act on.
            Reassign them from the board first if the work needs to continue.
          </p>
        </div>
      )}

      {isSelf && (
        <div className="mt-4 rounded-lg border border-critical/40 bg-critical/5 px-3 py-2.5">
          <p className="text-sm font-medium text-critical">This is your own account.</p>
          <p className="mt-1 text-xs leading-relaxed text-ink-secondary">
            You will be signed out and will need another leader to let you back in.
          </p>
        </div>
      )}

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
          type="button"
          onClick={confirm}
          disabled={saving}
          className="rounded-lg bg-critical px-4 py-2 text-sm font-medium text-white transition hover:opacity-90 disabled:opacity-60"
        >
          {saving ? 'Deactivating…' : 'Deactivate'}
        </button>
      </div>
    </Modal>
  )
}
