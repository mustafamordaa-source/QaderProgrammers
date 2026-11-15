import { useCallback, useMemo, useRef, useState } from 'react'
import BoardScroller from './BoardScroller'
import { CardList, CollapsedStrip, ColumnHeader, ColumnMore, zoneClass } from './BoardColumn'
import {
  COLUMN_GAP,
  buildLanes,
  dropBlockReason,
  dropTarget,
  emptyLine,
  sortDone,
  targetsFor,
} from './boardLayout'
import { BOARD_COLUMNS, STATUS_LABELS, hasLeadRights } from '../../lib/constants'

const sumPoints = (list) => list.reduce((total, task) => total + (Number(task.points) || 0), 0)

/**
 * Fixed columns that fill the window under the header. The row of columns
 * scrolls sideways on its own and each column scrolls down on its own. Cards
 * drag between columns, but a drop only lands where the move is legal for
 * this user (the server re-checks it); elsewhere a short line says why not.
 * Leads also see Triage. `groupBy` turns the board into swimlanes; on phones
 * the board shows one column at a time with tabs.
 *
 * `tasks` holds the cards loaded so far. `columnMeta[key]` carries the column's
 * full `total` and `points` from the server; `onLoadMore(key)` fetches its next
 * 20 cards when the user scrolls near the end of the column.
 */
