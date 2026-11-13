import { useState } from 'react'
import { api } from '../../../api/client'
import { KindBadge, StatusBadge } from '../../Badges'
import TaskPicker from '../TaskPicker'
import { LINK_KINDS, LINK_KIND_VERBS, isClosed } from '../../../lib/constants'
import { formatDateTime } from '../../../lib/format'
import { linkButton, primaryButton, secondaryButton, sectionTitle, smallInputClass } from './ui'

const LINK_HINTS = {
  blocks: 'The other task cannot be claimed or started until this one closes.',
  relates: 'A pointer between two related tasks. It changes nothing in the workflow.',
  duplicates: null,
}

/** One other task as a clickable row: ID, title, kind and status. */
function TaskRefButton({ task, onOpen }) {
  return (
    <button
      type="button"
      onClick={() => onOpen(task.id)}
      className="flex min-w-0 flex-1 flex-wrap items-center gap-2 text-left transition hover:text-series1"
    >
      <span className="tabular text-xs text-ink-muted">#{task.id}</span>
      <span dir="auto" className="min-w-0 flex-1 truncate" title={task.title}>
        {task.title}
      </span>
      <KindBadge kind={task.kind} hideTask />
      <StatusBadge status={task.status} />
    </button>
  )
}

// "this task blocks #12" reads better as a line start with a capital.
function sentence(label) {
  return label ? label.charAt(0).toUpperCase() + label.slice(1) : ''
}

function AddLinkForm({ ctx }) {
  const { task, busy, run, onOtherChanged } = ctx
  const [kind, setKind] = useState('blocks')
  const [other, setOther] = useState(null)
  const links = task.links ?? []

  function refusal(candidate) {
    if (candidate.id === task.id) return 'This task'
    const taken = links.some(
      (link) => link.direction === 'outgoing' && link.kind === kind && link.other.id === candidate.id,
    )
    if (taken) return `Already linked: this task ${LINK_KIND_VERBS[kind]} #${candidate.id}`
    if (kind === 'blocks' && isClosed(candidate.status)) return 'Closed; a closed task waits on nothing'
    return null
  }

  async function submit(event) {
    event.preventDefault()
    if (!other) return
    const target = other.id
    const ok = await run(() => api.addTaskLink(task.id, kind, target), {
      success: kind === 'duplicates' ? `Linked as a duplicate of #${target}.` : null,
    })
    if (ok) {
      setOther(null)
      // The other task's card shows its blockers; fetch it so the board stays true.
      if (kind === 'blocks' && onOtherChanged) {
        api.task(target).then(onOtherChanged).catch(() => {})
      }
    }
  }

  const hint = LINK_HINTS[kind]

  return (
    <form onSubmit={submit} className="space-y-2 rounded-lg border border-hairline p-3">
      <p className="text-sm font-medium">Link another task</p>
      <div className="grid gap-2 sm:grid-cols-[12rem_1fr]">
        <select
          aria-label="Link kind"
          value={kind}
          onChange={(e) => {
            setKind(e.target.value)
            setOther(null)
          }}
          className={smallInputClass}
        >
          {LINK_KINDS.map((k) => (
            <option key={k} value={k}>
              This task {LINK_KIND_VERBS[k]}…
            </option>
          ))}
        </select>
        <TaskPicker
          value={other}
          onChange={setOther}
          accept={refusal}
          includeClosed={kind !== 'blocks'}
        />
      </div>
      {hint && <p className="text-xs text-ink-muted">{hint}</p>}
      {kind === 'duplicates' && (
        <p className="text-xs text-ink-muted">
          After you link it, a lead can drop this task with the reason “duplicate of #
          {other ? other.id : 'N'}”.
        </p>
      )}
      <div className="flex justify-end">
        <button type="submit" disabled={busy || !other} className={primaryButton}>
          Add link
        </button>
      </div>
    </form>
  )
}

export default function LinksTab({ ctx }) {
  const { task, isWorker, isReadOnly, closed, busy, run, openTask, startSubtask, onOtherChanged } = ctx
  const children = task.children ?? []
  const links = task.links ?? []
  const openChildren = children.filter((child) => !isClosed(child.status)).length
  const canAddSubtask = !isReadOnly && !closed && !task.parent_id && Boolean(startSubtask)
  const canEditLinks = isWorker && !isReadOnly

  async function remove(link) {
    const ok = await run(() => api.removeTaskLink(task.id, link.id))
    // Removing "this task blocks #N" may free #N on the board.
    if (ok && link.kind === 'blocks' && link.direction === 'outgoing' && onOtherChanged) {
      api.task(link.other.id).then(onOtherChanged).catch(() => {})
    }
  }

  return (
    <div className="space-y-5">
      {task.parent_id && (
        <section>
          <h4 className={sectionTitle}>Parent</h4>
          <div className="mt-1.5 flex items-center rounded-lg border border-hairline px-3 py-2 text-sm">
            {task.parent ? (
              <TaskRefButton task={task.parent} onOpen={openTask} />
            ) : (
              <button type="button" onClick={() => openTask(task.parent_id)} className={linkButton}>
                Open #{task.parent_id}
              </button>
            )}
          </div>
        </section>
      )}

      <section>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h4 className={sectionTitle}>
            Subtasks
            {children.length > 0 && (
              <span className="tabular ms-2 font-normal normal-case tracking-normal text-ink-muted">
                {children.length - openChildren} of {children.length} closed
              </span>
            )}
          </h4>
          {canAddSubtask && (
            <button type="button" onClick={startSubtask} className={secondaryButton}>
              Add subtask
            </button>
          )}
        </div>
        {children.length > 0 ? (
          <ul className="mt-1.5 divide-y divide-hairline rounded-lg border border-hairline">
            {children.map((child) => (
              <li key={child.id} className="flex items-center px-3 py-2 text-sm">
                <TaskRefButton task={child} onOpen={openTask} />
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-1.5 text-sm text-ink-muted">
            {task.parent_id
              ? 'This is a subtask. Subtasks go two levels deep, so it cannot have its own.'
              : 'No subtasks. Split a task that both frontend and backend touch into one subtask per side.'}
          </p>
        )}
        {openChildren > 0 && (
          <p className="mt-1.5 text-xs text-ink-muted">
            This task cannot reach Done while {openChildren} subtask{openChildren === 1 ? ' is' : 's are'} open.
          </p>
        )}
      </section>

      <section>
        <h4 className={sectionTitle}>Links</h4>
        {links.length > 0 ? (
          <ul className="mt-1.5 divide-y divide-hairline rounded-lg border border-hairline">
            {links.map((link) => (
              <li key={`${link.direction}-${link.id}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm">
                <span dir="auto" className="w-full text-xs text-ink-secondary sm:w-44 sm:shrink-0">
                  {sentence(link.label)}
                </span>
                <TaskRefButton task={link.other} onOpen={openTask} />
                <time className="text-xs text-ink-muted">{formatDateTime(link.created_at)}</time>
                {canEditLinks && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => remove(link)}
                    className={linkButton}
                    aria-label={`Remove link: ${link.label}`}
                  >
                    Remove
                  </button>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-1.5 text-sm text-ink-muted">No links to other tasks.</p>
        )}
      </section>

      {canEditLinks && <AddLinkForm ctx={ctx} />}
    </div>
  )
}
