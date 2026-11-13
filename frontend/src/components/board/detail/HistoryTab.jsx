import { ActorBadge, PlainText } from '../../Badges'
import {
  COMMENT_KIND_LABELS,
  DEPLOY_LABELS,
  EVENT_LABELS,
  GIT_KIND_LABELS,
  SIDE_LABELS,
  STATUS_LABELS,
  formatBytes,
} from '../../../lib/constants'
import { formatDateTime } from '../../../lib/format'

const FIELD_LABELS = {
  title: 'Title',
  description: 'Description',
  summary: 'Summary',
  priority: 'Priority',
  points: 'Points',
  due_date: 'Due date',
  side: 'Side',
  tags: 'Tags',
  areas: 'Areas',
  restricted: 'Restricted',
  pool: 'Pool',
}

function plain(value) {
  if (value === null || value === undefined || value === '') return 'empty'
  if (Array.isArray(value)) return value.length ? value.join(', ') : 'empty'
  if (typeof value === 'boolean') return value ? 'yes' : 'no'
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

function fieldValue(field, value) {
  if (field === 'side' && value) return SIDE_LABELS[value] ?? value
  if (field === 'due_date' && value) return formatDateTime(value)
  if (field === 'summary' && typeof value === 'string' && value.length > 120) {
    return `${value.slice(0, 119)}…`
  }
  return plain(value)
}

function names(ids, peopleById) {
  if (!Array.isArray(ids) || ids.length === 0) return 'nobody'
  return ids.map((id) => peopleById[id]?.name ?? `user ${id}`).join(' + ')
}

/** Turn an event's `data` into readable lines. Unknown keys fall back to key: value. */
function describe(event, peopleById) {
  const data = event.data
  if (!data || typeof data !== 'object') return []
  switch (event.event_type) {
    case 'field_changed':
      return Object.entries(data).map(([field, change]) => {
        const label = FIELD_LABELS[field] ?? field
        if (Array.isArray(change) && change.length === 2) {
          if (field === 'description') return `${label} changed`
          return `${label}: ${fieldValue(field, change[0])} → ${fieldValue(field, change[1])}`
        }
        return `${label}: ${plain(change)}`
      })
    case 'claimed':
      return [
        data.renewed ? 'Renewed the claim' : null,
        data.agent ? `Agent: ${data.agent}` : 'From the web',
        data.branch ? `Branch: ${data.branch}` : null,
        data.expires_at ? `Until ${formatDateTime(data.expires_at)}` : null,
      ].filter(Boolean)
    case 'released':
      return [
        data.holder ? `Holder: ${peopleById[data.holder]?.name ?? `user ${data.holder}`}` : null,
        data.agent ? `Agent: ${data.agent}` : null,
      ].filter(Boolean)
    case 'assigned':
      return [`From ${names(data.from, peopleById)} to ${names(data.to, peopleById)}`]
    case 'question_asked':
      return [data.to ? `Asked ${peopleById[data.to]?.name ?? `user ${data.to}`}` : null].filter(Boolean)
    case 'question_answered':
      return [data.resolved_without_answer ? 'Resolved without an answer' : 'Answered'].filter(Boolean)
    case 'commented':
      return data.kind ? [COMMENT_KIND_LABELS[data.kind] ?? data.kind] : []
    case 'criterion_added':
      return [`Criterion ${data.n}`]
    case 'criterion_changed': {
      const lines = []
      if (Array.isArray(data.state)) lines.push(`Criterion ${data.n}: ${data.state[0]} → ${data.state[1]}`)
      else lines.push(`Criterion ${data.n}`)
      if (data.evidence) lines.push('Evidence updated')
      if (data.text_changed) lines.push('Text changed')
      return lines
    }
    case 'git_linked':
      return [
        `${GIT_KIND_LABELS[data.kind] ?? data.kind} ${data.repo} ${data.kind === 'commit' ? String(data.ref).slice(0, 12) : data.ref}${data.state ? ` (${data.state})` : ''}`,
      ]
    case 'deployed':
      return [
        `${DEPLOY_LABELS[data.from] ?? data.from} → ${DEPLOY_LABELS[data.to] ?? data.to}`,
        data.note ? `Note: ${data.note}` : null,
      ].filter(Boolean)
    case 'triaged':
      return Object.entries(data).map(([field, value]) =>
        field === 'assignee_1_id'
          ? `Assigned to ${peopleById[value]?.name ?? `user ${value}`}`
          : `${FIELD_LABELS[field] ?? field}: ${fieldValue(field, value)}`,
      )
    case 'doc_saved':
      return [
        `${data.slug} v${data.version}${data.created ? ' (new)' : ''}`,
        data.restored_from ? `Restored version ${data.restored_from}` : null,
        data.note ? `Note: ${data.note}` : null,
      ].filter(Boolean)
    case 'file_added':
      return [data.name ? `${data.name}${data.size ? ` (${formatBytes(data.size)})` : ''}` : null].filter(Boolean)
    case 'file_removed':
      return [data.name].filter(Boolean)
    case 'context_added':
      return [data.url ?? (data.repo ? `${data.repo}: ${data.path}` : null)].filter(Boolean)
    case 'context_removed':
      return [data.title].filter(Boolean)
    default:
      return Object.entries(data).map(([key, value]) => `${key}: ${plain(value)}`)
  }
}

const DOT = {
  rejected: 'bg-critical',
  dropped: 'bg-critical',
  approved: 'bg-good',
  closed: 'bg-good',
  question_asked: 'bg-warning',
  claimed: 'bg-series1',
}

export default function HistoryTab({ events, people }) {
  if (!events.length) return <p className="text-sm text-ink-muted">No activity yet.</p>
  const peopleById = Object.fromEntries(people.map((p) => [p.id, p]))

  return (
    <ol className="space-y-3">
      {events.map((event) => {
        const lines = describe(event, peopleById)
        const moved = event.to_status && event.from_status !== event.to_status
        return (
          <li key={event.id} className="flex gap-3 text-sm">
            <span
              aria-hidden="true"
              className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${DOT[event.event_type] ?? 'bg-baseline'}`}
            />
            <div className="min-w-0 flex-1">
              <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1 leading-snug">
                <span dir="auto" className="font-medium">
                  {event.actor?.name ?? `User ${event.actor_id}`}
                </span>
                <ActorBadge kind={event.actor_kind} agent={event.agent_name} />
                <span className="text-ink-secondary">{EVENT_LABELS[event.event_type] ?? event.event_type}</span>
                {moved && (
                  <span className="text-ink-secondary">
                    {event.from_status && (
                      <>
                        from <span className="font-medium text-ink">{STATUS_LABELS[event.from_status] ?? event.from_status}</span>{' '}
                      </>
                    )}
                    to <span className="font-medium text-ink">{STATUS_LABELS[event.to_status] ?? event.to_status}</span>
                  </span>
                )}
              </p>
              {lines.length > 0 && (
                <ul className="mt-1 space-y-0.5 text-[13px] text-ink-secondary">
                  {lines.map((line, index) => (
                    <li key={index} dir="auto" className="whitespace-pre-wrap break-words">
                      {line}
                    </li>
                  ))}
                </ul>
              )}
              {event.comment && (
                <PlainText className="mt-1 rounded-md border border-hairline bg-surface-raised px-2.5 py-1.5 text-[13px] text-ink-secondary">
                  {event.comment}
                </PlainText>
              )}
              <time className="mt-0.5 block text-xs text-ink-muted">{formatDateTime(event.timestamp)}</time>
            </div>
          </li>
        )
      })}
    </ol>
  )
}
