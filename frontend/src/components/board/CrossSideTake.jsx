import { useState } from 'react'
import { createPortal } from 'react-dom'
import Modal from '../Modal'
import { primaryButton, secondaryButton, smallInputClass } from './detail/ui'

export const CROSS_SIDE_MIN = 10
export const CROSS_SIDE_MAX = 500

/** Does the side rule alone stop the viewer, so a reason would let them claim it? */
export function crossSideOpen(task) {
  return task?.claim_block === 'other_side' && task?.cross_side_ok === true
}

// Keep clicks, keys and drags inside the dialog from reaching a card that opens or drags on them.
const stop = (event) => event.stopPropagation()

/**
 * "Take across sides": a small secondary action that asks why the work is safe
 * for you, then calls `onSubmit(reason)`. A refusal shows in the dialog; on
 * success the dialog closes and the caller refreshes the task.
 */
export default function CrossSideTake({ onSubmit, label = 'Take across sides', title, className, disabled = false }) {
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState(null)
  const length = reason.trim().length
  const valid = length >= CROSS_SIDE_MIN && length <= CROSS_SIDE_MAX

  function close() {
    if (sending) return
    setOpen(false)
    setError(null)
  }

  async function submit(event) {
    event.preventDefault()
    if (!valid) return
    setError(null)
    setSending(true)
    try {
      await onSubmit(reason.trim())
      setSending(false)
      setOpen(false)
      setReason('')
    } catch (err) {
      setError(err?.message || 'The hub refused the claim.')
      setSending(false)
    }
  }

  return (
    <>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen(true)}
        title={title ?? 'This is the other side’s work. You may take a simple, low-risk change you can test, with a reason.'}
        className={className ?? secondaryButton}
      >
        {label}
      </button>
      {open &&
        createPortal(
          <div onClick={stop} onKeyDown={stop} onMouseDown={stop} onDragStart={stop}>
            <Modal title="Take across sides" onClose={close}>
              <form onSubmit={submit} className="space-y-3">
                <p className="text-sm text-ink-secondary">
                  This is the other side’s work. Take it only when the change is simple and you can test it; risky work
                  stays with its side. The hub posts your reason as a note and tells the people on the task.
                </p>
                <label htmlFor="cross-side-reason" className="block text-xs font-medium">
                  Why is it safe for you to do this? (simple change, you can test it)
                </label>
                <textarea
                  id="cross-side-reason"
                  rows={3}
                  dir="auto"
                  autoFocus
                  maxLength={CROSS_SIDE_MAX}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  className={smallInputClass}
                />
                <p className={`tabular text-xs ${length > 0 && !valid ? 'text-serious' : 'text-ink-muted'}`}>
                  {length < CROSS_SIDE_MIN
                    ? `${CROSS_SIDE_MIN} to ${CROSS_SIDE_MAX} characters (${length} so far).`
                    : `${length} of ${CROSS_SIDE_MAX} characters.`}
                </p>
                {error && (
                  <p role="alert" dir="auto" className="whitespace-pre-line text-xs text-critical">
                    {error}
                  </p>
                )}
                <div className="flex justify-end gap-2">
                  <button type="button" onClick={close} disabled={sending} className={secondaryButton}>
                    Cancel
                  </button>
                  <button type="submit" disabled={!valid || sending} className={primaryButton}>
                    {sending ? 'Taking…' : 'Take it'}
                  </button>
                </div>
              </form>
            </Modal>
          </div>,
          document.body,
        )}
    </>
  )
}
