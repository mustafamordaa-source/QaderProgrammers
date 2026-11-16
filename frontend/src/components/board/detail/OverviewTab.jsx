import { useState } from 'react'
import WithPreview, { RichText } from '../../MarkdownPreview'
import { api } from '../../../api/client'
import { ActorBadge, AudienceBadge, DeployBadge, PlainText, RequestedBadge, TagBadge } from '../../Badges'
import AreaPicker from '../AreaPicker'
import PointsPicker from '../PointsPicker'
import TaskPicker from '../TaskPicker'
import RequesterFields from '../RequesterFields'
import { LockIcon } from '../BoardIcons'
import CrossSideTake, { crossSideOpen } from '../CrossSideTake'
import {
  AUDIENCES,
  AUDIENCE_LABELS,
  DEPLOY_LABELS,
  DEPLOY_STATES,
  KIND_LABELS,
  PRIORITIES,
  PRIORITY_LABELS,
  REQUESTER_LABELS,
  SIDES,
  SIDE_LABELS,
  TASK_KINDS,
  assignablePeople,
  canClaim,
  claimIsLive,
  groupPeople,
  isVipRequest,
  personRoleText,
  splitList,
  taskIdList,
  taskKey,
  personLabel,
} from '../../../lib/constants'
import {
  formatDate,
  formatDateTime,
  fromDateInputValue,
  toDateInputValue,
} from '../../../lib/format'
import {
  inputClass,
  linkButton,
  primaryButton,
  secondaryButton,
  sectionTitle,
  smallInputClass,
} from './ui'

function Field({ label, children }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-ink-muted">{label}</dt>
      <dd className="mt-0.5 break-words text-sm">{children}</dd>
    </div>
  )
}

function personName(person) {
  if (!person) return null
  return person.handle ? `${person.name} (@${person.handle})` : person.name
}

