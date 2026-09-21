import { useCallback, useEffect, useState } from 'react'
import { api } from '../api/client'
import { useAuth } from '../auth/AuthContext'
import KanbanBoard from '../components/board/KanbanBoard'
import CreateTaskModal from '../components/board/CreateTaskModal'
import TaskDetailModal from '../components/board/TaskDetailModal'

export default function BoardPage() {
  const { user, isLeader } = useAuth()
  const [tasks, setTasks] = useState([])
  const [programmers, setProgrammers] = useState([])
  const [selected, setSelected] = useState(null)
  const [creating, setCreating] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const load = useCallback(async () => {
    try {
      const list = await api.tasks()
      setTasks(list)
      setError(null)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  useEffect(() => {
    if (!isLeader) return
    api.programmers().then(setProgrammers).catch(() => setProgrammers([]))
  }, [isLeader])

  function applyUpdate(updated) {
    setTasks((current) => current.map((task) => (task.id === updated.id ? updated : task)))
    setSelected((current) => (current?.id === updated.id ? updated : current))
  }

  async function openTask(task) {
    // The list payload omits the event log; fetch the detail view for the trail.
    setSelected(task)
    try {
      setSelected(await api.task(task.id))
    } catch (err) {
      setError(err.message)
    }
  }

  async function handleMove(task, status) {
    const updated = await api.changeStatus(task.id, status)
    applyUpdate(updated)
  }

  async function handleReject(task, toStatus, comment) {
    const updated = await api.reject(task.id, toStatus, comment)
    applyUpdate(updated)
  }

  async function handleReestimate(task, points) {
    applyUpdate(await api.updateTask(task.id, { points }))
  }

  async function handleCreate(payload) {
    const created = await api.createTask(payload)
    setTasks((current) => [created, ...current])
  }

  return (
    <>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">
            {isLeader ? 'Team board' : 'My tasks'}
          </h1>
          <p className="mt-0.5 text-sm text-ink-secondary">
            {isLeader
              ? 'Every task across the team. Only you can approve work out of review.'
              : `${tasks.length} task${tasks.length === 1 ? '' : 's'} assigned to you.`}
          </p>
        </div>

        {isLeader && (
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="rounded-lg bg-series1 px-4 py-2 text-sm font-medium text-white transition hover:opacity-90"
          >
            Create task
          </button>
        )}
      </div>

      {error && (
        <p role="alert" className="mb-4 rounded-lg border border-critical/40 px-3 py-2 text-sm text-critical">
          {error}
        </p>
      )}

      {loading ? (
        <p className="text-sm text-ink-muted">Loading board…</p>
      ) : tasks.length === 0 ? (
        <div className="rounded-xl border border-dashed border-hairline px-6 py-12 text-center">
          <p className="text-sm font-medium">
            {isLeader ? 'No tasks yet.' : 'Nothing assigned to you right now.'}
          </p>
          <p className="mt-1 text-sm text-ink-muted">
            {isLeader
              ? 'Create the first one to get the board moving.'
              : 'Your team leader will assign work here.'}
          </p>
        </div>
      ) : (
        <KanbanBoard
          tasks={tasks}
          role={user.role}
          onOpenTask={openTask}
          onMove={(task, status) => handleMove(task, status).catch((err) => setError(err.message))}
        />
      )}

      {creating && (
        <CreateTaskModal
          programmers={programmers}
          onClose={() => setCreating(false)}
          onCreate={handleCreate}
        />
      )}

      {selected && (
        <TaskDetailModal
          task={selected}
          role={user.role}
          onClose={() => setSelected(null)}
          onMove={handleMove}
          onReject={handleReject}
          onReestimate={handleReestimate}
        />
      )}
    </>
  )
}
