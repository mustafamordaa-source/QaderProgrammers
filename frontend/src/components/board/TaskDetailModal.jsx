import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import Modal from '../Modal'
import { api, isVersionConflict } from '../../api/client'
import {
  BlockedBadge,
  DeployBadge,
  KindBadge,
  OverdueBadge,
  PointsBadge,
  PriorityBadge,
  SideBadge,
  StatusBadge,
} from '../Badges'
import {
  assignablePeople,
  hasLeadRights,
  isClosed,
  isReadOnlyUser,
  isWorkerOn,
  taskKey,
  taskLink,
} from '../../lib/constants'
import { isOverdue } from '../../lib/format'
import CreateTaskModal from './CreateTaskModal'
import StatusActions from './detail/StatusActions'
import LinksTab from './detail/LinksTab'
import OverviewTab from './detail/OverviewTab'
import CriteriaTab from './detail/CriteriaTab'
import DiscussionTab from './detail/DiscussionTab'
import GitTab from './detail/GitTab'
import HistoryTab from './detail/HistoryTab'
import DocsTab from './detail/DocsTab'
import FilesTab from './detail/FilesTab'
import ContextTab from './detail/ContextTab'

const TABS = [
  { key: 'overview', label: 'Overview' },
  { key: 'criteria', label: 'Criteria' },
  { key: 'links', label: 'Links' },
  { key: 'discussion', label: 'Discussion' },
  { key: 'docs', label: 'Docs' },
  { key: 'files', label: 'Files' },
  { key: 'context', label: 'Context' },
  { key: 'git', label: 'Git' },
  { key: 'history', label: 'History' },
]

const CONFLICT_MESSAGE =
  'Someone changed this task while you were looking. It has been reloaded; check it and try again.'

/**
 * The full task view. Every write goes through `run`, which reloads the task
 * when the server answers 409 for a stale version, so the user always ends
 * up looking at the current state.
 *
 * `onOpenTask(id)` switches to another task (parent, subtask, linked task);
 * without it the board opens with `?task=ID`. `onOtherChanged(task)` gets
 * other tasks this view changed or created (a new subtask, a task it now
 * blocks), so a board can keep their cards current.
 */
/** Copy a link that opens this task, or its HUB- key, to share with the team. */
function CopyTaskLink({ id }) {
  const [copied, setCopied] = useState(null)
  useEffect(() => {
    if (!copied) return undefined
    const timer = setTimeout(() => setCopied(null), 2000)
    return () => clearTimeout(timer)
  }, [copied])

  async function copy(what, text) {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(what)
    } catch {
      // Clipboard refused (an http page or a browser setting): show the text to copy by hand.
      window.prompt('Copy this:', text)
    }
  }

  const button =
    'rounded-md border border-hairline px-2 py-1 text-xs text-ink-secondary hover:bg-surface-raised hover:text-ink'
  return (
    <div className="mb-2 flex flex-wrap items-center gap-2">
      <button type="button" className={button} onClick={() => copy('link', taskLink(id))}>
        {copied === 'link' ? 'Link copied' : 'Copy link'}
      </button>
      <button type="button" className={button} onClick={() => copy('key', taskKey(id))}>
        {copied === 'key' ? 'Copied' : `Copy ${taskKey(id)}`}
      </button>
      <span role="status" className="sr-only">
        {copied ? 'Copied to the clipboard' : ''}
      </span>
    </div>
  )
}

