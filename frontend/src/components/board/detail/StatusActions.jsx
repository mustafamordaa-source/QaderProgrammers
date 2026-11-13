import { useState } from 'react'
import { api } from '../../../api/client'
import {
  STATUS_LABELS,
  allowedTargets,
  isParked,
  moveNeedsCriteriaMet,
} from '../../../lib/constants'
import { dangerButton, inputClass, primaryButton, secondaryButton, sectionTitle } from './ui'

// Moves that open a comment box first: required for drop and send-back,
// optional when parking a task.
function commentRule(from, to) {
  if (to === 'dropped') return 'required'
  if (from === 'in_review' && to === 'in_progress') return 'required'
  if (to === 'blocked' || to === 'needs_confirm') return 'optional'
  return null
}

function buttonLabel(task, target, isLeader) {
  if (isLeader && task.status === 'in_review') {
    if (target === 'done') return 'Approve & close'
    if (target === 'in_progress') return 'Send back to In progress'
  }
  if (target === 'dropped') return 'Drop…'
  if (isParked(task.status) && target === (task.resume_status || 'to_do')) {
    return `Resume: ${STATUS_LABELS[target]}`
  }
  return STATUS_LABELS[target] ?? target
}

function buttonClass(task, target, isLeader) {
  if (target === 'dropped') return dangerButton
  if (isLeader && task.status === 'in_review') {
    if (target === 'done') {
      return 'rounded-lg bg-good px-3.5 py-1.5 text-sm font-medium text-white transition hover:opacity-90 disabled:opacity-60'
    }
    if (target === 'in_progress') return dangerButton
  }
  return 'rounded-lg border border-hairline px-3.5 py-1.5 text-sm font-medium transition hover:border-series1 hover:text-series1 disabled:opacity-60'
}

const PROMPTS = {
  dropped: 'Why is this task being dropped?',
  in_progress: 'What needs to change before this comes back to review?',
  blocked: 'What is it blocked on? (optional)',
  needs_confirm: 'What needs confirming? (optional)',
}

export default function StatusActions({ ctx }) {
  const { task, user, isLeader, isViewer, isWorker, busy, run } = ctx
  const [pending, setPending] = useState(null)
  const [comment, setComment] = useState('')

  const targets = allowedTargets(task, user.role, isWorker)
  const criteriaOpen = task.criteria_open ?? 0

  if (targets.length === 0) {
    let hint = null
    if (isViewer) hint = 'Viewer accounts are read-only.'
    else if (task.status === 'in_review' && !isLeader) hint = 'Waiting on a leader to approve or send this back.'
    else if (task.status === 'proposed' || task.status === 'backlog') {
      hint = !isLeader ? 'A leader decides when this enters the plan.' : null
    } else if (!isWorker && !isLeader && task.status !== 'done' && task.status !== 'dropped') {
      hint = task.pool
        ? 'Claim this pool task to work on it.'
        : 'Only the people assigned to this task can move it.'
    }
    return hint ? <p className="mt-4 text-xs text-ink-muted">{hint}</p> : null
  }

  function move(target, text) {
    return run(
      () =>
        api.changeStatus(task.id, {
          status: target,
          comment: text?.trim() || null,
          expectedVersion: task.version,
        }),
    )
  }

  async function choose(target) {
    if (commentRule(task.status, target)) {
      setPending(target)
      setComment('')
      return
    }
    await move(target)
  }

  async function submit(event) {
    event.preventDefault()
    if (await move(pending, comment)) {
      setPending(null)
      setComment('')
    }
  }

  const rule = pending ? commentRule(task.status, pending) : null

  return (
    <div className="mt-4 rounded-lg border border-hairline p-3">
      <h4 className={sectionTitle}>
        {isLeader && task.status === 'in_review' ? 'Review decision' : 'Move to'}
      </h4>
      <div className="mt-2 flex flex-wrap gap-2">
        {targets.map((target) => {
          const lockedByCriteria = moveNeedsCriteriaMet(target) && criteriaOpen > 0
          return (
            <button
              key={target}
              type="button"
              disabled={busy || lockedByCriteria}
              title={lockedByCriteria ? 'Mark every criterion met or dropped first' : undefined}
              onClick={() => choose(target)}
              className={buttonClass(task, target, isLeader)}
            >
              {buttonLabel(task, target, isLeader)}
            </button>
          )
        })}
      </div>
      {criteriaOpen > 0 && targets.some(moveNeedsCriteriaMet) && (
        <p className="mt-2 text-xs text-ink-muted">
          {criteriaOpen} acceptance criteri{criteriaOpen === 1 ? 'on is' : 'a are'} still open. Mark
          each met (with evidence) or dropped before review or done.
        </p>
      )}

      {pending && (
        <form onSubmit={submit} className="mt-3">
          <label className="block text-sm font-medium" htmlFor="move-comment">
            {PROMPTS[pending] ?? `Comment for ${STATUS_LABELS[pending]}`}
          </label>
          <textarea
            id="move-comment"
            rows={3}
            dir="auto"
            autoFocus
            required={rule === 'required'}
            value={comment}
            onChange={(event) => setComment(event.target.value)}
            placeholder={
              rule === 'required' ? 'Required. This goes into the task history.' : 'Optional.'
            }
            className={inputClass}
          />
          <div className="mt-2 flex justify-end gap-2">
            <button type="button" onClick={() => setPending(null)} className={secondaryButton}>
              Cancel
            </button>
            <button
              type="submit"
              disabled={busy || (rule === 'required' && !comment.trim())}
              className={pending === 'dropped' || pending === 'in_progress' ? dangerButton : primaryButton}
            >
              {buttonLabel(task, pending, isLeader).replace('…', '')}
            </button>
          </div>
        </form>
      )}
    </div>
  )
}
