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
import { useBoardPrefs, useFillHeight, useMediaQuery } from '../components/board/useBoardPrefs'
import { BOARD_COLUMNS, assignablePeople, parseTaskRef, taskKey } from '../lib/constants'

const columnOf = (status) => BOARD_COLUMNS.find((column) => column.statuses.includes(status))?.key ?? null
const EMPTY_BOARD = { tasks: [], columns: {} }

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

  const [mine, setMine] = useState(false)
  const [side, setSide] = useState('')
  const [tagInput, setTagInput] = useState('')
  const [search, setSearch] = useState('')
  const [kind, setKind] = useState('')
  // `/board?area=payments` opens the board on one area (the Areas page links here).
  const [area, setArea] = useState(() => new URLSearchParams(window.location.search).get('area') ?? '')
  const [openParts, setOpenParts] = useState(false)
  const mySides = user?.sides ?? []
  // Leads: show only what agents filed, and tick Triage cards for bulk triage.
  const [fromAgents, setFromAgents] = useState(false)
  // Tasks with an open question to you (for a lead: to any lead).
  const [decisions, setDecisions] = useState(false)
  const [picked, setPicked] = useState(() => new Set())
  const tag = useDebounced(tagInput.trim())
  const q = useDebounced(search.trim())

  // Ignore answers to filter sets the user has already moved past.
  const requestId = useRef(0)

  const columns = useMemo(() => BOARD_COLUMNS.filter((column) => !column.leadOnly || isLead), [isLead])
  // Every filter goes to the server, so each column can be read a page at a time.
  const filters = useMemo(
    () => ({
      mine: mine || undefined,
      side,
      tag,
      q,
      kind,
      area,
      created_kind: fromAgents ? 'agent' : undefined,
      awaiting_decision: decisions || undefined,
      to: decisions && isLead ? 'leads' : undefined,
      // Pool parts waiting in To do on a side in the user's "Works on".
      ...(openParts ? { pool: true, my_sides: true } : {}),
    }),
    [mine, side, tag, q, kind, area, openParts, fromAgents, decisions, isLead],
  )

  const fetchColumn = useCallback(
    (column, pageNumber) => {
      // "Open parts" only ever shows To do.
      if (openParts && column.key !== 'to_do') {
        return Promise.resolve({ items: [], total: 0, points: 0 })
      }
      return api.tasksPage(
        {
          ...filters,
          statuses: column.statuses.join(','),
          // Done shows the latest changes first.
          sort: column.key === 'done' ? 'updated' : undefined,
        },
        pageNumber,
      )
    },
    [filters, openParts],
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
  async function handleClaim(task) {
    setNotice(null)
    setClaimingId(task.id)
    try {
      const result = await api.claim(task.id, { branch: null })
      applyUpdate(result)
      setNotice(
        result?.warnings?.length
          ? `Claimed #${task.id}, with warnings: ${result.warnings.join(' ')}`
          : `You hold the claim on #${task.id} now.`,
      )
    } catch (err) {
      if (isVersionConflict(err)) await load()
      setError(err.message)
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

  const filtered = mine || side || tag || q || kind || area || openParts || fromAgents || decisions
  const activeCount = [mine, side, tagInput.trim(), search.trim(), kind, area, openParts, fromAgents, decisions].filter(Boolean).length
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

  function clearFilters() {
    setMine(false)
    setSide('')
    setTagInput('')
    setSearch('')
    setKind('')
    setArea('')
    setOpenParts(false)
    setFromAgents(false)
    setDecisions(false)
  }

  const dismiss = 'ms-auto shrink-0 rounded px-1 text-xs opacity-70 hover:opacity-100'

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight">Team board</h1>
          <p className="mt-0.5 hidden text-sm text-ink-secondary sm:block">
            {isLead
              ? 'Every task across the team. Leads triage, approve and drop work.'
              : isReadOnly
                ? 'Read-only view of the team’s work.'
                : 'The team’s work. You can move tasks assigned to you and pool tasks you claimed.'}
          </p>
        </div>

        {!isReadOnly && (
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="rounded-lg bg-series1 px-4 py-2 text-sm font-medium text-white transition hover:opacity-90"
          >
            Create task
          </button>
        )}
      </div>

      <BoardFilters
        values={{ search, mine, side, tagInput, kind, fromAgents, openParts, area, decisions }}
        set={{ search: setSearch, mine: setMine, side: setSide, tagInput: setTagInput, kind: setKind, fromAgents: setFromAgents, openParts: setOpenParts, area: setArea, decisions: setDecisions }}
        onClear={clearFilters}
        activeCount={activeCount}
        resultCount={Math.max(matchCount, tasks.length)}
        refreshing={refreshing && !loading}
        isLead={isLead}
        isReadOnly={isReadOnly}
        mySides={mySides}
        groupBy={prefs.groupBy}
        onGroupBy={prefs.setGroupBy}
        density={prefs.density}
        onDensity={prefs.setDensity}
      />

      {error && (
        <p role="alert" dir="auto" className="flex items-start gap-2 rounded-lg border border-critical/40 px-3 py-2 text-sm text-critical">
          <span>{error}</span>
          <button type="button" onClick={() => setError(null)} aria-label="Dismiss message" className={dismiss}>
            ✕
          </button>
        </p>
      )}
      {notice && (
        <p role="status" dir="auto" className="flex items-start gap-2 rounded-lg border border-good/40 px-3 py-2 text-sm text-good">
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
