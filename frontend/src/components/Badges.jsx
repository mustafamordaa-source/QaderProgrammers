import { POINT_LABELS, PRIORITY_LABELS, STATUS_LABELS } from '../lib/constants'

// Priority uses the reserved status palette. Each badge carries its label, so
// meaning never rests on colour alone.
const PRIORITY_STYLES = {
  low: 'border-hairline text-ink-secondary',
  medium: 'border-hairline text-ink-secondary',
  high: 'border-serious/40 text-serious',
  urgent: 'border-critical/40 text-critical',
}

export function PriorityBadge({ priority }) {
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${
        PRIORITY_STYLES[priority] ?? PRIORITY_STYLES.medium
      }`}
    >
      {PRIORITY_LABELS[priority] ?? priority}
    </span>
  )
}

export function StatusBadge({ status }) {
  return (
    <span className="inline-flex items-center rounded-full border border-hairline bg-surface-raised px-2 py-0.5 text-[11px] font-medium text-ink-secondary">
      {STATUS_LABELS[status] ?? status}
    </span>
  )
}

export function OverdueBadge() {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-critical/40 px-2 py-0.5 text-[11px] font-medium text-critical">
      <span aria-hidden="true">!</span> Overdue
    </span>
  )
}

/** Difficulty. The number carries the meaning; the label is in the tooltip and
 *  spelled out in full wherever there is room. */
export function PointsBadge({ points, withLabel = false }) {
  return (
    <span
      title={`${POINT_LABELS[points] ?? 'Unrated'} — ${points} point${points === 1 ? '' : 's'}`}
      className="inline-flex items-center gap-1 rounded-full border border-hairline bg-surface-raised px-2 py-0.5 text-[11px] font-medium text-ink-secondary"
    >
      <span className="tabular">{points}</span>
      <span className="text-ink-muted">{withLabel ? POINT_LABELS[points] : 'pts'}</span>
    </span>
  )
}
