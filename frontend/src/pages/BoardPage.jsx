import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { PAGE_SIZE, api, isVersionConflict } from '../api/client'
import { useAuth } from '../auth/AuthContext'
import KanbanBoard from '../components/board/KanbanBoard'
import CreateTaskModal from '../components/board/CreateTaskModal'
import TaskDetailModal from '../components/board/TaskDetailModal'
import TriageBar from '../components/board/TriageBar'
import BoardFilters from '../components/board/BoardFilters'
import BoardSkeleton from '../components/board/BoardSkeleton'
import {
  hasFilters,
  useBoardFilters,
  useBoardPrefs,
  useFillHeight,
  useMediaQuery,
} from '../components/board/useBoardPrefs'
import { BOARD_COLUMNS, assignablePeople, parseTaskRef, taskKey } from '../lib/constants'

const columnOf = (status) => BOARD_COLUMNS.find((column) => column.statuses.includes(status))?.key ?? null
const EMPTY_BOARD = { tasks: [], columns: {} }
const EMPTY_PAGE = { items: [], total: 0, points: 0 }
// "Free to take" lists To do (lane planned) and Backlog only.
const READY_STATUSES = ['to_do', 'backlog']
const LANE_STATUS = { planned: 'to_do', backlog: 'backlog' }

/** The statuses one column asks for under the current filters; empty skips the column. */
function columnStatuses(column, filters) {
  return column.statuses.filter(
    (status) =>
      (filters.status.length === 0 || filters.status.includes(status)) &&
      (!filters.ready || READY_STATUSES.includes(status)) &&
      (!filters.lane || LANE_STATUS[filters.lane] === status),
  )
}

/** Wait until the value stops changing, so typing does not fire a request per key. */
function useDebounced(value, delay = 300) {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay)
    return () => clearTimeout(timer)
  }, [value, delay])
  return debounced
}

