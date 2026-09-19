import { OverdueBadge, PriorityBadge } from '../Badges'
import { formatDate, initials, isOverdue } from '../../lib/format'

function Assignees({ task }) {
  const people = [task.assignee_1, task.assignee_2].filter(Boolean)
  if (people.length === 0) {
    return <span className="text-[11px] text-ink-muted">Unassigned</span>
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
      {people.length === 2 && (
        <span className="text-[11px] text-ink-muted">shared</span>
      )}
    </div>
  )
}

export default function TaskCard({ task, onOpen, onDragStart, draggable }) {
  const overdue = isOverdue(task.due_date, task.status)

  return (
    <article
      draggable={draggable}
      onDragStart={(event) => onDragStart?.(event, task)}
      className={`rounded-lg border border-hairline bg-surface p-3 text-left shadow-sm transition hover:border-series1/50 ${
        draggable ? 'cursor-grab active:cursor-grabbing' : ''
      }`}
    >
      <button
        type="button"
        onClick={() => onOpen(task)}
        className="block w-full text-left"
      >
        <h3 className="text-sm font-medium leading-snug">{task.title}</h3>
      </button>

      <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
        <PriorityBadge priority={task.priority} />
        {overdue && <OverdueBadge />}
      </div>

      {/* Wraps rather than colliding: the columns get narrow at five across. */}
      <div className="mt-3 flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
        <Assignees task={task} />
        <span className="tabular whitespace-nowrap text-[11px] text-ink-muted">
          {task.due_date ? `Due ${formatDate(task.due_date)}` : 'No due date'}
        </span>
      </div>
    </article>
  )
}