export default function TaskDetailModal({
  task,
  user,
  people,
  onClose,
  onChanged,
  onOpenTask = null,
  onOtherChanged = null,
  initialTab = 'overview',
  initialDoc = null,
  initialNotice = null,
}) {
  const navigate = useNavigate()
  const [tab, setTab] = useState(initialTab)
  const [error, setError] = useState(null)
  const [notice, setNotice] = useState(initialNotice)
  const [busy, setBusy] = useState(false)
  const [creatingSubtask, setCreatingSubtask] = useState(false)

  const isLead = hasLeadRights(user)
  const isReadOnly = isReadOnlyUser(user)
  const isWorker = isWorkerOn(task, user)
  const closed = isClosed(task.status)

  async function reload() {
    onChanged(await api.task(task.id))
  }

  // For tabs that saved something themselves and only want fresh counts and
  // lists. A failed refresh leaves the old lists until the next open.
  async function refresh() {
    try {
      await reload()
    } catch {
      // The write already succeeded; nothing to report.
    }
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
    docs: task.docs?.length ?? 0,
    files: task.files?.length ?? 0,
    context: task.context?.length ?? 0,
    history: task.events?.length ?? 0,
    links: (task.links?.length ?? 0) + (task.children?.length ?? 0) + (task.parent_id ? 1 : 0),
  }

  function openTask(id, message = null) {
    if (onOpenTask) onOpenTask(id, message)
    else navigate(`/board?task=${id}`)
  }

  // Viewers read only; everyone else may file a task, so a subtask too.
  const canCreate = !isReadOnly && !closed && !task.parent_id

  async function createSubtask(payload) {
    const created = await api.createTask(payload)
    if (created.duplicate_of_existing) {
      onOtherChanged?.(created)
      openTask(created.id, `An open task already covers this: #${created.id}. It is open now instead of a new one.`)
      return created
    }
    onOtherChanged?.(created)
    await refresh()
    setError(null)
    setNotice(
      created.status === 'backlog' || created.status === 'proposed'
        ? `Subtask #${created.id} is in the ${created.status === 'backlog' ? 'backlog' : 'Triage column'}. A lead will triage it.`
        : `Subtask #${created.id} created.`,
    )
    return created
  }

  const ctx = {
    task,
    user,
    people,
    isLead,
    isReadOnly,
    isWorker,
    closed,
    busy,
    run,
    reload: refresh,
    openTask,
    onOtherChanged,
    startSubtask: canCreate ? () => setCreatingSubtask(true) : null,
  }

  return (
    <Modal title={`Task ${taskKey(task.id)}`} onClose={onClose} size="xl">
      <CopyTaskLink id={task.id} />
      {task.parent_id && (
        <button
          type="button"
          onClick={() => openTask(task.parent_id)}
          className="mb-1 inline-flex max-w-full items-center gap-1 text-xs text-ink-secondary underline-offset-2 hover:text-ink hover:underline"
        >
          ↳ Subtask of {taskKey(task.parent_id)}
          {task.parent?.title && (
            <span dir="auto" className="truncate">
              {task.parent.title}
            </span>
          )}
        </button>
      )}
      <h3 dir="auto" className="break-words text-lg font-semibold leading-snug">
        {task.title}
      </h3>

      <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
        <StatusBadge status={task.status} />
        <KindBadge kind={task.kind} />
        <BlockedBadge ids={task.blocked_by} />
        {task.children_total > 0 && (
          <span className="tabular inline-flex items-center rounded-full border border-hairline px-2 py-0.5 text-[11px] font-medium text-ink-secondary">
            {task.children_total - task.children_open}/{task.children_total} subtasks
          </span>
        )}
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
        {tab === 'links' && <LinksTab ctx={ctx} />}
        {tab === 'discussion' && <DiscussionTab ctx={ctx} comments={comments} />}
        {tab === 'docs' && <DocsTab ctx={ctx} initialSlug={initialDoc} />}
        {tab === 'files' && <FilesTab ctx={ctx} />}
        {tab === 'context' && <ContextTab ctx={ctx} />}
        {tab === 'git' && <GitTab ctx={ctx} links={gitLinks} />}
        {tab === 'history' && <HistoryTab events={task.events ?? []} people={people} />}
      </div>

      {creatingSubtask && (
        <CreateTaskModal
          isLead={isLead}
          programmers={assignablePeople(people)}
          preset={{
            parent: { id: task.id, title: task.title, status: task.status, kind: task.kind },
            side: task.side,
            tags: task.tags,
          }}
          onClose={() => setCreatingSubtask(false)}
          onCreate={createSubtask}
        />
      )}
    </Modal>
  )
}
