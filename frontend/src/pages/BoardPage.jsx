import { useCallback, useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { api, isVersionConflict } from '../api/client'
import { useAuth } from '../auth/AuthContext'
import KanbanBoard from '../components/board/KanbanBoard'
import CreateTaskModal from '../components/board/CreateTaskModal'
import TaskDetailModal from '../components/board/TaskDetailModal'
import TriageBar from '../components/board/TriageBar'
import { KIND_LABELS, SIDES, SIDE_LABELS, TASK_KINDS, assignablePeople } from '../lib/constants'

const controlClass =
  'rounded-lg border border-hairline bg-surface-raised px-3 py-1.5 text-sm outline-none focus:border-series1'

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
  const [error, setError] = useState(null)
  const [notice, setNotice] = useState(null)
  // `/board?task=ID` opens that task, so links in notification emails land on it.
  const [searchParams, setSearchParams] = useSearchParams()
  const taskParam = searchParams.get('task')

  const [mine, setMine] = useState(false)
  const [side, setSide] = useState('')
  const [tagInput, setTagInput] = useState('')
  const [search, setSearch] = useState('')
  const [kind, setKind] = useState('')
  // Leads: show only what agents filed, and tick Triage cards for bulk triage.
  const [fromAgents, setFromAgents] = useState(false)
  const [picked, setPicked] = useState(() => new Set())
  const tag = useDebounced(tagInput.trim())
  const q = useDebounced(search.trim())

  // Ignore answers to filter sets the user has already moved past.
  const requestId = useRef(0)

  const load = useCallback(async () => {
    const id = ++requestId.current
    try {
      const list = await api.tasks({
        mine: mine || undefined,
        side,
        tag,
        q,
        kind,
        created_kind: fromAgents ? 'agent' : undefined,
      })
      if (id !== requestId.current) return
      setTasks(list.filter((task) => task.status !== 'dropped'))
      setError(null)
    } catch (err) {
      if (id === requestId.current) setError(err.message)
    } finally {
      if (id === requestId.current) setLoading(false)
    }
  }, [mine, side, tag, q, kind, fromAgents])

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
    try {
      setSelected(await api.task(id))
    } catch (err) {
      setError(err.message)
    }
  }

  // Open the task named in the URL, on load and whenever the param changes
  // (the header bell navigates here with it).
  useEffect(() => {
    if (!taskParam) return undefined
    const id = Number(taskParam)
    if (!Number.isInteger(id) || id <= 0) {
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
            ? `Task #${id} does not exist or you cannot see it.`
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
        setError('Someone changed this task while you were looking. The board has been reloaded; try again.')
        load()
      } else {
        setError(err.message)
      }
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

  const filtered = mine || side || tag || q || kind || fromAgents
  const programmers = assignablePeople(people)

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Team board</h1>
          <p className="mt-0.5 text-sm text-ink-secondary">
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

      <div className="mb-4 flex flex-wrap items-center gap-2" role="search">
        <label className="inline-flex items-center gap-2 rounded-lg border border-hairline px-3 py-1.5 text-sm">
          <input type="checkbox" checked={mine} onChange={(event) => setMine(event.target.checked)} />
          Mine
        </label>
        <select
          aria-label="Side"
          value={side}
          onChange={(event) => setSide(event.target.value)}
          className={controlClass}
        >
          <option value="">All sides</option>
          {SIDES.map((value) => (
            <option key={value} value={value}>
              {SIDE_LABELS[value]}
            </option>
          ))}
        </select>
        <select
          aria-label="Kind"
          value={kind}
          onChange={(event) => setKind(event.target.value)}
          className={`${controlClass} ${kind ? 'border-series1 text-series1' : ''}`}
        >
          <option value="">All kinds</option>
          {TASK_KINDS.map((value) => (
            <option key={value} value={value}>
              {KIND_LABELS[value]}
            </option>
          ))}
        </select>
        <input
          aria-label="Tag"
          placeholder="Tag"
          dir="auto"
          value={tagInput}
          onChange={(event) => setTagInput(event.target.value)}
          className={`${controlClass} w-36`}
        />
        <input
          type="search"
          aria-label="Search title, description and summary"
          placeholder="Search…"
          dir="auto"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          className={`${controlClass} w-56`}
        />
        {isLead && (
          <button
            type="button"
            aria-pressed={fromAgents}
            onClick={() => setFromAgents((v) => !v)}
            title="Only tasks an agent filed, for triage"
            className={`rounded-full border px-3 py-1 text-sm transition ${
              fromAgents
                ? 'border-series2 bg-series2/5 text-series2'
                : 'border-hairline text-ink-secondary hover:text-ink'
            }`}
          >
            From agents
          </button>
        )}
        {filtered && (
          <button
            type="button"
            onClick={() => {
              setMine(false)
              setSide('')
              setTagInput('')
              setSearch('')
              setKind('')
              setFromAgents(false)
            }}
            className="text-xs text-ink-secondary underline-offset-2 hover:text-ink hover:underline"
          >
            Clear filters
          </button>
        )}
      </div>

      {error && (
        <p role="alert" className="mb-4 rounded-lg border border-critical/40 px-3 py-2 text-sm text-critical">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="mb-4 rounded-lg border border-good/40 px-3 py-2 text-sm text-good">
          {notice}
        </p>
      )}

      {loading ? (
        <p className="text-sm text-ink-muted">Loading board…</p>
      ) : tasks.length === 0 && !filtered ? (
        <div className="rounded-xl border border-dashed border-hairline px-6 py-12 text-center">
          <p className="text-sm font-medium">No tasks yet.</p>
          <p className="mt-1 text-sm text-ink-muted">
            {isReadOnly ? 'Work will show up here once the team adds it.' : 'Create the first one to get the board moving.'}
          </p>
        </div>
      ) : (
        <>
          {isLead && (
            <TriageBar
              tasks={tasks}
              selectedIds={picked}
              programmers={programmers}
              onClear={() => setPicked(new Set())}
              onDone={handleTriaged}
            />
          )}
          <KanbanBoard
            tasks={tasks}
            user={user}
            onOpenTask={openTask}
            onMove={handleMove}
            selectedIds={picked}
            onSelect={isLead ? selectOne : null}
            onSelectMany={isLead ? selectMany : null}
          />
        </>
      )}

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
    </>
  )
}
