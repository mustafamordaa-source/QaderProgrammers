import TaskCard from './TaskCard'
import { ChevronRight, CollapseIcon } from './BoardIcons'

/** Border and background for a column (or a swimlane cell) during a drag. */
export function zoneClass(zone, hovered) {
  if (zone === 'allowed') {
    return hovered
      ? 'border-series1 bg-series1/[0.07] ring-2 ring-series1/30'
      : 'border-dashed border-series1/60 bg-surface-raised/60'
  }
  if (zone === 'blocked') {
    return hovered ? 'border-critical/50 bg-surface-raised/40 opacity-70' : 'border-hairline bg-surface-raised/40 opacity-50'
  }
  return 'border-hairline bg-surface-raised/50'
}

function Count({ value, of = null }) {
  return (
    <span className="tabular rounded-full bg-surface px-1.5 py-px text-[11px] font-medium text-ink-secondary ring-1 ring-hairline">
      {of !== null && of !== value ? `${value} of ${of}` : value}
    </span>
  )
}

/**
 * Name, task count and points, with the collapse toggle. In Triage, leads get
 * a tick-all box for the bulk bar.
 */
export function ColumnHeader({
  column,
  count,
  shown = null,
  points,
  bodyId,
  onCollapse = null,
  selectAll = null,
  extra = null,
}) {
  return (
    <header className="flex items-center gap-2 px-3 py-2.5">
      {selectAll && (
        <input
          type="checkbox"
          checked={selectAll.checked}
          onChange={(event) => selectAll.onChange(event.target.checked)}
          aria-label={`Select every task in ${column.label}`}
        />
      )}
      <h2 className="truncate text-xs font-semibold uppercase tracking-wide text-ink-secondary">{column.label}</h2>
      <Count value={shown ?? count} of={shown === null ? null : count} />
      <span className="tabular whitespace-nowrap text-[11px] text-ink-muted" title="Story points in this column">
        {points} pts
      </span>
      <span className="ms-auto flex items-center gap-1">
        {extra}
        {onCollapse && (
          <button
            type="button"
            onClick={onCollapse}
            aria-expanded="true"
            aria-controls={bodyId}
            aria-label={`Collapse ${column.label} column`}
            title="Collapse column"
            className="rounded-md p-1 text-ink-muted transition hover:bg-surface hover:text-ink"
          >
            <CollapseIcon />
          </button>
        )}
      </span>
    </header>
  )
}

/** A collapsed column: a narrow strip with the name and count, read top to bottom. */
export function CollapsedStrip({ column, count, onExpand, bodyId, short = false }) {
  return (
    <button
      type="button"
      onClick={onExpand}
      aria-expanded="false"
      aria-controls={bodyId}
      aria-label={`Expand ${column.label} column, ${count} task${count === 1 ? '' : 's'}`}
      title={`Expand ${column.label}`}
      className="flex h-full w-full flex-col items-center gap-2 rounded-xl py-2.5 text-ink-secondary transition hover:bg-surface hover:text-ink"
    >
      <ChevronRight />
      <Count value={count} />
      {!short && (
        <span className="text-xs font-semibold uppercase tracking-wide [writing-mode:vertical-rl]">{column.label}</span>
      )}
    </button>
  )
}

/** The cards of one column (or one swimlane cell), with an empty line when there are none. */
export function CardList({ list, empty, cardProps, groups = null }) {
  if (list.length === 0) {
    return empty ? <p className="px-1 py-3 text-xs leading-relaxed text-ink-muted">{empty}</p> : null
  }
  if (groups) {
    // Phones with grouping: one column at a time, lanes as sub-headings.
    return (
      <div className="flex flex-col gap-3">
        {groups.map((group) => (
          <div key={group.key} className="flex flex-col gap-2">
            <h3 dir="auto" className="sticky top-0 z-10 bg-surface-raised px-1 py-1 text-[11px] font-semibold text-ink-secondary">
              {group.label} <span className="tabular font-normal text-ink-muted">· {group.tasks.length}</span>
            </h3>
            {group.tasks.map((task) => (
              <TaskCard key={task.id} task={task} {...cardProps(task)} />
            ))}
          </div>
        ))}
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-2">
      {list.map((task) => (
        <TaskCard key={task.id} task={task} {...cardProps(task)} />
      ))}
    </div>
  )
}
