import { useState } from 'react'
import TaskCard from './TaskCard'
import {
  BOARD_COLUMNS,
  allowedTargets,
  isWorkerOn,
  moveNeedsComment,
  moveNeedsCriteriaMet,
} from '../../lib/constants'

/** The status a drop on `column` would move `task` to, or null. Moves that
 *  need a comment (drop, send back) or open criteria stay in the detail view. */
function dropTarget(column, task, targets) {
  if (!task || column.statuses.includes(task.status)) return null
  return (
    column.statuses.find(
      (status) =>
        targets.includes(status) &&
        !moveNeedsComment(task.status, status) &&
        !(moveNeedsCriteriaMet(status) && task.criteria_open > 0),
    ) ?? null
  )
}

/**
 * Fixed columns. Cards can be dragged between them, but a drop is only
 * accepted where the transition is legal for the current user — and the
 * server re-checks it regardless. Leaders also see the Triage column.
 */
export default function KanbanBoard({ tasks, user, onOpenTask, onMove }) {
  const [dragging, setDragging] = useState(null)
  const [hoveredColumn, setHoveredColumn] = useState(null)
  const isLeader = user.role === 'leader'

  const columns = BOARD_COLUMNS.filter((column) => !column.leaderOnly || isLeader)
  const byColumn = Object.fromEntries(
    columns.map((column) => [
      column.key,
      tasks.filter((task) => column.statuses.includes(task.status)),
    ]),
  )

  const targetsFor = (task) => allowedTargets(task, user.role, isWorkerOn(task, user))
  const draggingTargets = dragging ? targetsFor(dragging) : []

  function handleDragStart(event, task) {
    setDragging(task)
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', String(task.id))
  }

  function handleDrop(column) {
    const target = dropTarget(column, dragging, draggingTargets)
    if (dragging && target) onMove(dragging, target)
    setDragging(null)
    setHoveredColumn(null)
  }

  return (
    <div
      className="grid auto-cols-[minmax(15rem,1fr)] grid-flow-col gap-3 overflow-x-auto pb-2"
      onDragEnd={() => {
        setDragging(null)
        setHoveredColumn(null)
      }}
    >
      {columns.map((column) => {
        const target = dropTarget(column, dragging, draggingTargets)
        const isHome = dragging && column.statuses.includes(dragging.status)
        const isBlocked = dragging && !target && !isHome
        const list = byColumn[column.key]

        return (
          <section
            key={column.key}
            aria-label={column.label}
            onDragOver={(event) => {
              if (!target) return
              event.preventDefault()
              setHoveredColumn(column.key)
            }}
            onDragLeave={() =>
              setHoveredColumn((current) => (current === column.key ? null : current))
            }
            onDrop={(event) => {
              event.preventDefault()
              handleDrop(column)
            }}
            className={[
              'flex min-h-[8rem] flex-col rounded-xl border p-2.5 transition',
              hoveredColumn === column.key
                ? 'border-series1 bg-surface-raised'
                : 'border-hairline bg-surface-raised/50',
              isBlocked ? 'opacity-40' : '',
            ].join(' ')}
          >
            <header className="mb-2.5 flex items-baseline justify-between px-1">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-ink-secondary">
                {column.label}
              </h2>
              <span className="tabular text-xs text-ink-muted">{list.length}</span>
            </header>

            <div className="flex flex-col gap-2">
              {list.map((task) => (
                <TaskCard
                  key={task.id}
                  task={task}
                  onOpen={onOpenTask}
                  onDragStart={handleDragStart}
                  draggable={targetsFor(task).length > 0}
                  showStatus={column.statuses.length > 1}
                />
              ))}
              {list.length === 0 && (
                <p className="px-1 py-3 text-xs text-ink-muted">Nothing here.</p>
              )}
            </div>
          </section>
        )
      })}
    </div>
  )
}
