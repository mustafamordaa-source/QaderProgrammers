import {
  ActorBadge,
  DeployBadge,
  OverdueBadge,
  PointsBadge,
  PriorityBadge,
  SideBadge,
  StatusBadge,
} from '../Badges'
import { claimIsLive } from '../../lib/constants'
import { formatDate, formatDateTime, initials, isOverdue } from '../../lib/format'

function Assignees({ task }) {
  const people = [task.assignee_1, task.assignee_2].filter(Boolean)
  if (people.length === 0) {
    return (
      <span className="text-[11px] text-ink-muted">{task.pool ? 'Pool' : 'Unassigned'}</span>
    )
  }
  return (
    <div className="flex items-center gap-1.5">
      <div className="flex gap-1">
        {people.map((person) => (
          <span
            key={person.id}
            title={person.name}
            className="grid h-5 w-5 place-items-center rounded-full bg-surface-raised text-[9px] font-semibold text-ink-secondary"
          >
            {initials(person.name)}
          </span>
        ))}
      </div>
      {people.length === 2 && <span className="text-[11px] text-ink-muted">shared</span>}
      {task.pool && <span className="text-[11px] text-ink-muted">· pool</span>}
    </div>
  )
}

function ClaimBadge({ task }) {
  if (!claimIsLive(task)) return null
  const who = task.claimer?.handle || task.claimer?.name || 'someone'
  return (
    <span
      title={`Claimed until ${formatDateTime(task.claim_expires_at)}`}
      dir="auto"
      className="inline-flex max-w-full items-center gap-1 truncate rounded-full border border-series1/40 px-2 py-0.5 text-[11px] font-medium text-series1"
    >
      <span aria-hidden="true">●</span>
      {who}
      {task.claim_agent ? ` / ${task.claim_agent}` : ''}
      <span className="font-normal text-ink-muted">until {formatDateTime(task.claim_expires_at)}</span>
    </span>
  )
}

export default function TaskCard({ task, onOpen, onDragStart, draggable, showStatus = false }) {
  const overdue = isOverdue(task.due_date, task.status)
  const met = (task.criteria_total ?? 0) - (task.criteria_open ?? 0)

  return (
    <article
      draggable={draggable}
      onDragStart={(event) => onDragStart?.(event, task)}
      className={`rounded-lg border border-hairline bg-surface p-3 text-left shadow-sm transition hover:border-series1/50 ${
        draggable ? 'cursor-grab active:cursor-grabbing' : ''
      }`}
    >
      <button type="button" onClick={() => onOpen(task)} className="block w-full text-left">
        <span className="tabular text-[11px] text-ink-muted">#{task.id}</span>
        <h3 dir="auto" className="break-words text-sm font-medium leading-snug">
          {task.title}
        </h3>
      </button>

      <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
        {showStatus && <StatusBadge status={task.status} />}
        <SideBadge side={task.side} />
        <PointsBadge points={task.points} />
        <PriorityBadge priority={task.priority} />
        {overdue && <OverdueBadge />}
        {task.created_kind === 'agent' && (
          <ActorBadge kind="agent" agent={task.created_agent} />
        )}
        {task.restricted && (
          <span className="inline-flex items-center rounded-full border border-critical/30 px-2 py-0.5 text-[11px] text-ink-secondary">
            Restricted
          </span>
        )}
        <DeployBadge state={task.deploy_state} hideNone />
      </div>

      {(task.criteria_total > 0 || task.open_questions > 0 || claimIsLive(task)) && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {task.criteria_total > 0 && (
            <span
              title="Acceptance criteria met (or dropped) out of total"
              className={`tabular inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${
                task.criteria_open === 0
                  ? 'border-good/40 text-good'
                  : 'border-hairline text-ink-secondary'
              }`}
            >
              ✓ {met}/{task.criteria_total}
            </span>
          )}
          {task.open_questions > 0 && (
            <span className="tabular inline-flex items-center rounded-full border border-warning/50 px-2 py-0.5 text-[11px] font-medium text-warning">
              ? {task.open_questions} open question{task.open_questions === 1 ? '' : 's'}
            </span>
          )}
          <ClaimBadge task={task} />
        </div>
      )}

      {/* Wraps rather than colliding: the columns get narrow at six across. */}
      <div className="mt-3 flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
        <Assignees task={task} />
        <span className="tabular whitespace-nowrap text-[11px] text-ink-muted">
          {task.due_date ? `Due ${formatDate(task.due_date)}` : 'No due date'}
        </span>
      </div>
    </article>
  )
}
