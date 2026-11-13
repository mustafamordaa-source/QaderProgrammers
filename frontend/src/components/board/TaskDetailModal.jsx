import { useState } from 'react'
import Modal from '../Modal'
import { api, isVersionConflict } from '../../api/client'
import {
  DeployBadge,
  OverdueBadge,
  PointsBadge,
  PriorityBadge,
  SideBadge,
  StatusBadge,
} from '../Badges'
import { isClosed, isWorkerOn } from '../../lib/constants'
import { isOverdue } from '../../lib/format'
import StatusActions from './detail/StatusActions'
import OverviewTab from './detail/OverviewTab'
import CriteriaTab from './detail/CriteriaTab'
import DiscussionTab from './detail/DiscussionTab'
import GitTab from './detail/GitTab'
import HistoryTab from './detail/HistoryTab'

const TABS = [
  { key: 'overview', label: 'Overview' },
  { key: 'criteria', label: 'Criteria' },
  { key: 'discussion', label: 'Discussion' },
  { key: 'git', label: 'Git' },
  { key: 'history', label: 'History' },
]

const CONFLICT_MESSAGE =
  'Someone changed this task while you were looking. It has been reloaded; check it and try again.'

/**
 * The full task view. Every write goes through `run`, which reloads the task
 * when the server answers 409 for a stale version, so the user always ends
 * up looking at the current state.
 */
export default function TaskDetailModal({ task, user, people, onClose, onChanged }) {
  const [tab, setTab] = useState('overview')
  const [error, setError] = useState(null)
  const [notice, setNotice] = useState(null)
  const [busy, setBusy] = useState(false)

  const isLeader = user.role === 'leader'
  const isViewer = user.role === 'viewer'
  const isWorker = isWorkerOn(task, user)
  const closed = isClosed(task.status)

  async function reload() {
    onChanged(await api.task(task.id))
  }

  /** Run a write. Returns true when it succeeded. */
  async function run(action, { reloadAfter = false, success = null } = {}) {
    setError(null)
    setNotice(null)
    setBusy(true)
    try {
      const updated = await action()
      if (reloadAfter) await reload()
      else if (updated && updated.id === task.id && 'status' in updated) onChanged(updated)
      if (success) setNotice(typeof success === 'function' ? success(updated) : success)
      return true
    } catch (err) {
      if (isVersionConflict(err)) {
        setError(CONFLICT_MESSAGE)
        try {
          await reload()
        } catch {
          // The message above already tells the user to look again.
        }
      } else {
        setError(err.message)
      }
      return false
    } finally {
      setBusy(false)
    }
  }

  const comments = task.comments ?? []
  const criteria = task.criteria ?? []
  const gitLinks = task.git_links ?? []
  const counts = {
    criteria: task.criteria_total ?? criteria.length,
    discussion: comments.length,
    git: gitLinks.length,
    history: task.events?.length ?? 0,
  }

  const ctx = { task, user, people, isLeader, isViewer, isWorker, closed, busy, run }

  return (
    <Modal title={`Task #${task.id}`} onClose={onClose} size="xl">
      <h3 dir="auto" className="break-words text-lg font-semibold leading-snug">
        {task.title}
      </h3>

      <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
        <StatusBadge status={task.status} />
        <SideBadge side={task.side} />
        <PointsBadge points={task.points} withLabel />
        <PriorityBadge priority={task.priority} />
        <DeployBadge state={task.deploy_state} hideNone />
        {isOverdue(task.due_date, task.status) && <OverdueBadge />}
        {task.restricted && (
          <span className="rounded-full border border-critical/30 px-2 py-0.5 text-[11px] text-ink-secondary">
            Restricted
          </span>
        )}
        {task.pool && (
          <span className="rounded-full border border-hairline px-2 py-0.5 text-[11px] text-ink-secondary">
            Pool
          </span>
        )}
        <span className="tabular ml-auto text-[11px] text-ink-muted">Version {task.version}</span>
      </div>

      <StatusActions ctx={ctx} />

      {error && (
        <p role="alert" dir="auto" className="mt-4 rounded-lg border border-critical/40 px-3 py-2 text-sm text-critical">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" dir="auto" className="mt-4 whitespace-pre-wrap rounded-lg border border-warning/50 px-3 py-2 text-sm text-ink-secondary">
          {notice}
        </p>
      )}

      <div role="tablist" aria-label="Task sections" className="mt-5 flex flex-wrap gap-1 border-b border-hairline">
        {TABS.map(({ key, label }) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            onClick={() => setTab(key)}
            className={`-mb-px border-b-2 px-3 py-2 text-sm transition ${
              tab === key
                ? 'border-series1 font-medium text-ink'
                : 'border-transparent text-ink-secondary hover:text-ink'
            }`}
          >
            {label}
            {counts[key] > 0 && (
              <span className="tabular ml-1.5 text-xs text-ink-muted">{counts[key]}</span>
            )}
          </button>
        ))}
      </div>

      <div role="tabpanel" className="pt-4">
        {tab === 'overview' && <OverviewTab ctx={ctx} />}
        {tab === 'criteria' && <CriteriaTab ctx={ctx} criteria={criteria} />}
        {tab === 'discussion' && <DiscussionTab ctx={ctx} comments={comments} />}
        {tab === 'git' && <GitTab ctx={ctx} links={gitLinks} />}
        {tab === 'history' && <HistoryTab events={task.events ?? []} people={people} />}
      </div>
    </Modal>
  )
}
