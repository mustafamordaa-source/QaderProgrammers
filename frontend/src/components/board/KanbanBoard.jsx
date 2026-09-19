import { useState } from 'react'
import TaskCard from './TaskCard'
import { STATUSES, STATUS_LABELS, allowedTargets } from '../../lib/constants'

/**
 * Five fixed columns. Cards can be dragged between them, but a drop is only
 * accepted where the transition is legal for the current user's role — and the
 * server re-checks it regardless.
 */
export default function KanbanBoard({ tasks, role, onOpenTask, onMove }) {
  const [dragging, setDragging] = useState(null)
  const [hoveredColumn, setHoveredColumn] = useState(null)

  const byStatus = Object.fromEntries(
    STATUSES.map((status) => [status, tasks.filter((task) => task.status === status)]),
  )

  const validTargets = dragging ? allowedTargets(dragging.status, role) : []

  function handleDragStart(event, task) {
    setDragging(task)
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', String(task.id))
  }

  function handleDrop(status) {
    if (dragging && validTargets.includes(status)) {
      onMove(dragging, status)
    }
    setDragging(null)
    setHoveredColumn(null)
  }

  return (
    <div
      className="grid gap-3 lg:grid-cols-5"
      onDragEnd={() => {
        setDragging(null)
        setHoveredColumn(null)
      }}
    >
      {STATUSES.map((status) => {
        const isTarget = dragging && validTargets.includes(status)
        const isBlocked = dragging && !isTarget && dragging.status !== status

        return (
          <section
            key={status}
            aria-label={STATUS_LABELS[status]}
            onDragOver={(event) => {
              if (!isTarget) return
              event.preventDefault()
              setHoveredColumn(status)
            }}
            onDragLeave={() => setHoveredColumn((current) => (current === status ? null : current))}
            onDrop={(event) => {
              event.preventDefault()
              handleDrop(status)
            }}
            className={[
              'flex min-h-[8rem] flex-col rounded-xl border p-2.5 transition',
              hoveredColumn === status
                ? 'border-series1 bg-surface-raised'
                : 'border-hairline bg-surface-raised/50',
              isBlocked ? 'opacity-40' : '',
            ].join(' ')}
          >
            <header className="mb-2.5 flex items-baseline justify-between px-1">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-ink-secondary">
                {STATUS_LABELS[status]}
              </h2>
              <span className="tabular text-xs text-ink-muted">
                {byStatus[status].length}
              </span>
            </header>

            <div className="flex flex-col gap-2">
              {byStatus[status].map((task) => (
                <TaskCard
                  key={task.id}
                  task={task}
                  onOpen={onOpenTask}
                  onDragStart={handleDragStart}
                  draggable={allowedTargets(task.status, role).length > 0}
                />
              ))}
              {byStatus[status].length === 0 && (
                <p className="px-1 py-3 text-xs text-ink-muted">Nothing here.</p>
              )}
            </div>
          </section>
        )
      })}
    </div>
  )
}