export default function BoardPage() {
  const { user, isLead, isReadOnly } = useAuth()
  // The cards loaded so far, plus per column: `total` and `points` for every
  // task that matches the filters (from the server), and `served`, the rows the
  // server has handed over, which says which page comes next.
  const [board, setBoard] = useState(EMPTY_BOARD)
  const tasks = board.tasks
  const [people, setPeople] = useState([])
  const [selected, setSelected] = useState(null)
  // A message to show at the top of the next task opened (a duplicate create).
  const [selectedNotice, setSelectedNotice] = useState(null)
  const [creating, setCreating] = useState(false)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [claimingId, setClaimingId] = useState(null)
  const [error, setError] = useState(null)
  const [notice, setNotice] = useState(null)
  // `/board?task=ID` opens that task, so links in notification emails land on it.
  const [searchParams, setSearchParams] = useSearchParams()
  const taskParam = searchParams.get('task')
  // The task openTask loaded itself, so the URL effect does not load it twice.
  const openedFromBoard = useRef(null)

  // Every filter lives in the query string (`/board?ready=1&side=fe`), so a
  // filtered board is a link to share. `/board?area=payments` (the Areas page)
  // still opens the board on one area.
  const { filters, update: updateFilters, replace: replaceFilters } = useBoardFilters()
  // The search box types freely; the URL (and the request) follow 300 ms later.
  const [search, setSearch] = useState(filters.q)
  const typed = useDebounced(search.trim())
  const lastQ = useRef(filters.q)
  useEffect(() => {
    // The URL changed from outside the box (a view, Clear all, Back): show it.
    if (filters.q !== lastQ.current) {
      lastQ.current = filters.q
      setSearch(filters.q)
    }
  }, [filters.q])
  // setSearchParams changes with every URL change, so the writer reads it from a
  // ref: only a new debounced value may write, never a URL change alone.
  const updateRef = useRef(updateFilters)
  updateRef.current = updateFilters
  useEffect(() => {
    if (typed !== lastQ.current) {
      lastQ.current = typed
      updateRef.current({ q: typed })
    }
  }, [typed])
  // Leads tick Triage cards for bulk triage.
  const [picked, setPicked] = useState(() => new Set())

  // Ignore answers to filter sets the user has already moved past.
  const requestId = useRef(0)

  const columns = useMemo(() => BOARD_COLUMNS.filter((column) => !column.leadOnly || isLead), [isLead])
  // Every filter goes to the server, so each column can be read a page at a time.
  const apiFilters = useMemo(
    () => ({
      mine: filters.mine || undefined,
      ready: filters.ready || undefined,
      lane: filters.lane || undefined,
      side: filters.side,
      tag: filters.tag,
      q: filters.q,
      area: filters.area,
      kinds: filters.kind,
      priority: filters.priority,
      audience: filters.audience,
      subtasks: filters.subtasks === 'all' ? undefined : filters.subtasks,
      created_kind: filters.agents && isLead ? 'agent' : undefined,
      awaiting_decision: filters.decision || undefined,
      to: filters.decision && isLead ? 'leads' : undefined,
      // Impact (students first) is the server's default, so it goes unsent.
      sort: filters.sort !== 'impact' ? filters.sort : undefined,
      order: filters.order || undefined,
    }),
    [filters, isLead],
  )
  // The same filters for the menu counts (/tasks/facets), status included.
  const facetParams = useMemo(
    () => ({ ...apiFilters, statuses: filters.status.length ? filters.status.join(',') : undefined }),
    [apiFilters, filters.status],
  )

  const fetchColumn = useCallback(
    (column, pageNumber) => {
      const statuses = columnStatuses(column, filters)
      // A status filter, Free to take or a lane leaves some columns empty.
      if (statuses.length === 0) return Promise.resolve(EMPTY_PAGE)
      return api.tasksPage(
        {
          ...apiFilters,
          statuses: statuses.join(','),
          // Done shows the latest changes first unless someone picked a sort.
          ...(column.key === 'done' && filters.sort === 'impact' && !filters.order
            ? { sort: 'updated' }
            : {}),
        },
        pageNumber,
      )
    },
    [apiFilters, filters],
  )

  // The first 20 cards of every column. Changing a filter or the search starts over.
  const load = useCallback(async () => {
    const id = ++requestId.current
    setRefreshing(true)
    try {
      const pages = await Promise.all(columns.map((column) => fetchColumn(column, 1)))
      if (id !== requestId.current) return
      const next = { tasks: [], columns: {} }
      columns.forEach((column, index) => {
        const page = pages[index]
        next.tasks.push(...page.items)
        next.columns[column.key] = {
          total: page.total,
          points: page.points ?? 0,
          served: page.items.length,
          loading: false,
          ended: false,
        }
      })
      setBoard(next)
      setError(null)
    } catch (err) {
      if (id === requestId.current) setError(err.message)
    } finally {
      if (id === requestId.current) {
        setLoading(false)
        setRefreshing(false)
      }
    }
  }, [columns, fetchColumn])

  useEffect(() => {
    load()
  }, [load])

  // Columns with a request for more cards in flight.
  const loadingMore = useRef(new Set())

  /** The next 20 cards of one column (the user scrolled near its end). */
  const loadMore = useCallback(
    async (key) => {
      const column = columns.find((c) => c.key === key)
      const meta = board.columns[key]
      if (!column || !meta || meta.ended || meta.served >= meta.total || loadingMore.current.has(key)) return
      const id = requestId.current
      loadingMore.current.add(key)
      setBoard((current) => ({
        ...current,
        columns: { ...current.columns, [key]: { ...current.columns[key], loading: true } },
      }))
      const pageNumber = Math.floor(meta.served / PAGE_SIZE) + 1
      try {
        const page = await fetchColumn(column, pageNumber)
        if (id !== requestId.current) return
        setBoard((current) => {
          const seen = new Set(current.tasks.map((task) => task.id))
          const fresh = page.items.filter((task) => !seen.has(task.id))
          const served = (pageNumber - 1) * PAGE_SIZE + page.items.length
          return {
            tasks: fresh.length ? [...current.tasks, ...fresh] : current.tasks,
            columns: {
              ...current.columns,
              [key]: {
                total: page.total,
                points: page.points ?? current.columns[key]?.points ?? 0,
                served,
                loading: false,
                // An empty page is the end, whatever the count says.
                ended: page.items.length === 0,
              },
            },
          }
        })
      } catch (err) {
        if (id !== requestId.current) return
        setError(err.message)
        setBoard((current) => ({
          ...current,
          columns: { ...current.columns, [key]: { ...current.columns[key], loading: false, ended: true } },
        }))
      } finally {
        loadingMore.current.delete(key)
      }
    },
    [board.columns, columns, fetchColumn],
  )

  useEffect(() => {
    api.directory().then(setPeople).catch(() => setPeople([]))
  }, [])

  // The task as the open detail last showed it, for a task the board has not loaded.
  const selectedRef = useRef(null)
  selectedRef.current = selected

  /**
   * Put a changed (or, with `created`, a new) task on the board. A card that
   * changes column moves, and both columns' counts and points follow.
   */
  function applyUpdate(updated, { created = false } = {}) {
    const open = selectedRef.current?.id === updated.id ? selectedRef.current : null
    setBoard((current) => {
      const loaded = current.tasks.find((task) => task.id === updated.id) ?? null
      const before = loaded ?? open
      const from = before ? columnOf(before.status) : null
      const to = columnOf(updated.status) // null: dropped tasks leave the board
      let nextTasks
      if (!to) nextTasks = current.tasks.filter((task) => task.id !== updated.id)
      else if (loaded) nextTasks = current.tasks.map((task) => (task.id === updated.id ? updated : task))
      else nextTasks = [updated, ...current.tasks]

      const nextColumns = { ...current.columns }
      const bump = (key, count, points, served = 0) => {
        const meta = nextColumns[key]
        if (!key || !meta) return
        nextColumns[key] = {
          ...meta,
          total: Math.max(0, meta.total + count),
          points: Math.max(0, meta.points + points),
          served: Math.max(0, meta.served + served),
        }
      }
      const pointsOf = (task) => Number(task?.points) || 0
      if (before && from !== to) {
        // One row fewer on the server for the old column: step its page pointer back.
        bump(from, -1, -pointsOf(before), loaded ? -1 : 0)
        bump(to, 1, pointsOf(updated))
      } else if (before) {
        bump(to, 0, pointsOf(updated) - pointsOf(before))
      } else if (created) {
        bump(to, 1, pointsOf(updated))
      }
      return { tasks: nextTasks, columns: nextColumns }
    })
    setSelected((current) => (current?.id === updated.id ? updated : current))
  }

  // Another task the open detail changed. A new subtask joins the board; an
  // existing task's card refreshes only when the board already shows it, so
  // the filters keep holding.
  function applyOther(updated, { created = false } = {}) {
    if (created) {
      applyUpdate(updated, { created: true })
      return
    }
    if (tasks.some((task) => task.id === updated.id)) applyUpdate(updated)
  }

  /** Open a task from a card (a list row) or by ID from inside another task. */
  async function openTask(taskOrId, message = null) {
    const id = typeof taskOrId === 'number' ? taskOrId : taskOrId.id
    setSelectedNotice(message)
    // The list payload omits comments, criteria, links and events. By ID, the
    // current task stays up until the new one arrives, unless the board has it.
    const quick = typeof taskOrId === 'number' ? tasks.find((t) => t.id === id) : taskOrId
    if (quick) setSelected(quick)
    // Put the task in the URL, so the address bar is a link to share and Back closes it.
    openedFromBoard.current = id
    if (Number(searchParams.get('task')) !== id) {
      setSearchParams((params) => {
        params.set('task', String(id))
        return params
      })
    }
    try {
      setSelected(await api.task(id))
    } catch (err) {
      setError(err.message)
    }
  }

  // Open the task named in the URL, on load and whenever the param changes
  // (the header bell navigates here with it).
  useEffect(() => {
    if (!taskParam) {
      // Back (or a link without a task) closes the dialog.
      openedFromBoard.current = null
      setSelected(null)
      setSelectedNotice(null)
      return undefined
    }
    const id = parseTaskRef(taskParam)
    // openTask already loaded it; the URL only caught up.
    if (id !== null && openedFromBoard.current === id) return undefined
    if (id === null) {
      setSearchParams((params) => {
        params.delete('task')
        return params
      }, { replace: true })
      return undefined
    }
    let cancelled = false
    api
      .task(id)
      .then((task) => {
        if (!cancelled) setSelected(task)
      })
      .catch((err) => {
        if (cancelled) return
        setError(
          err.status === 404 || err.status === 403
            ? `Task ${taskKey(id)} does not exist or you cannot see it.`
            : err.message,
        )
        setSearchParams((params) => {
          params.delete('task')
          return params
        }, { replace: true })
      })
    return () => {
      cancelled = true
    }
  }, [taskParam, setSearchParams])

  function closeTask() {
    setSelected(null)
    setSelectedNotice(null)
    if (searchParams.has('task')) {
      setSearchParams((params) => {
        params.delete('task')
        return params
      }, { replace: true })
    }
  }

  async function handleMove(task, status) {
    setNotice(null)
    try {
      applyUpdate(await api.changeStatus(task.id, { status, expectedVersion: task.version }))
    } catch (err) {
      if (isVersionConflict(err)) {
        // Reload first: a successful load clears errors, and this one must stay.
        await load()
        setError('Someone changed this task while you were looking. The board has been reloaded; try again.')
      } else {
        setError(err.message)
      }
    }
  }

  // The card's quick Claim: a claim with no branch, like the detail panel's.
  // With `crossSideReason` (Take across sides) a refusal goes back to the card's
  // dialog instead of the page banner.
  async function handleClaim(task, { crossSideReason = null } = {}) {
    setNotice(null)
    setClaimingId(task.id)
    try {
      const payload = { branch: null }
      if (crossSideReason) payload.cross_side_reason = crossSideReason
      const result = await api.claim(task.id, payload)
      applyUpdate(result)
      setNotice(
        result?.warnings?.length
          ? `You took ${taskKey(task.id)}, with warnings: ${result.warnings.join(' ')}`
          : `You took ${taskKey(task.id)}. It is in progress and yours now.`,
      )
    } catch (err) {
      if (isVersionConflict(err)) await load()
      if (crossSideReason) throw err
      setError(`Could not take ${taskKey(task.id)}: ${err.message}`)
    } finally {
      setClaimingId(null)
    }
  }

  async function handleCreate(payload) {
    const created = await api.createTask(payload)
    if (created.duplicate_of_existing) {
      // A fingerprint matched an open task: the server noted it there instead.
      applyOther(created)
      setSelectedNotice(`An open task already covers this: #${created.id}. It is open now instead of a new one.`)
      setSelected(created)
      return created
    }
    applyUpdate(created, { created: true })
    if (!isLead) {
      setNotice(`Task #${created.id} is in the backlog. A lead will triage it.`)
    }
    return created
  }

  // Keep only ticks on tasks still waiting in Triage.
  useEffect(() => {
    setPicked((current) => {
      const waiting = new Set(tasks.filter((t) => t.status === 'proposed').map((t) => t.id))
      const next = new Set([...current].filter((id) => waiting.has(id)))
      return next.size === current.size ? current : next
    })
  }, [tasks])

  function selectOne(task, on) {
    setPicked((current) => {
      const next = new Set(current)
      if (on) next.add(task.id)
      else next.delete(task.id)
      return next
    })
  }

  function selectMany(list, on) {
    setPicked((current) => {
      const next = new Set(current)
      for (const task of list) {
        if (on) next.add(task.id)
        else next.delete(task.id)
      }
      return next
    })
  }

  async function handleTriaged(okIds) {
    setPicked((current) => new Set([...current].filter((id) => !okIds.includes(id))))
    await load()
  }

  const filtered = hasFilters(filters)
  // Every task that matches, loaded or not.
  const matchCount = columns.reduce(
    (sum, column) => sum + Math.max(board.columns[column.key]?.total ?? 0, 0),
    0,
  )
  const programmers = assignablePeople(people)

  const prefs = useBoardPrefs()
  const isMobile = useMediaQuery('(max-width: 767px)')
  // The board area reaches the bottom of the window, so its sideways scrollbar
  // is always on screen instead of below the tallest column.
  const boardRef = useRef(null)
  const boardHeight = useFillHeight(boardRef)

  const dismiss = 'ms-auto shrink-0 rounded px-1 text-xs opacity-70 hover:opacity-100'
  const pageAbout = isLead
    ? 'Every task across the team. Leads triage, approve and drop work.'
    : isReadOnly
      ? 'Read-only view of the team’s work.'
      : 'The team’s work. You can move tasks assigned to you and open tasks you claimed.'

  return (
    <div className="flex flex-col gap-2">
      <BoardFilters
        filters={filters}
        update={updateFilters}
        replace={replaceFilters}
        search={search}
        onSearch={setSearch}
        facetParams={facetParams}
        resultCount={Math.max(matchCount, tasks.length)}
        refreshing={refreshing && !loading}
        isLead={isLead}
        isReadOnly={isReadOnly}
        groupBy={prefs.groupBy}
        onGroupBy={prefs.setGroupBy}
        density={prefs.density}
        onDensity={prefs.setDensity}
        isMobile={isMobile}
        filtersSeen={prefs.filtersSeen}
        onFiltersSeen={prefs.markFiltersSeen}
        title={
          <h1
            title={pageAbout}
            className="sr-only text-base font-semibold tracking-tight sm:not-sr-only sm:me-1 sm:whitespace-nowrap"
          >
            Team board
          </h1>
        }
        action={
          !isReadOnly && (
            <button
              type="button"
              onClick={() => setCreating(true)}
              className="h-8 whitespace-nowrap rounded-lg bg-series1 px-3 text-sm font-medium text-white transition hover:opacity-90"
            >
              <span aria-hidden="true" className="sm:hidden">+ New</span>
              <span className="sr-only sm:not-sr-only">Create task</span>
            </button>
          )
        }
      />

      {error && (
        <p role="alert" dir="auto" className="flex items-start gap-2 rounded-lg border border-critical/40 px-3 py-1.5 text-sm text-critical">
          <span>{error}</span>
          <button type="button" onClick={() => setError(null)} aria-label="Dismiss message" className={dismiss}>
            ✕
          </button>
        </p>
      )}
      {notice && (
        <p role="status" dir="auto" className="flex items-start gap-2 rounded-lg border border-good/40 px-3 py-1.5 text-sm text-good">
          <span>{notice}</span>
          <button type="button" onClick={() => setNotice(null)} aria-label="Dismiss message" className={dismiss}>
            ✕
          </button>
        </p>
      )}

      {isLead && !loading && (
        <TriageBar
          tasks={tasks}
          selectedIds={picked}
          programmers={programmers}
          onClear={() => setPicked(new Set())}
          onDone={handleTriaged}
        />
      )}

      <div
        ref={boardRef}
        style={boardHeight ? { height: boardHeight } : undefined}
        className={`min-h-0 ${boardHeight ? '' : 'h-[calc(100dvh-14rem)]'}`}
      >
        {loading ? (
          <BoardSkeleton columns={isMobile ? 1 : 6} />
        ) : tasks.length === 0 && !filtered ? (
          <div className="rounded-xl border border-dashed border-hairline px-6 py-12 text-center">
            <p className="text-sm font-medium">No tasks yet.</p>
            <p className="mt-1 text-sm text-ink-muted">
              {isReadOnly ? 'Work will show up here once the team adds it.' : 'Create the first one to get the board moving.'}
            </p>
            <Link to="/guide" className="mt-3 inline-block text-sm text-series1 hover:underline">
              New here? Read the guide.
            </Link>
          </div>
        ) : (
          <KanbanBoard
            tasks={tasks}
            columnMeta={board.columns}
            onLoadMore={loadMore}
            user={user}
            filtered={Boolean(filtered)}
            density={prefs.density}
            groupBy={prefs.groupBy}
            collapsed={prefs.collapsed}
            onToggleCollapse={prefs.toggleCollapsed}
            isMobile={isMobile}
            onOpenTask={openTask}
            onMove={handleMove}
            onClaim={isReadOnly ? null : handleClaim}
            claimingId={claimingId}
            showLane={filters.ready}
            selectedIds={picked}
            onSelect={isLead ? selectOne : null}
            onSelectMany={isLead ? selectMany : null}
          />
        )}
      </div>

      {creating && (
        <CreateTaskModal
          isLead={isLead}
          programmers={programmers}
          onClose={() => setCreating(false)}
          onCreate={handleCreate}
        />
      )}

      {selected && (
        <TaskDetailModal
          key={selected.id}
          task={selected}
          user={user}
          people={people}
          onClose={closeTask}
          onChanged={applyUpdate}
          onOpenTask={openTask}
          onOtherChanged={(other) => applyOther(other, { created: other.parent_id === selected.id })}
          initialNotice={selectedNotice}
        />
      )}
    </div>
  )
}
