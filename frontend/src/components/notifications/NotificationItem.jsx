import { NOTIFY_KIND_LABELS, NOTIFY_KIND_STYLES, NOTIFY_KIND_VERBS } from '../../lib/constants'
import { formatDateTime, formatRelative } from '../../lib/format'

const pill = 'inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[11px] font-medium'

/** "sara (agent laptop-claude)", "sara", or "The hub" for system rows. */
export function notificationActor(n) {
  const who = n.actor || 'The hub'
  return n.actor_kind === 'agent' && n.agent_name ? `${who} (agent ${n.agent_name})` : who
}

export function NotifyKindBadge({ kind }) {
  return (
    <span className={`${pill} ${NOTIFY_KIND_STYLES[kind] ?? 'border-hairline text-ink-secondary'}`}>
      {NOTIFY_KIND_LABELS[kind] ?? kind}
    </span>
  )
}

/**
 * One notification as a button. `onOpen` gets the row; `onMarkRead`, when
 * given, adds a small "Mark read" control for unread rows.
 */
export default function NotificationItem({ notification: n, onOpen, onMarkRead, compact = false }) {
  const unread = !n.read_at
  return (
    <div className={`flex items-start gap-2 ${compact ? 'px-3 py-2.5' : 'px-4 py-3'} transition hover:bg-surface-raised`}>
      <span
        aria-hidden="true"
        className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${unread ? 'bg-series1' : 'bg-transparent'}`}
      />
      <button type="button" onClick={() => onOpen(n)} className="min-w-0 flex-1 text-start">
        <div className="flex flex-wrap items-center gap-1.5">
          <NotifyKindBadge kind={n.kind} />
          <span dir="auto" className={`text-sm ${unread ? 'font-medium' : 'text-ink-secondary'}`}>
            {notificationActor(n)}
          </span>
          <span className="text-sm text-ink-secondary">{NOTIFY_KIND_VERBS[n.kind] ?? n.kind}</span>
          <span className="sr-only">{unread ? '(unread)' : '(read)'}</span>
        </div>
        <div className="mt-0.5 flex items-baseline gap-1.5">
          <span className="tabular shrink-0 text-xs text-ink-muted">#{n.task_id}</span>
          <span dir="auto" className={`min-w-0 break-words text-sm ${compact ? 'line-clamp-1' : ''}`}>
            {n.task_title}
          </span>
        </div>
        {n.text && (
          <p
            dir="auto"
            className={`mt-1 whitespace-pre-wrap break-words text-xs text-ink-secondary ${
              compact ? 'line-clamp-2' : 'line-clamp-3'
            }`}
          >
            {n.text}
          </p>
        )}
      </button>
      <div className="flex shrink-0 flex-col items-end gap-1">
        <time dateTime={n.created_at} title={formatDateTime(n.created_at)} className="text-xs text-ink-muted">
          {formatRelative(n.created_at)}
        </time>
        {onMarkRead && unread && (
          <button
            type="button"
            onClick={() => onMarkRead(n)}
            className="text-[11px] text-ink-secondary underline-offset-2 hover:text-ink hover:underline"
          >
            Mark read
          </button>
        )}
      </div>
    </div>
  )
}
