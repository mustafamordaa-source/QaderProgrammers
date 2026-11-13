import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { api, isVersionConflict } from '../api/client'
import { useAuth } from '../auth/AuthContext'
import KanbanBoard from '../components/board/KanbanBoard'
import CreateTaskModal from '../components/board/CreateTaskModal'
import TaskDetailModal from '../components/board/TaskDetailModal'
import TriageBar from '../components/board/TriageBar'
import BoardFilters from '../components/board/BoardFilters'
import BoardSkeleton from '../components/board/BoardSkeleton'
import { useBoardPrefs, useFillHeight, useMediaQuery } from '../components/board/useBoardPrefs'
import { assignablePeople, parseTaskRef, taskKey } from '../lib/constants'

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
  const [tasks, setTasks] = useState([])
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
  const [openParts, setOpenParts] = useState(false)
  const mySides = user?.sides ?? []
  // Leads: show only what agents filed, and tick Triage cards for bulk triage.
  const [fromAgents, setFromAgents] = useState(false)
  const [picked, setPicked] = useState(() => new Set())
  const tag = useDebounced(tagInput.trim())
  const q = useDebounced(search.trim())

  // Ignore answers to filter sets the user has already moved past.
  const requestId = useRef(0)

  const load = useCallback(async () => {
    const id = ++requestId.current
    setRefreshing(true)
    try {
      const list = await api.tasks({
        mine: mine || undefined,
        side,
        tag,
        q,
        kind,
        created_kind: fromAgents ? 'agent' : undefined,
        // Pool parts waiting in To do on a side in the user's "Works on".
        ...(openParts ? { pool: true, my_sides: true, status_filter: 'to_do' } : {}),
      })
      if (id !== requestId.current) return
      setTasks(list.filter((task) => task.status !== 'dropped'))
      setError(null)
    } catch (err) {
      if (id === requestId.current) setError(err.message)
    } finally {
      if (id === requestId.current) {
        setLoading(false)
        setRefreshing(false)
      }
    }
  }, [mine, side, tag, q, kind, openParts, fromAgents])

  useEffect(() => {
    load()
  }, [load])

  useEffect(() => {
    api.directory().then(setPeople).catch(() => setPeople([]))
  }, [])

  function applyUpdate(updated) {
    setTasks((current) => {
      const rest = current.filter((task) => task.id !== updated.id)
      if (updated.status === 'dropped') return rest
      const exists = rest.length !== current.length
      return exists
        ? current.map((task) => (task.id === updated.id ? updated : task))
        : [updated, ...current]
    })
    setSelected((current) => (current?.id === updated.id ? updated : current))
  }

  // Another task the open detail changed. A new subtask joins the board; an
  // existing task's card refreshes only when the board already shows it, so
  // the filters keep holding.
  function applyOther(updated, { created = false } = {}) {
    if (created) {
      applyUpdate(updated)
      return
    }
    setTasks((current) =>
      current.some((task) => task.id === updated.id)
        ? current.map((task) => (task.id === updated.id ? updated : task))
        : current,
    )
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
    applyUpdate(created)
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

  const filtered = mine || side || tag || q || kind || openParts || fromAgents
  const activeCount = [mine, side, tagInput.trim(), search.trim(), kind, openParts, fromAgents].filter(Boolean).length
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
    setOpenParts(false)
    setFromAgents(false)
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
        values={{ search, mine, side, tagInput, kind, fromAgents, openParts }}
        set={{ search: setSearch, mine: setMine, side: setSide, tagInput: setTagInput, kind: setKind, fromAgents: setFromAgents, openParts: setOpenParts }}
        onClear={clearFilters}
        activeCount={activeCount}
        resultCount={tasks.length}
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
