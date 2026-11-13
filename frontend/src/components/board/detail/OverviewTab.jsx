import { useState } from 'react'
import { api } from '../../../api/client'
import { ActorBadge, DeployBadge, PlainText, TagBadge } from '../../Badges'
import PointsPicker from '../PointsPicker'
import {
  DEPLOY_LABELS,
  DEPLOY_STATES,
  PRIORITIES,
  PRIORITY_LABELS,
  SIDES,
  SIDE_LABELS,
  assignablePeople,
  canClaim,
  claimIsLive,
  splitList,
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

/** Edit form. Leaders edit everything; workers edit summary, tags, areas and side. */
function EditForm({ ctx, programmers, onDone }) {
  const { task, isLead, busy, run } = ctx
  const [form, setForm] = useState({
    title: task.title,
    description: task.description ?? '',
    summary: task.summary ?? '',
    side: task.side ?? '',
    tags: (task.tags ?? []).join(', '),
    areas: (task.areas ?? []).join('\n'),
    priority: task.priority,
    points: task.points,
    due_date: toDateInputValue(task.due_date),
    restricted: Boolean(task.restricted),
    pool: Boolean(task.pool),
    assignee_1_id: task.assignee_1_id ? String(task.assignee_1_id) : '',
    assignee_2_id: task.assignee_2_id ? String(task.assignee_2_id) : '',
  })

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
    put('tags', splitList(form.tags), task.tags ?? [])
    put('areas', splitList(form.areas), task.areas ?? [])
    if (isLead) {
      put('title', form.title.trim(), task.title)
      put('description', form.description.trim() || null, task.description)
      put('priority', form.priority, task.priority)
      put('points', form.points, task.points)
      const due = fromDateInputValue(form.due_date, true)
      if (form.due_date !== toDateInputValue(task.due_date)) out.due_date = due
      put('restricted', form.restricted, Boolean(task.restricted))
      put('pool', form.pool, Boolean(task.pool))
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
        <textarea
          id="edit-summary"
          rows={3}
          maxLength={4000}
          dir="auto"
          value={form.summary}
          onChange={(e) => update('summary', e.target.value)}
          className={inputClass}
        />
        <p className="mt-1 text-xs text-ink-muted">
          A short current state. A hand-back replaces it with its Summary line.
        </p>
      </div>

      {isLead && (
        <div>
          <label className="block text-sm font-medium" htmlFor="edit-description">Description</label>
          <textarea
            id="edit-description"
            rows={5}
            dir="auto"
            value={form.description}
            onChange={(e) => update('description', e.target.value)}
            className={inputClass}
          />
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
          <label className="block text-sm font-medium" htmlFor="edit-areas">Areas</label>
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
                  <option key={p.id} value={p.id}>{p.name}</option>
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
                  <option key={p.id} value={p.id}>{p.name}</option>
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
              <input type="checkbox" checked={form.pool} onChange={(e) => update('pool', e.target.checked)} />
              Pool (any member may claim)
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

function ClaimPanel({ ctx }) {
  const { task, user, isLead, busy, run } = ctx
  const [branch, setBranch] = useState(task.claim_branch ?? '')
  const live = claimIsLive(task)
  const mine = live && task.claimed_by === user.id
  const claimable = canClaim(task, user) && (!live || mine || isLead)
  const canRelease = task.claimed_by && (task.claimed_by === user.id || isLead)

  async function claim(event) {
    event.preventDefault()
    await run(() => api.claim(task.id, { branch: branch.trim() || null }), {
      reloadAfter: true,
      success: (result) =>
        result?.warnings?.length
          ? `Claimed, with warnings:\n${result.warnings.map((w) => `• ${w}`).join('\n')}`
          : 'Claimed.',
    })
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

      {claimable && (
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
          <button type="submit" disabled={busy} className={primaryButton}>
            {mine ? 'Renew claim' : 'Claim'}
          </button>
        </form>
      )}
      {claimable && task.status === 'to_do' && !mine && (
        <p className="mt-1.5 text-xs text-ink-muted">Claiming a To do task moves it to In progress.</p>
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

export default function OverviewTab({ ctx }) {
  const { task, people, isLead, isWorker, isReadOnly, closed } = ctx
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
            <PlainText className="mt-1 text-sm text-ink-secondary">{task.drop_reason}</PlainText>
          </div>
        )}

        <div>
          <h4 className={sectionTitle}>Summary</h4>
          {task.summary ? (
            <PlainText className="mt-1 text-sm leading-relaxed">{task.summary}</PlainText>
          ) : (
            <p className="mt-1 text-sm text-ink-muted">No summary yet.</p>
          )}
        </div>

        <div>
          <h4 className={sectionTitle}>Description</h4>
          {task.description ? (
            <PlainText className="mt-1 text-sm leading-relaxed text-ink-secondary">{task.description}</PlainText>
          ) : (
            <p className="mt-1 text-sm text-ink-muted">No description.</p>
          )}
        </div>

        <div className="flex flex-wrap gap-6">
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
            <h4 className={sectionTitle}>Areas</h4>
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
            {isLead ? 'Edit task' : 'Edit summary, side, tags and areas'}
          </button>
        )}
      </div>

      <aside className="space-y-4">
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 lg:grid-cols-1">
          <Field label="Assigned to">
            {assignees.length ? assignees.map(personName).join(' + ') : task.pool ? 'Pool' : 'Unassigned'}
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
