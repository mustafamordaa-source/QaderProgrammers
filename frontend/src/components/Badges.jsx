import {
  ACTOR_KIND_LABELS,
  COMMENT_KIND_LABELS,
  COMMENT_KIND_STYLES,
  DEPLOY_LABELS,
  DEPLOY_STYLES,
  POINT_LABELS,
  PRIORITY_LABELS,
  ROLE_LABELS,
  SIDE_LABELS,
  STATUS_LABELS,
  STATUS_STYLES,
} from '../lib/constants'

const pill = 'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium'

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
    <span className={`${pill} ${PRIORITY_STYLES[priority] ?? PRIORITY_STYLES.medium}`}>
      {PRIORITY_LABELS[priority] ?? priority}
    </span>
  )
}

export function StatusBadge({ status }) {
  return (
    <span className={`${pill} bg-surface-raised ${STATUS_STYLES[status] ?? 'border-hairline text-ink-secondary'}`}>
      {STATUS_LABELS[status] ?? status}
    </span>
  )
}

export function OverdueBadge() {
  return (
    <span className={`${pill} border-critical/40 text-critical`}>
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
      className={`${pill} border-hairline bg-surface-raised text-ink-secondary`}
    >
      <span className="tabular">{points}</span>
      <span className="text-ink-muted">{withLabel ? POINT_LABELS[points] : 'pts'}</span>
    </span>
  )
}

export function SideBadge({ side }) {
  if (!side) return null
  return (
    <span className={`${pill} border-series1/30 text-ink-secondary`} title="Side">
      {SIDE_LABELS[side] ?? side}
    </span>
  )
}

/** "Agent" with the agent's name, or a plain human/system marker. */
export function ActorBadge({ kind, agent }) {
  if (kind === 'agent') {
    return (
      <span className={`${pill} border-series2/40 text-series2`} dir="auto">
        Agent{agent ? `: ${agent}` : ''}
      </span>
    )
  }
  return (
    <span className={`${pill} border-hairline text-ink-muted`}>
      {ACTOR_KIND_LABELS[kind] ?? kind}
    </span>
  )
}

export function DeployBadge({ state, hideNone = false }) {
  if (hideNone && (!state || state === 'none')) return null
  return (
    <span className={`${pill} ${DEPLOY_STYLES[state] ?? DEPLOY_STYLES.none}`}>
      {DEPLOY_LABELS[state] ?? state}
    </span>
  )
}

export function CommentKindBadge({ kind }) {
  return (
    <span className={`${pill} ${COMMENT_KIND_STYLES[kind] ?? COMMENT_KIND_STYLES.note}`}>
      {COMMENT_KIND_LABELS[kind] ?? kind}
    </span>
  )
}

export function RoleBadge({ role }) {
  const style =
    role === 'leader'
      ? 'border-series1/40 text-series1'
      : role === 'viewer'
        ? 'border-hairline text-ink-muted'
        : 'border-hairline text-ink-secondary'
  return <span className={`${pill} ${style}`}>{ROLE_LABELS[role] ?? role}</span>
}

export function TagBadge({ children }) {
  return (
    <span className={`${pill} border-hairline bg-surface-raised text-ink-secondary`} dir="auto">
      #{children}
    </span>
  )
}

/**
 * User-written text, shown as plain text. `dir="auto"` lets Arabic and English
 * each read in their own direction; whitespace is kept as typed.
 */
export function PlainText({ children, className = '', as: Tag = 'p' }) {
  if (children === null || children === undefined || children === '') return null
  return (
    <Tag dir="auto" className={`whitespace-pre-wrap break-words ${className}`}>
      {children}
    </Tag>
  )
}