export default function KanbanBoard({
  tasks,
  columnMeta = {},
  onLoadMore = null,
  user,
  filtered = false,
  density = 'comfortable',
  groupBy = 'none',
  collapsed = [],
  onToggleCollapse,
  isMobile = false,
  onOpenTask,
  onMove,
  onClaim = null,
  claimingId = null,
  showLane = false,
  selectedIds = null,
  onSelect = null,
  onSelectMany = null,
}) {
  const [dragging, setDragging] = useState(null)
  const [hovered, setHovered] = useState(null)
  const [activeIndex, setActiveIndex] = useState(0)
  const scrollRef = useRef(null)
  const isLead = hasLeadRights(user)

  const columns = useMemo(() => BOARD_COLUMNS.filter((column) => !column.leadOnly || isLead), [isLead])

  const byColumn = useMemo(() => {
    const map = {}
    for (const column of columns) {
      const list = tasks.filter((task) => column.statuses.includes(task.status))
      map[column.key] = column.key === 'done' ? sortDone(list) : list
    }
    return map
  }, [columns, tasks])

  const lanes = useMemo(
    () => (groupBy === 'none' ? null : buildLanes(tasks, groupBy, user)),
    [groupBy, tasks, user],
  )
  const laneOf = useMemo(() => {
    const map = new Map()
    for (const lane of lanes ?? []) for (const task of lane.tasks) map.set(task.id, lane.key)
    return map
  }, [lanes])

  const visible = (key) => byColumn[key]
  // Every task in the column on the server, never fewer than the cards shown.
  const totalOf = (key) => Math.max(columnMeta[key]?.total ?? 0, byColumn[key].length)
  const pointsOf = (key) =>
    columnMeta[key] && columnMeta[key].total > byColumn[key].length
      ? columnMeta[key].points
      : sumPoints(byColumn[key])
  const hasMore = (key) => {
    const meta = columnMeta[key]
    return Boolean(onLoadMore && meta && !meta.ended && meta.served < meta.total)
  }
  const moreProps = (key) => ({
    shown: byColumn[key].length,
    total: totalOf(key),
    hasMore: hasMore(key),
    loading: Boolean(columnMeta[key]?.loading),
    onMore: () => onLoadMore?.(key),
  })

  const draggingTargets = dragging ? targetsFor(dragging, user) : []

  function zoneOf(column) {
    if (!dragging) return 'idle'
    if (column.statuses.includes(dragging.status)) return 'home'
    return dropTarget(column, dragging, draggingTargets) ? 'allowed' : 'blocked'
  }

  function endDrag() {
    setDragging(null)
    setHovered(null)
  }

  function handleDragStart(event, task) {
    setDragging(task)
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', String(task.id))
  }

  function dropProps(column) {
    const target = dropTarget(column, dragging, draggingTargets)
    return {
      onDragOver: (event) => {
        if (!dragging) return
        setHovered(column.key)
        if (!target) return
        event.preventDefault()
        event.dataTransfer.dropEffect = 'move'
      },
      onDragLeave: (event) => {
        if (event.currentTarget.contains(event.relatedTarget)) return
        setHovered((current) => (current === column.key ? null : current))
      },
      onDrop: (event) => {
        event.preventDefault()
        if (dragging && target) onMove(dragging, target)
        endDrag()
      },
    }
  }

  const cardProps = (column) => (task) => {
    const selectable = column.key === 'triage' && isLead && onSelect
    return {
      user,
      density,
      onOpen: onOpenTask,
      onDragStart: handleDragStart,
      onDragEnd: endDrag,
      // Touch screens have no HTML drag and drop; phones move tasks from the detail view.
      draggable: !isMobile && targetsFor(task, user).length > 0,
      showStatus: column.statuses.length > 1,
      selected: Boolean(selectable && selectedIds?.has(task.id)),
      onSelect: selectable ? onSelect : null,
      onClaim,
      claiming: claimingId === task.id,
      showLane,
    }
  }

  function selectAllFor(column) {
    const list = byColumn[column.key]
    if (column.key !== 'triage' || !isLead || !onSelectMany || list.length === 0) return null
    return {
      checked: list.every((task) => selectedIds?.has(task.id)),
      onChange: (on) => onSelectMany(list, on),
    }
  }

  // Swimlanes scroll as one sheet, so a column loads more from its header.
  function moreButton(key) {
    if (!hasMore(key)) return null
    const loadingMore = Boolean(columnMeta[key]?.loading)
    return (
      <button
        type="button"
        onClick={() => onLoadMore(key)}
        disabled={loadingMore}
        className="rounded-md px-1.5 py-0.5 text-[11px] font-medium text-series1 hover:bg-surface disabled:opacity-60"
      >
        {loadingMore ? 'Loading…' : 'Load more'}
      </button>
    )
  }

  // What the drag would do on the column under the pointer, for the live line.
  let dragLine = null
  if (dragging && hovered) {
    const column = columns.find((c) => c.key === hovered)
    if (column && !column.statuses.includes(dragging.status)) {
      const target = dropTarget(column, dragging, draggingTargets)
      dragLine = target
        ? { ok: true, text: `Drop to move #${dragging.id} to ${STATUS_LABELS[target] ?? column.label}.` }
        : { ok: false, text: dropBlockReason(column, dragging, draggingTargets, user) }
    }
  }

  const handleScrollChange = useCallback(
    (node) => {
      if (!isMobile) return
      const index = Math.round(Math.abs(node.scrollLeft) / (node.clientWidth + COLUMN_GAP))
      setActiveIndex((current) => (current === index ? current : index))
    },
    [isMobile],
  )

  function showColumn(index) {
    const node = scrollRef.current
    if (!node) return
    setActiveIndex(index)
    node.scrollTo({ left: index * (node.clientWidth + COLUMN_GAP), behavior: 'smooth' })
  }

  const isCollapsed = (key) => !isMobile && collapsed.includes(key)
  const contentKey = `${groupBy}|${isMobile}|${collapsed.join(',')}|${density}`

  // ---- Phones: one column at a time, tabs on top, snap scrolling. ----
  if (isMobile) {
    return (
      <div className="flex h-full min-h-0 flex-col gap-2" onDragEnd={endDrag}>
        <div
          role="tablist"
          aria-label="Board columns"
          className="board-scroll -mx-1 flex shrink-0 gap-1 overflow-x-auto px-1 pb-1"
        >
          {columns.map((column, index) => (
            <button
              key={column.key}
              type="button"
              role="tab"
              aria-selected={index === activeIndex}
              aria-controls={`col-${column.key}`}
              onClick={() => showColumn(index)}
              className={`shrink-0 rounded-full border px-3 py-1 text-xs font-medium transition ${
                index === activeIndex
                  ? 'border-series1 bg-series1 text-white'
                  : 'border-hairline text-ink-secondary hover:text-ink'
              }`}
            >
              {column.label}
              <span className="tabular ms-1.5 opacity-80">{totalOf(column.key)}</span>
            </button>
          ))}
        </div>
        <div className="min-h-0 flex-1">
          <BoardScroller
            scrollRef={scrollRef}
            label="Task board"
            step="page"
            snap
            showEdgeButtons={false}
            onScrollChange={handleScrollChange}
            contentKey={contentKey}
          >
            <div className="flex h-full gap-3">
              {columns.map((column) => {
                const list = visible(column.key)
                return (
                  <section
                    key={column.key}
                    id={`col-${column.key}`}
                    aria-label={column.label}
                    className="flex h-full w-full shrink-0 snap-start flex-col rounded-xl border border-hairline bg-surface-raised/50"
                  >
                    <ColumnHeader
                      column={column}
                      count={totalOf(column.key)}
                      shown={list.length}
                      points={pointsOf(column.key)}
                      selectAll={selectAllFor(column)}
                    />
                    <div data-column-scroll className="board-scroll min-h-0 flex-1 overflow-y-auto px-2 pb-2">
                      <CardList
                        list={list}
                        empty={emptyLine(column.key, { filtered, isLead })}
                        cardProps={cardProps(column)}
                        groups={lanes ? buildLanes(list, groupBy, user) : null}
                      />
                      <ColumnMore {...moreProps(column.key)} />
                    </div>
                  </section>
                )
              })}
            </div>
          </BoardScroller>
        </div>
      </div>
    )
  }

  const liveLine = (
    <div
      aria-live="polite"
      role="status"
      className="pointer-events-none absolute inset-x-0 bottom-6 z-40 flex justify-center px-4"
    >
      {dragLine?.text && (
        <p
          className={`max-w-md rounded-lg border bg-surface px-3 py-1.5 text-center text-xs font-medium shadow-lg ${
            dragLine.ok ? 'border-series1/40 text-series1' : 'border-critical/40 text-critical'
          }`}
        >
          {dragLine.text}
        </p>
      )}
    </div>
  )

  // ---- Swimlanes: a row per side or person; the column headers stick to the top. ----
  if (lanes) {
    return (
      <div className="relative h-full min-h-0" onDragEnd={endDrag}>
        <BoardScroller scrollRef={scrollRef} label="Task board in swimlanes" vertical contentKey={contentKey}>
          <div className="w-max min-w-full px-1 pb-2">
            <div className="sticky top-0 z-20 flex gap-3 bg-page pb-2 pt-1">
              {columns.map((column) => {
                const count = totalOf(column.key)
                const zone = zoneOf(column)
                return isCollapsed(column.key) ? (
                  <div
                    key={column.key}
                    {...dropProps(column)}
                    className={`w-11 shrink-0 rounded-xl border ${zoneClass(zone, hovered === column.key)}`}
                  >
                    <CollapsedStrip
                      column={column}
                      count={count}
                      short
                      onExpand={() => onToggleCollapse(column.key)}
                    />
                  </div>
                ) : (
                  <div
                    key={column.key}
                    {...dropProps(column)}
                    className={`w-[300px] shrink-0 rounded-xl border ${zoneClass(zone, hovered === column.key)}`}
                  >
                    <ColumnHeader
                      column={column}
                      count={count}
                      shown={byColumn[column.key].length}
                      points={pointsOf(column.key)}
                      onCollapse={() => onToggleCollapse(column.key)}
                      selectAll={selectAllFor(column)}
                      extra={moreButton(column.key)}
                    />
                  </div>
                )
              })}
            </div>

            {lanes.length === 0 && (
              <p className="sticky left-0 w-fit px-2 py-6 text-sm text-ink-muted">
                {filtered ? 'No tasks match these filters.' : 'No tasks to show.'}
              </p>
            )}

            {lanes.map((lane) => (
              <section key={lane.key || 'none'} aria-label={`${lane.label} swimlane`} className="mt-2">
                <div className="sticky left-0 z-10 flex w-fit items-center gap-2 rounded-md bg-page px-2 py-1.5">
                  <h3 dir="auto" className="text-sm font-semibold">
                    {lane.label}
                    {lane.me && <span className="ms-1 text-xs font-normal text-series1">(you)</span>}
                  </h3>
                  <span className="tabular text-xs text-ink-muted">
                    {lane.tasks.length} task{lane.tasks.length === 1 ? '' : 's'} · {sumPoints(lane.tasks)} pts
                  </span>
                </div>
                <div className="flex gap-3">
                  {columns.map((column) => {
                    const inCell = visible(column.key).filter((task) => laneOf.get(task.id) === lane.key)
                    const zone = zoneOf(column)
                    if (isCollapsed(column.key)) {
                      return (
                        <div
                          key={column.key}
                          {...dropProps(column)}
                          title={`${column.label}: ${inCell.length}`}
                          className={`flex w-11 shrink-0 justify-center rounded-lg border py-2 ${zoneClass(zone, hovered === column.key)}`}
                        >
                          <span className="tabular text-[11px] text-ink-muted">{inCell.length || ''}</span>
                        </div>
                      )
                    }
                    return (
                      <div
                        key={column.key}
                        {...dropProps(column)}
                        role="group"
                        aria-label={`${column.label}, ${lane.label}`}
                        className={`min-h-[3.5rem] w-[300px] shrink-0 rounded-lg border p-2 ${zoneClass(zone, hovered === column.key)}`}
                      >
                        <CardList list={inCell} empty={null} cardProps={cardProps(column)} />
                      </div>
                    )
                  })}
                </div>
              </section>
            ))}
          </div>
        </BoardScroller>
        {liveLine}
      </div>
    )
  }

  // ---- Plain columns. ----
  return (
    <div className="relative h-full min-h-0" onDragEnd={endDrag}>
      <BoardScroller scrollRef={scrollRef} label="Task board" contentKey={contentKey}>
        <div className="flex h-full w-max gap-3 p-1 pb-2">
          {columns.map((column) => {
            const count = totalOf(column.key)
            const zone = zoneOf(column)
            if (isCollapsed(column.key)) {
              return (
                <section
                  key={column.key}
                  aria-label={`${column.label}, collapsed`}
                  {...dropProps(column)}
                  className={`h-full w-11 shrink-0 rounded-xl border ${zoneClass(zone, hovered === column.key)}`}
                >
                  <CollapsedStrip column={column} count={count} onExpand={() => onToggleCollapse(column.key)} />
                </section>
              )
            }
            const list = visible(column.key)
            const bodyId = `col-body-${column.key}`
            return (
              <section
                key={column.key}
                aria-label={column.label}
                {...dropProps(column)}
                className={`flex h-full w-[300px] shrink-0 flex-col rounded-xl border transition ${zoneClass(zone, hovered === column.key)}`}
              >
                <ColumnHeader
                  column={column}
                  count={count}
                  shown={list.length}
                  points={pointsOf(column.key)}
                  bodyId={bodyId}
                  onCollapse={() => onToggleCollapse(column.key)}
                  selectAll={selectAllFor(column)}
                />
                <div id={bodyId} data-column-scroll className="board-scroll min-h-0 flex-1 overflow-y-auto px-2 pb-2">
                  <CardList
                    list={list}
                    empty={emptyLine(column.key, { filtered, isLead })}
                    cardProps={cardProps(column)}
                  />
                  <ColumnMore {...moreProps(column.key)} />
                </div>
              </section>
            )
          })}
        </div>
      </BoardScroller>
      {liveLine}
    </div>
  )
}
