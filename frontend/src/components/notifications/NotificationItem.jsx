import { useLayoutEffect, useRef, useState } from 'react'
import { RichText } from '../MarkdownPreview'
import {
  AUDIENCE_SHORT_LABELS,
  NOTIFY_KIND_LABELS,
  NOTIFY_KIND_STYLES,
  NOTIFY_KIND_VERBS,
  PRIORITY_LABELS,
  SIDE_LABELS,
  STATUS_LABELS,
  taskKey,
} from '../../lib/constants'
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

/** "In progress · High · Backend · auth · Students · claim: sara until … · parts 1/4 taken". */
function snapshotParts(task) {
  if (!task) return []
  const parts = []
  if (task.status) parts.push(STATUS_LABELS[task.status] ?? task.status)
  if (task.priority) parts.push(PRIORITY_LABELS[task.priority] ?? task.priority)
  if (task.side) parts.push(SIDE_LABELS[task.side] ?? task.side)
  if (task.area) parts.push(task.area)
  if (task.audience) parts.push(AUDIENCE_SHORT_LABELS[task.audience] ?? task.audience)
  if (task.claim) parts.push(`claim: ${task.claim}`)
  if (task.parts) parts.push(`parts ${task.parts}`)
  if (task.restricted) parts.push('Restricted')
  return parts
}

/** Markdown cut to about six lines, with Show more when it runs longer. */
function CollapsedText({ text, compact }) {
  const boxRef = useRef(null)
  const [expanded, setExpanded] = useState(false)
  const [overflows, setOverflows] = useState(false)

  useLayoutEffect(() => {
    const box = boxRef.current
    if (!box || expanded) return
    setOverflows(box.scrollHeight > box.clientHeight + 1)
  }, [text, expanded])

  return (
    <div className="mt-1.5">
      <div
        ref={boxRef}
        className={expanded ? '' : 'max-h-[8.5rem] overflow-hidden'}
      >
        <RichText className="text-ink-secondary">{text}</RichText>
      </div>
      {(overflows || expanded) && (
        <button
          type="button"
          onClick={() => setExpanded((on) => !on)}
          aria-expanded={expanded}
          className="mt-1 text-[11px] font-medium text-series1 underline-offset-2 hover:underline"
        >
          {expanded ? 'Show less' : 'Show more'}
        </button>
      )}
    </div>
  )
}

/**
 * One notification. The header is the button that opens the task; a click
 * anywhere else on the row opens it too, except on links and controls inside
 * the text. `onMarkRead`, when given, adds a small "Mark read" control for
 * unread rows. Rows read with `expand=task,thread` carry a task snapshot, the
 * full comment and what it replies to; older answers fall back to `text`.
 */
export default function NotificationItem({ notification: n, onOpen, onMarkRead, compact = false }) {
  const unread = !n.read_at
  const key = n.task?.key ?? taskKey(n.task_id)
  const title = n.task?.title ?? n.task_title
  const snapshot = snapshotParts(n.task)
  const body = n.thread?.comment?.body ?? n.text
  const reply = n.thread?.replies_to

  function openFromRow(event) {
    if (event.target.closest('a, button, summary, input, select, textarea')) return
    // Selecting text to copy should not open the task.
    if (window.getSelection?.()?.toString()) return
    onOpen(n)
  }

  return (
    <div className={`flex items-start gap-2 ${compact ? 'px-3 py-2.5' : 'px-4 py-3'} transition hover:bg-surface-raised`}>
      <span
        aria-hidden="true"
        className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${unread ? 'bg-series1' : 'bg-transparent'}`}
      />
      <div className="min-w-0 flex-1 cursor-pointer" onClick={openFromRow}>
        <button type="button" onClick={() => onOpen(n)} className="block w-full min-w-0 text-start">
          <span className="flex flex-wrap items-center gap-1.5">
            <NotifyKindBadge kind={n.kind} />
            <span dir="auto" className={`text-sm ${unread ? 'font-medium' : 'text-ink-secondary'}`}>
              {notificationActor(n)}
            </span>
            <span className="text-sm text-ink-secondary">{NOTIFY_KIND_VERBS[n.kind] ?? n.kind}</span>
            <span className="sr-only">{unread ? '(unread)' : '(read)'}</span>
          </span>
          <span className="mt-0.5 flex items-baseline gap-1.5">
            <span className="tabular shrink-0 text-xs text-ink-muted">{key}</span>
            <span dir="auto" className={`min-w-0 break-words text-sm ${compact ? 'line-clamp-1' : 'line-clamp-2'}`}>
              {title}
            </span>
          </span>
        </button>

        {snapshot.length > 0 && (
          <p className="mt-0.5 flex flex-wrap gap-x-1 text-[11px] text-ink-muted">
            {snapshot.map((part, i) => (
              <span key={i} dir="auto" className="break-words">
                {i > 0 && <span aria-hidden="true">· </span>}
                {part}
              </span>
            ))}
          </p>
        )}

        {reply && (
          <p className="mt-1.5 line-clamp-2 break-words border-s-2 border-hairline ps-2 text-xs text-ink-muted">
            replies to <span dir="auto" className="font-medium text-ink-secondary">@{reply.author}</span>:{' '}
            <span dir="auto">{reply.body}</span>
          </p>
        )}

        {body && <CollapsedText text={body} compact={compact} />}
      </div>
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