/** Edit form. Leaders edit everything; workers edit summary, tags, areas, side and audience. */
function EditForm({ ctx, programmers, onDone }) {
  const { task, isLead, busy, run } = ctx
  const [form, setForm] = useState({
    title: task.title,
    description: task.description ?? '',
    summary: task.summary ?? '',
    side: task.side ?? '',
    audience: task.audience ?? '',
    tags: (task.tags ?? []).join(', '),
    areas: (task.areas ?? []).join('\n'),
    area: task.area?.slug ?? '',
    priority: task.priority,
    points: task.points,
    due_date: toDateInputValue(task.due_date),
    restricted: Boolean(task.restricted),
    assign_only: Boolean(task.assign_only),
    assignee_1_id: task.assignee_1_id ? String(task.assignee_1_id) : '',
    assignee_2_id: task.assignee_2_id ? String(task.assignee_2_id) : '',
    kind: task.kind ?? 'task',
    requested_by: task.requested_by ?? '',
    requested_by_name: task.requested_by_name ?? '',
    requested_at: (task.requested_at ?? '').slice(0, 10),
    parent: task.parent ?? (task.parent_id ? { id: task.parent_id, title: `Task #${task.parent_id}` } : null),
  })
  const hasChildren = (task.children_total ?? task.children?.length ?? 0) > 0

  // Mirrors _check_parent: two levels only, never itself.
  function parentRefusal(candidate) {
    if (candidate.id === task.id) return 'This task'
    if (candidate.parent_id) return 'Already a subtask; subtasks go two levels deep'
    return null
  }

  function update(field, value) {
    setForm((current) => ({ ...current, [field]: value }))
  }

  function changedFields() {
    const out = {}
    const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
    const put = (key, value, old) => {
      if (!same(value, old)) out[key] = value
    }
    put('summary', form.summary.trim() || null, task.summary)
    put('side', form.side || null, task.side)
    // "" clears the audience.
    put('audience', form.audience, task.audience ?? '')
    put('tags', splitList(form.tags), task.tags ?? [])
    put('areas', splitList(form.areas), task.areas ?? [])
    if ((form.area || '') !== (task.area?.slug ?? '')) out.area = form.area || ''
    if (isLead) {
      put('title', form.title.trim(), task.title)
      put('description', form.description.trim() || null, task.description)
      put('priority', form.priority, task.priority)
      put('points', form.points, task.points)
      const due = fromDateInputValue(form.due_date, true)
      if (form.due_date !== toDateInputValue(task.due_date)) out.due_date = due
      put('restricted', form.restricted, Boolean(task.restricted))
      put('assign_only', form.assign_only, Boolean(task.assign_only))
      put('kind', form.kind, task.kind ?? 'task')
      // "" clears who asked and the name; null clears the date.
      put('requested_by', form.requested_by, task.requested_by ?? '')
      put('requested_by_name', form.requested_by_name.trim(), task.requested_by_name ?? '')
      if (form.requested_at !== (task.requested_at ?? '').slice(0, 10)) out.requested_at = form.requested_at || null
      // 0 clears the parent.
      const parentId = form.parent?.id ?? null
      if (parentId !== (task.parent_id ?? null)) out.parent_id = parentId ?? 0
    }
    return out
  }

  async function submit(event) {
    event.preventDefault()
    const fields = changedFields()
    const a1 = form.assignee_1_id ? Number(form.assignee_1_id) : null
    const a2 = form.assignee_1_id && form.assignee_2_id ? Number(form.assignee_2_id) : null
    const reassign =
      isLead && (a1 !== (task.assignee_1_id ?? null) || a2 !== (task.assignee_2_id ?? null))

    if (Object.keys(fields).length === 0 && !reassign) {
      onDone()
      return
    }
    const ok = await run(
      async () => {
        if (Object.keys(fields).length > 0) {
          await api.updateTask(task.id, { ...fields, expected_version: task.version })
        }
        if (reassign) await api.assign(task.id, a1, a2)
      },
      { reloadAfter: true },
    )
    if (ok) onDone()
  }

  const secondChoices = programmers.filter((p) => String(p.id) !== form.assignee_1_id)

  return (
    <form onSubmit={submit} className="space-y-4">
      {isLead && (
        <div>
          <label className="block text-sm font-medium" htmlFor="edit-title">Title</label>
          <input
            id="edit-title"
            required
            maxLength={200}
            dir="auto"
            value={form.title}
            onChange={(e) => update('title', e.target.value)}
            className={inputClass}
          />
        </div>
      )}

      <div>
        <label className="block text-sm font-medium" htmlFor="edit-summary">Summary</label>
        <WithPreview value={form.summary}>
        <textarea
          id="edit-summary"
          rows={3}
          maxLength={4000}
          dir="auto"
          value={form.summary}
          onChange={(e) => update('summary', e.target.value)}
          className={inputClass}
        />
        </WithPreview>
        <p className="mt-1 text-xs text-ink-muted">
          A short current state. A hand-back replaces it with its Summary line.
        </p>
      </div>

      {isLead && (
        <div>
          <label className="block text-sm font-medium" htmlFor="edit-description">Description</label>
          <WithPreview value={form.description}>
          <textarea
            id="edit-description"
            rows={5}
            dir="auto"
            value={form.description}
            onChange={(e) => update('description', e.target.value)}
            className={inputClass}
          />
          </WithPreview>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-3">
        <div>
          <label className="block text-sm font-medium" htmlFor="edit-side">Side</label>
          <select id="edit-side" value={form.side} onChange={(e) => update('side', e.target.value)} className={inputClass}>
            <option value="">None</option>
            {SIDES.map((s) => (
              <option key={s} value={s}>{SIDE_LABELS[s]}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-sm font-medium" htmlFor="edit-audience">Who does it reach?</label>
          <select
            id="edit-audience"
            value={form.audience}
            onChange={(e) => update('audience', e.target.value)}
            className={inputClass}
          >
            <option value="">Not sure</option>
            {AUDIENCES.map((a) => (
              <option key={a} value={a}>{AUDIENCE_LABELS[a]}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-sm font-medium" htmlFor="edit-tags">Tags</label>
          <input
            id="edit-tags"
            dir="auto"
            placeholder="comma separated"
            value={form.tags}
            onChange={(e) => update('tags', e.target.value)}
            className={inputClass}
          />
        </div>
        <div>
          <label className="block text-sm font-medium" htmlFor="edit-area">Area</label>
          <AreaPicker id="edit-area" value={form.area} onChange={(slug) => update('area', slug)} />
        </div>
        <div>
          <label className="block text-sm font-medium" htmlFor="edit-areas">Code paths</label>
          <textarea
            id="edit-areas"
            rows={2}
            dir="ltr"
            placeholder="one path per line"
            value={form.areas}
            onChange={(e) => update('areas', e.target.value)}
            className={`${inputClass} font-mono text-xs`}
          />
        </div>
      </div>

      {isLead && (
        <>
          <div className="grid gap-4 sm:grid-cols-[12rem_1fr]">
            <div>
              <label className="block text-sm font-medium" htmlFor="edit-kind">Kind</label>
              <select id="edit-kind" value={form.kind} onChange={(e) => update('kind', e.target.value)} className={inputClass}>
                {TASK_KINDS.map((k) => (
                  <option key={k} value={k}>{KIND_LABELS[k]}</option>
                ))}
              </select>
            </div>
            <div className="min-w-0">
              <label className="block text-sm font-medium" htmlFor="edit-parent">Subtask of</label>
              <div className="mt-1.5">
                {hasChildren ? (
                  <p className="text-sm text-ink-muted">
                    This task has subtasks, so it cannot become a subtask.
                  </p>
                ) : (
                  <TaskPicker
                    id="edit-parent"
                    value={form.parent}
                    onChange={(parent) => update('parent', parent)}
                    accept={parentRefusal}
                    clearLabel="Clear"
                    placeholder="No parent. Search open tasks, or #ID"
                  />
                )}
              </div>
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="block text-sm font-medium" htmlFor="edit-priority">Priority</label>
              <select id="edit-priority" value={form.priority} onChange={(e) => update('priority', e.target.value)} className={inputClass}>
                {PRIORITIES.map((p) => (
                  <option key={p} value={p}>{PRIORITY_LABELS[p]}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium" htmlFor="edit-due">Due date</label>
              <input id="edit-due" type="date" value={form.due_date} onChange={(e) => update('due_date', e.target.value)} className={inputClass} />
            </div>
          </div>

          <RequesterFields idPrefix="edit" value={form} onChange={update} inputClass={inputClass} />

          <PointsPicker id="edit-points" value={form.points} onChange={(points) => update('points', points)} />

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="block text-sm font-medium" htmlFor="edit-a1">Assignee</label>
              <select
                id="edit-a1"
                value={form.assignee_1_id}
                onChange={(e) => {
                  const value = e.target.value
                  setForm((current) => ({
                    ...current,
                    assignee_1_id: value,
                    assignee_2_id: !value || value === current.assignee_2_id ? '' : current.assignee_2_id,
                  }))
                }}
                className={inputClass}
              >
                <option value="">Unassigned</option>
                {programmers.map((p) => (
                  <option key={p.id} value={p.id}>{personLabel(p)}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium" htmlFor="edit-a2">Second assignee</label>
              <select
                id="edit-a2"
                value={form.assignee_2_id}
                disabled={!form.assignee_1_id}
                onChange={(e) => update('assignee_2_id', e.target.value)}
                className={`${inputClass} disabled:opacity-50`}
              >
                <option value="">None</option>
                {secondChoices.map((p) => (
                  <option key={p.id} value={p.id}>{personLabel(p)}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="flex flex-wrap gap-5 text-sm">
            <label className="inline-flex items-center gap-2">
              <input type="checkbox" checked={form.restricted} onChange={(e) => update('restricted', e.target.checked)} />
              Restricted (leads only)
            </label>
            <label className="inline-flex items-center gap-2">
              <input type="checkbox" checked={form.assign_only} onChange={(e) => update('assign_only', e.target.checked)} />
              Lead assigns (sensitive: nobody takes it until assigned)
            </label>
          </div>
        </>
      )}

      <div className="flex justify-end gap-2">
        <button type="button" onClick={onDone} className={secondaryButton}>Cancel</button>
        <button type="submit" disabled={busy} className={primaryButton}>
          {busy ? 'Saving…' : 'Save changes'}
        </button>
      </div>
    </form>
  )
}

function DeployEditor({ ctx }) {
  const { task, busy, run } = ctx
  const [editing, setEditing] = useState(false)
  const [state, setState] = useState(task.deploy_state ?? 'none')
  const [note, setNote] = useState(task.deploy_note ?? '')

  async function save(event) {
    event.preventDefault()
    const ok = await run(() => api.setDeploy(task.id, state, note.trim()))
    if (ok) setEditing(false)
  }

  if (!editing) {
    return (
      <button
        type="button"
        className={linkButton}
        onClick={() => {
          setState(task.deploy_state ?? 'none')
          setNote(task.deploy_note ?? '')
          setEditing(true)
        }}
      >
        Change deploy state
      </button>
    )
  }

  return (
    <form onSubmit={save} className="mt-2 space-y-2">
      <select aria-label="Deploy state" value={state} onChange={(e) => setState(e.target.value)} className={smallInputClass}>
        {DEPLOY_STATES.map((s) => (
          <option key={s} value={s}>{DEPLOY_LABELS[s]}</option>
        ))}
      </select>
      <textarea
        aria-label="Deploy note"
        rows={2}
        dir="auto"
        maxLength={2000}
        placeholder="Note, for example the release or what to check (optional)"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        className={smallInputClass}
      />
      <div className="flex justify-end gap-2">
        <button type="button" onClick={() => setEditing(false)} className={secondaryButton}>Cancel</button>
        <button type="submit" disabled={busy} className={primaryButton}>Save</button>
      </div>
    </form>
  )
}

/** One entry of `task.people` in words; a part held through a subtask links to it. */
function PersonRole({ entry, taskId, openTask }) {
  const text = personRoleText(entry, taskId)
  if (entry.role !== 'part' || !entry.task_id || entry.task_id === taskId) return <span>{text}</span>
  const key = taskKey(entry.task_id)
  const [before] = text.split(key)
  return (
    <span>
      {before}
      <a
        href={`/t/${entry.task_id}`}
        onClick={(event) => {
          event.preventDefault()
          openTask(entry.task_id)
        }}
        className="text-series1 hover:underline"
      >
        {key}
      </a>
    </span>
  )
}

/** Everyone on the task: assignees, the claim holder and people on its parts. */
function PeopleOnTask({ task, openTask }) {
  const people = groupPeople(task.people)
  if (people.length === 0) return <span className="text-ink-muted">Nobody yet</span>
  return (
    <ul className="space-y-1">
      {people.map((person) => (
        <li key={person.handle || person.name} className="min-w-0">
          <span dir="auto" className="font-medium">
            {person.name}
          </span>
          {person.handle && <span className="text-ink-muted"> @{person.handle}</span>}
          <span className="text-ink-secondary">
            {' · '}
            {person.entries.map((entry, index) => (
              <span key={`${entry.role}-${entry.task_id}-${entry.part ?? ''}`}>
                {index > 0 && ', '}
                <PersonRole entry={entry} taskId={task.id} openTask={openTask} />
              </span>
            ))}
          </span>
        </li>
      ))}
    </ul>
  )
}

function ClaimPanel({ ctx }) {
  const { task, user, isLead, isReadOnly, busy, run, reload } = ctx
  const [branch, setBranch] = useState(task.claim_branch ?? '')
  const [taking, setTaking] = useState(false)
  // The outcome of the last Take, shown here instead of far up the dialog.
  const [message, setMessage] = useState(null)
  const live = claimIsLive(task)
  const mine = live && task.claimed_by === user.id
  // The server says whether you may claim now and, if not, why. Older answers
  // without `claimable` fall back to the local rule.
  const serverSays = typeof task.claimable === 'boolean'
  const blockers = task.blocked_by ?? []
  const claimable = serverSays
    ? task.claimable
    : canClaim(task, user) && (!live || mine || isLead) && blockers.length === 0
  const canRelease = task.claimed_by && (task.claimed_by === user.id || isLead)
  let reason = null
  if (!claimable && !mine && !isReadOnly) {
    reason = serverSays
      ? task.claim_block_text
      : blockers.length
        ? `Blocked by open task ${taskIdList(blockers)}. Finish or unlink it first.`
        : null
  }

  // Take across sides: the hub's refusal goes back to the dialog, which shows it.
  async function claimAcross(crossSideReason) {
    setMessage(null)
    let result
    try {
      result = await api.claim(task.id, { branch: branch.trim() || null, cross_side_reason: crossSideReason })
    } catch (err) {
      await reload()
      throw err
    }
    await reload()
    setMessage({
      tone: 'good',
      text: result?.warnings?.length
        ? `Taken across sides, with warnings:\n${result.warnings.map((w) => `• ${w}`).join('\n')}`
        : 'Taken across sides. The hub posted your reason as a note and told the people on the task.',
    })
  }

  async function claim(event) {
    event.preventDefault()
    setMessage(null)
    setTaking(true)
    try {
      const result = await api.claim(task.id, { branch: branch.trim() || null })
      await reload()
      setMessage({
        tone: 'good',
        text: result?.warnings?.length
          ? `Taken, with warnings:\n${result.warnings.map((w) => `• ${w}`).join('\n')}`
          : mine
            ? 'Claim renewed.'
            : 'Taken. The task is in progress and yours now.',
      })
    } catch (err) {
      setMessage({ tone: 'critical', text: err.message })
      await reload()
    } finally {
      setTaking(false)
    }
  }

  return (
    <div className="rounded-lg border border-hairline p-3">
      <h4 className={sectionTitle}>Claim</h4>
      {live ? (
        <p dir="auto" className="mt-1.5 text-sm">
          <span className="font-medium">{personName(task.claimer) ?? 'Someone'}</span>
          {task.claim_agent && <span className="text-ink-secondary"> with agent {task.claim_agent}</span>}
          <span className="text-ink-secondary"> until {formatDateTime(task.claim_expires_at)}</span>
        </p>
      ) : (
        <p className="mt-1.5 text-sm text-ink-muted">
          {task.claimed_by ? `The last claim ran out ${formatDateTime(task.claim_expires_at)}.` : 'Nobody holds a claim.'}
        </p>
      )}
      {task.claim_branch && (
        <p className="mt-1 text-xs text-ink-secondary">
          Branch: <code dir="ltr" className="font-mono">{task.claim_branch}</code>
        </p>
      )}

      {(claimable || mine) && !isReadOnly && (
        <form onSubmit={claim} className="mt-2.5 flex flex-wrap items-center gap-2">
          <input
            aria-label="Branch"
            dir="ltr"
            maxLength={200}
            placeholder="branch (optional)"
            value={branch}
            onChange={(e) => setBranch(e.target.value)}
            className={`${smallInputClass} max-w-xs font-mono text-xs`}
          />
          <button type="submit" disabled={busy || taking} className={primaryButton}>
            {taking ? 'Taking…' : mine ? 'Renew claim' : 'Take'}
          </button>
        </form>
      )}
      {reason && (
        <p dir="auto" className="mt-2 flex items-start gap-1.5 text-xs text-ink-secondary">
          <LockIcon className="mt-0.5 h-3 w-3" />
          <span>{reason}</span>
        </p>
      )}
      {!claimable && !mine && !isReadOnly && crossSideOpen(task) && (
        <div className="mt-2">
          <CrossSideTake disabled={busy} onSubmit={claimAcross} />
        </div>
      )}
      {claimable && !mine && (task.status === 'to_do' || task.status === 'backlog') && (
        <p className="mt-1.5 text-xs text-ink-muted">Taking it moves it to In progress and makes it yours.</p>
      )}
      {message && (
        <p
          role={message.tone === 'critical' ? 'alert' : 'status'}
          dir="auto"
          className={`mt-2 whitespace-pre-line text-xs ${message.tone === 'critical' ? 'text-critical' : 'text-good'}`}
        >
          {message.text}
        </p>
      )}
      {canRelease && (
        <button
          type="button"
          disabled={busy}
          onClick={() => run(() => api.release(task.id), { success: 'Claim released.' })}
          className={`${secondaryButton} mt-2.5`}
        >
          Release claim
        </button>
      )}
    </div>
  )
}

/** Jira-style hand-over: pick a teammate (or yourself) for a task you may assign. */
function AssignControl({ ctx, programmers }) {
  const { task, user, run, busy } = ctx
  const [who, setWho] = useState('')
  if (!task.can_assign) return null
  const choices = programmers.filter((p) => p.id !== task.assignee_1_id)

  async function assign() {
    if (!who) return
    // run() shows any refusal in the task's error banner.
    const ok = await run(() => api.assign(task.id, Number(who), null), { reloadAfter: true })
    if (ok) setWho('')
  }

  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      <select
        aria-label="Assign to"
        className="min-w-0 flex-1 rounded-lg border border-hairline bg-surface-raised px-2 py-1 text-xs"
        value={who}
        onChange={(e) => setWho(e.target.value)}
      >
        <option value="">Assign to…</option>
        {choices.map((p) => (
          <option key={p.id} value={p.id}>
            {p.id === user?.id ? 'Me' : personLabel(p)}
            {p.sides?.length ? ` (${p.sides.join(', ')})` : ''}
          </option>
        ))}
      </select>
      <button type="button" disabled={!who || busy} onClick={assign} className={secondaryButton}>
        Assign
      </button>
    </div>
  )
}

export default function OverviewTab({ ctx }) {
  const { task, people, isLead, isWorker, isReadOnly, closed, openTask } = ctx
  const [editing, setEditing] = useState(false)
  const programmers = assignablePeople(people)
  const assignees = [task.assignee_1, task.assignee_2].filter(Boolean)

  if (editing) {
    return <EditForm ctx={ctx} programmers={programmers} onDone={() => setEditing(false)} />
  }

  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_18rem]">
      <div className="min-w-0 space-y-4">
        {task.drop_reason && (
          <div className="rounded-lg border border-hairline bg-surface-raised p-3">
            <h4 className={sectionTitle}>Drop reason</h4>
            <RichText className="mt-1 text-ink-secondary">{task.drop_reason}</RichText>
          </div>
        )}

        <div>
          <h4 className={sectionTitle}>Summary</h4>
          {task.summary ? (
            <RichText className="mt-1 leading-relaxed">{task.summary}</RichText>
          ) : (
            <p className="mt-1 text-sm text-ink-muted">No summary yet.</p>
          )}
        </div>

        <div>
          <h4 className={sectionTitle}>Description</h4>
          {task.description ? (
            <RichText className="mt-1 leading-relaxed text-ink-secondary">{task.description}</RichText>
          ) : (
            <p className="mt-1 text-sm text-ink-muted">No description.</p>
          )}
        </div>

        <div className="flex flex-wrap gap-6">
          <div>
            <h4 className={sectionTitle}>Area</h4>
            <div className="mt-1.5 text-sm">
              {task.area ? (
                <a href={`/board?area=${task.area.slug}`} dir="auto" className="text-series2 hover:underline">
                  {task.area.name}
                </a>
              ) : (
                <span className="text-ink-muted">None</span>
              )}
            </div>
          </div>
          <div>
            <h4 className={sectionTitle}>Tags</h4>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {(task.tags ?? []).length ? (
                task.tags.map((tag) => <TagBadge key={tag}>{tag}</TagBadge>)
              ) : (
                <span className="text-sm text-ink-muted">None</span>
              )}
            </div>
          </div>
          <div className="min-w-0">
            <h4 className={sectionTitle}>Code paths</h4>
            {(task.areas ?? []).length ? (
              <ul className="mt-1.5 space-y-0.5">
                {task.areas.map((area) => (
                  <li key={area}>
                    <code dir="ltr" className="break-all font-mono text-xs text-ink-secondary">{area}</code>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-1.5 text-sm text-ink-muted">None</p>
            )}
          </div>
        </div>

        {(isLead || isWorker) && !isReadOnly && !closed && (
          <button type="button" onClick={() => setEditing(true)} className={secondaryButton}>
            {isLead ? 'Edit task' : 'Edit summary, side, audience, tags and areas'}
          </button>
        )}
      </div>

      <aside className="space-y-4">
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 lg:grid-cols-1">
          <Field label="Assigned to">
            {assignees.length ? assignees.map(personName).join(' + ') : task.assign_only ? 'Waits for a lead to assign' : 'Open: anyone on its side can take it'}
            {!isReadOnly && !closed && <AssignControl ctx={ctx} programmers={programmers} />}
          </Field>
          {Array.isArray(task.people) && (
            <div className="col-span-2 lg:col-span-1">
              <Field label="People on this task">
                <PeopleOnTask task={task} openTask={openTask} />
              </Field>
            </div>
          )}
          <Field label="Reaches">
            {task.audience ? <AudienceBadge audience={task.audience} /> : <span className="text-ink-muted">Not set</span>}
          </Field>
          <Field label="Requested by">
            {isVipRequest(task) ? (
              <RequestedBadge requestedBy={task.requested_by} name={task.requested_by_name} date={task.requested_at} />
            ) : (
              <span className={task.requested_by ? '' : 'text-ink-muted'}>
                {REQUESTER_LABELS[task.requested_by] ?? 'Team (not set)'}
              </span>
            )}
            {(task.requested_by_name || task.requested_at) && (
              <span dir="auto" className="mt-1 block text-xs text-ink-secondary">
                {[task.requested_by_name, task.requested_at ? formatDate(task.requested_at) : '']
                  .filter(Boolean)
                  .join(', ')}
              </span>
            )}
          </Field>
          <Field label="Due">{formatDate(task.due_date)}</Field>
          <Field label="Created">
            <span className="block">
              {formatDate(task.created_at)}
              {task.creator ? ` by ${task.creator.name}` : ''}
            </span>
            {task.created_kind && task.created_kind !== 'human' && (
              <span className="mt-1 inline-block">
                <ActorBadge kind={task.created_kind} agent={task.created_agent} />
              </span>
            )}
          </Field>
          <Field label="Last change">{formatDateTime(task.updated_at)}</Field>
        </dl>

        <div className="rounded-lg border border-hairline p-3">
          <h4 className={sectionTitle}>Deploy</h4>
          <div className="mt-1.5">
            <DeployBadge state={task.deploy_state} />
            {task.deployed_at && (
              <span className="ml-2 text-xs text-ink-muted">{formatDateTime(task.deployed_at)}</span>
            )}
          </div>
          <PlainText className="mt-1.5 text-sm text-ink-secondary">{task.deploy_note}</PlainText>
          {isWorker && !isReadOnly && (
            <div className="mt-2">
              <DeployEditor ctx={ctx} />
            </div>
          )}
        </div>

        <ClaimPanel ctx={ctx} />
      </aside>
    </div>
  )
}
