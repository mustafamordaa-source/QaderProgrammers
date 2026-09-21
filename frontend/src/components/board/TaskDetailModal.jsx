import { useState } from 'react'
import Modal from '../Modal'
import { OverdueBadge, PointsBadge, PriorityBadge, StatusBadge } from '../Badges'
import {
  EVENT_LABELS,
  STATUS_LABELS,
  STATUS_SHORT_LABELS,
  allowedTargets,
} from '../../lib/constants'
import PointsPicker from './PointsPicker'
import { formatDate, formatDateTime, isOverdue } from '../../lib/format'

function AuditTrail({ events }) {
  if (!events?.length) return <p className="text-sm text-ink-muted">No activity yet.</p>

  return (
    <ol className="space-y-3">
      {events.map((event) => (
        <li key={event.id} className="flex gap-3 text-sm">
          <span
            aria-hidden="true"
            className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${
              event.event_type === 'rejected'
                ? 'bg-critical'
                : event.event_type === 'approved'
                  ? 'bg-good'
                  : 'bg-baseline'
            }`}
          />
          <div className="min-w-0 flex-1">
            <p className="leading-snug">
              <span className="font-medium">{event.actor?.name ?? `User ${event.actor_id}`}</span>{' '}
              <span className="text-ink-secondary">{EVENT_LABELS[event.event_type] ?? event.event_type}</span>
              {event.to_status && event.from_status !== event.to_status && (
                <>
                  {' '}
                  <span className="text-ink-secondary">to</span>{' '}
                  <span className="font-medium">{STATUS_LABELS[event.to_status]}</span>
                </>
              )}
            </p>
            {event.comment && (
              <p className="mt-1 rounded-md border border-hairline bg-surface-raised px-2.5 py-1.5 text-[13px] text-ink-secondary">
                {event.comment}
              </p>
            )}
            <time className="mt-0.5 block text-xs text-ink-muted">
              {formatDateTime(event.timestamp)}
            </time>
          </div>
        </li>
      ))}
    </ol>
  )
}

export default function TaskDetailModal({ task, role, onClose, onMove, onReject, onReestimate }) {
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const [rejectTarget, setRejectTarget] = useState(null)
  const [comment, setComment] = useState('')
  const [reestimating, setReestimating] = useState(false)

  const targets = allowedTargets(task.status, role)
  const isLeader = role === 'leader'
  const inReview = task.status === 'in_review'
  const rejectTargets = ['in_progress_front', 'in_progress_back']

  async function run(action) {
    setError(null)
    setBusy(true)
    try {
      await action()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  async function submitRejection(event) {
    event.preventDefault()
    await run(async () => {
      await onReject(task, rejectTarget, comment.trim())
      setRejectTarget(null)
      setComment('')
    })
  }

  const people = [task.assignee_1, task.assignee_2].filter(Boolean)

  return (
    <Modal title={`Task #${task.id}`} onClose={onClose} wide>
      <h3 className="text-base font-semibold leading-snug">{task.title}</h3>

      <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
        <StatusBadge status={task.status} />
        <PointsBadge points={task.points} withLabel />
        <PriorityBadge priority={task.priority} />
        {isOverdue(task.due_date, task.status) && <OverdueBadge />}
      </div>

      {task.description && (
        <p className="mt-3 whitespace-pre-wrap text-sm leading-relaxed text-ink-secondary">
          {task.description}
        </p>
      )}

      {/* Estimates are wrong sometimes; the leader can correct one without
          rebuilding the task. */}
      {isLeader && (
        <div className="mt-4">
          {reestimating ? (
            <div className="rounded-lg border border-hairline p-3">
              <PointsPicker
                value={task.points}
                onChange={(points) =>
                  run(async () => {
                    await onReestimate(task, points)
                    setReestimating(false)
                  })
                }
              />
              <button
                type="button"
                onClick={() => setReestimating(false)}
                className="mt-2 text-xs text-ink-secondary underline-offset-2 hover:underline"
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setReestimating(true)}
              className="text-xs text-ink-secondary underline-offset-2 hover:text-ink hover:underline"
            >
              Change difficulty
            </button>
          )}
        </div>
      )}

      <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-3">
        <div>
          <dt className="text-xs text-ink-muted">Assigned to</dt>
          <dd className="mt-0.5">
            {people.length ? people.map((p) => p.name).join(' + ') : 'Unassigned'}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-ink-muted">Due</dt>
          <dd className="mt-0.5">{formatDate(task.due_date)}</dd>
        </div>
        <div>
          <dt className="text-xs text-ink-muted">Created</dt>
          <dd className="mt-0.5">{formatDate(task.created_at)}</dd>
        </div>
      </dl>

      {/* Actions */}
      {(targets.length > 0 || (isLeader && inReview)) && (
        <div className="mt-5 border-t border-hairline pt-4">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-ink-secondary">
            {isLeader && inReview ? 'Review decision' : 'Move to'}
          </h4>

          <div className="mt-2.5 flex flex-wrap gap-2">
            {isLeader && inReview ? (
              <>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => run(() => onMove(task, 'done'))}
                  className="rounded-lg bg-good px-3.5 py-1.5 text-sm font-medium text-white transition hover:opacity-90 disabled:opacity-60"
                >
                  Approve &amp; close
                </button>
                {rejectTargets.map((target) => (
                  <button
                    key={target}
                    type="button"
                    disabled={busy}
                    onClick={() => setRejectTarget(target)}
                    className="rounded-lg border border-critical/50 px-3.5 py-1.5 text-sm font-medium text-critical transition hover:bg-critical/5 disabled:opacity-60"
                  >
                    Send back to {STATUS_SHORT_LABELS[target]}
                  </button>
                ))}
              </>
            ) : (
              targets.map((target) => (
                <button
                  key={target}
                  type="button"
                  disabled={busy}
                  onClick={() => run(() => onMove(task, target))}
                  className="rounded-lg border border-hairline px-3.5 py-1.5 text-sm font-medium transition hover:border-series1 hover:text-series1 disabled:opacity-60"
                >
                  {STATUS_LABELS[target]}
                </button>
              ))
            )}
          </div>

          {!isLeader && task.status === 'in_review' && (
            <p className="mt-2 text-xs text-ink-muted">
              Waiting on the team leader to approve or send this back.
            </p>
          )}

          {rejectTarget && (
            <form onSubmit={submitRejection} className="mt-4">
              <label className="block text-sm font-medium" htmlFor="reject-comment">
                Why is this going back to {STATUS_LABELS[rejectTarget]}?
              </label>
              <textarea
                id="reject-comment"
                required
                rows={3}
                autoFocus
                value={comment}
                onChange={(event) => setComment(event.target.value)}
                placeholder="Required — this is recorded in the audit trail and counts toward the rejection rate."
                className="mt-1.5 w-full rounded-lg border border-hairline bg-surface-raised px-3 py-2 text-sm outline-none focus:border-series1"
              />
              <div className="mt-2 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setRejectTarget(null)}
                  className="rounded-lg border border-hairline px-3.5 py-1.5 text-sm text-ink-secondary"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={busy || !comment.trim()}
                  className="rounded-lg bg-critical px-3.5 py-1.5 text-sm font-medium text-white transition hover:opacity-90 disabled:opacity-60"
                >
                  Send back
                </button>
              </div>
            </form>
          )}
        </div>
      )}

      {error && (
        <p role="alert" className="mt-4 text-sm text-critical">
          {error}
        </p>
      )}

      <div className="mt-5 border-t border-hairline pt-4">
        <h4 className="mb-3 text-xs font-semibold uppercase tracking-wide text-ink-secondary">
          Activity
        </h4>
        <AuditTrail events={task.events} />
      </div>
    </Modal>
  )
}
