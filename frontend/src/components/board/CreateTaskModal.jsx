import { useEffect, useState } from 'react'
import Modal from '../Modal'
import PointsPicker from './PointsPicker'
import TaskPicker from './TaskPicker'
import { loadTemplates } from './taskTemplates'
import {
  CREATE_STATUSES,
  DEFAULT_POINTS,
  KIND_LABELS,
  PRIORITIES,
  PRIORITY_LABELS,
  SIDES,
  SIDE_LABELS,
  STATUS_LABELS,
  TASK_KINDS,
  splitList,
} from '../../lib/constants'
import { fromDateInputValue } from '../../lib/format'

const inputClass =
  'mt-1.5 w-full rounded-lg border border-hairline bg-surface-raised px-3 py-2 text-sm outline-none focus:border-series1'

const STATUS_HINTS = {
  proposed: 'An idea to triage later. Members do not see other people’s proposals.',
  backlog: 'Accepted, not planned yet.',
  to_do: 'Planned and ready to pick up.',
}

// The server refuses a kind's required headings with this 422 detail.
const MISSING_HEADINGS = /needs these headings/i

function subtaskRefusal(task) {
  return task.parent_id ? 'Already a subtask; subtasks go two levels deep' : null
}

/**
 * `preset` fills a new subtask from its parent: `{ parent: TaskRef, side, tags }`.
 * `onCreate(payload)` returns the created task; the caller handles
 * `duplicate_of_existing`.
 */
export default function CreateTaskModal({ isLead, programmers, onClose, onCreate, preset = null }) {
  const [form, setForm] = useState({
    title: '',
    description: '',
    priority: 'medium',
    points: DEFAULT_POINTS,
    due_date: '',
    assignee_1_id: '',
    assignee_2_id: '',
    side: preset?.side ?? '',
    tags: (preset?.tags ?? []).join(', '),
    areas: '',
    criteria: '',
    status: 'to_do',
    restricted: false,
    pool: false,
    kind: 'task',
    use_template: true,
  })
  const [parent, setParent] = useState(preset?.parent ?? null)
  const [templates, setTemplates] = useState(null)
  const [templatesError, setTemplatesError] = useState(null)
  // A kind whose skeleton waits for the user's yes before replacing typed text.
  const [askReplace, setAskReplace] = useState(null)
  const [error, setError] = useState(null)
  const [descriptionError, setDescriptionError] = useState(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let cancelled = false
    loadTemplates()
      .then((list) => {
        if (!cancelled) setTemplates(Object.fromEntries(list.map((t) => [t.kind, t])))
      })
      .catch((err) => {
        if (!cancelled) setTemplatesError(err.message)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const template = templates?.[form.kind] ?? null

  function update(field, value) {
    setForm((current) => ({ ...current, [field]: value }))
  }

  function chooseKind(kind) {
    setAskReplace(null)
    setDescriptionError(null)
    const next = templates?.[kind]
    const previousSkeleton = templates?.[form.kind]?.skeleton ?? ''
    // Text the user has not touched since the last skeleton counts as empty.
    const untouched = !form.description.trim() || form.description === previousSkeleton
    setForm((current) => ({
      ...current,
      kind,
      description: untouched ? (next?.skeleton ?? '') : current.description,
    }))
    if (!untouched && next?.skeleton && form.description !== next.skeleton) setAskReplace(kind)
  }

  async function handleSubmit(event) {
    event.preventDefault()
    setError(null)
    setDescriptionError(null)
    setSaving(true)
    const payload = {
      title: form.title.trim(),
      description: form.description.trim() || null,
      priority: form.priority,
      points: form.points,
      due_date: fromDateInputValue(form.due_date, true),
      side: form.side || null,
      tags: splitList(form.tags),
      areas: splitList(form.areas),
      criteria: form.criteria
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean),
      kind: form.kind,
      use_template: form.use_template,
      parent_id: parent?.id ?? null,
    }
    if (isLead) {
      Object.assign(payload, {
        status: form.status,
        assignee_1_id: form.assignee_1_id ? Number(form.assignee_1_id) : null,
        assignee_2_id: form.assignee_2_id ? Number(form.assignee_2_id) : null,
        restricted: form.restricted,
        pool: form.pool,
      })
    } else {
      payload.status = 'backlog'
    }
    try {
      await onCreate(payload)
      onClose()
    } catch (err) {
      if (err.status === 422 && MISSING_HEADINGS.test(err.message)) setDescriptionError(err.message)
      else setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  // The second slot is for pairing, so it can't repeat the first assignee.
  const secondChoices = programmers.filter(
    (person) => String(person.id) !== form.assignee_1_id,
  )

  return (
    <Modal title={preset?.parent ? `Add a subtask to #${preset.parent.id}` : 'Create task'} onClose={onClose} wide>
      <form onSubmit={handleSubmit}>
        {!isLead && (
          <p className="mb-4 rounded-lg border border-hairline bg-surface-raised px-3 py-2 text-sm text-ink-secondary">
            Your task goes to the backlog. A lead triages it, assigns it and plans it.
          </p>
        )}

        <fieldset className="mb-4">
          <legend className="text-sm font-medium">Kind</legend>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {TASK_KINDS.map((kind) => (
              <label
                key={kind}
                className={`cursor-pointer rounded-full border px-3 py-1 text-sm transition ${
                  form.kind === kind
                    ? 'border-series1 bg-series1/5 text-series1'
                    : 'border-hairline text-ink-secondary hover:text-ink'
                }`}
              >
                <input
                  type="radio"
                  name="kind"
                  value={kind}
                  checked={form.kind === kind}
                  onChange={() => chooseKind(kind)}
                  className="sr-only"
                />
                {templates?.[kind]?.label ?? KIND_LABELS[kind]}
              </label>
            ))}
          </div>
          {templatesError && (
            <p dir="auto" className="mt-1.5 text-xs text-critical">
              Could not load the kind templates: {templatesError}. You can still create the task.
            </p>
          )}
        </fieldset>

        <label className="block text-sm font-medium" htmlFor="title">
          Title
        </label>
        <input
          id="title"
          required
          maxLength={200}
          dir="auto"
          value={form.title}
          onChange={(event) => update('title', event.target.value)}
          className={inputClass}
        />

        <label className="mt-4 block text-sm font-medium" htmlFor="description">
          Description
        </label>
        <textarea
          id="description"
          rows={template?.skeleton ? 8 : 4}
          dir="auto"
          maxLength={20000}
          value={form.description}
          onChange={(event) => {
            update('description', event.target.value)
            setDescriptionError(null)
          }}
          aria-invalid={descriptionError ? true : undefined}
          aria-describedby={descriptionError ? 'description-error' : undefined}
          className={`${inputClass} ${template?.skeleton ? 'font-mono text-xs leading-relaxed' : ''} ${
            descriptionError ? 'border-critical' : ''
          }`}
        />
        {askReplace && templates?.[askReplace] && (
          <div className="mt-1.5 flex flex-wrap items-center gap-2 rounded-lg border border-warning/50 px-3 py-2 text-xs text-ink-secondary">
            <span className="flex-1">
              Replace your description with the {templates[askReplace].label} skeleton? Your text
              will be lost.
            </span>
            <button
              type="button"
              onClick={() => {
                update('description', templates[askReplace].skeleton)
                setAskReplace(null)
              }}
              className="rounded-md border border-hairline px-2 py-1 font-medium text-ink transition hover:border-series1"
            >
              Replace
            </button>
            <button
              type="button"
              onClick={() => setAskReplace(null)}
              className="rounded-md px-2 py-1 text-ink-secondary transition hover:text-ink"
            >
              Keep my text
            </button>
          </div>
        )}
        {template?.required?.length > 0 && (
          <p className="mt-1.5 text-xs text-ink-muted">
            A {template.label.toLowerCase()} needs text under:{' '}
            {template.required.map((heading, index) => (
              <span key={heading}>
                {index > 0 && ', '}
                <code className="font-mono text-ink-secondary">{heading}</code>
              </span>
            ))}
          </p>
        )}
        {descriptionError && (
          <p id="description-error" role="alert" dir="auto" className="mt-1.5 text-sm text-critical">
            {descriptionError}
          </p>
        )}

        <div className="mt-4">
          <label className="block text-sm font-medium" htmlFor="parent">
            Subtask of <span className="font-normal text-ink-muted">(optional)</span>
          </label>
          <div className="mt-1.5">
            <TaskPicker
              id="parent"
              value={parent}
              onChange={setParent}
              accept={subtaskRefusal}
              clearLabel="Clear"
              placeholder="Search open tasks, or #ID"
            />
          </div>
          <p className="mt-1.5 text-xs text-ink-muted">
            Two levels only. The parent cannot reach Done while a subtask is open.
          </p>
        </div>

        <div className="mt-4 grid gap-4 sm:grid-cols-3">
          <div>
            <label className="block text-sm font-medium" htmlFor="side">
              Side
            </label>
            <select
              id="side"
              value={form.side}
              onChange={(event) => update('side', event.target.value)}
              className={inputClass}
            >
              <option value="">None</option>
              {SIDES.map((side) => (
                <option key={side} value={side}>
                  {SIDE_LABELS[side]}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium" htmlFor="priority">
              Priority
            </label>
            <select
              id="priority"
              value={form.priority}
              onChange={(event) => update('priority', event.target.value)}
              className={inputClass}
            >
              {PRIORITIES.map((priority) => (
                <option key={priority} value={priority}>
                  {PRIORITY_LABELS[priority]}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium" htmlFor="due_date">
              Due date
            </label>
            <input
              id="due_date"
              type="date"
              value={form.due_date}
              onChange={(event) => update('due_date', event.target.value)}
              className={inputClass}
            />
          </div>
        </div>

        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div>
            <label className="block text-sm font-medium" htmlFor="tags">
              Tags <span className="font-normal text-ink-muted">(comma separated)</span>
            </label>
            <input
              id="tags"
              dir="auto"
              placeholder="auth, release:v1"
              value={form.tags}
              onChange={(event) => update('tags', event.target.value)}
              className={inputClass}
            />
          </div>
          <div>
            <label className="block text-sm font-medium" htmlFor="areas">
              Areas <span className="font-normal text-ink-muted">(one path per line)</span>
            </label>
            <textarea
              id="areas"
              rows={2}
              dir="ltr"
              placeholder="frontend/src/pages"
              value={form.areas}
              onChange={(event) => update('areas', event.target.value)}
              className={`${inputClass} font-mono text-xs`}
            />
          </div>
        </div>

        <label className="mt-4 block text-sm font-medium" htmlFor="criteria">
          Acceptance criteria <span className="font-normal text-ink-muted">(one per line)</span>
        </label>
        <textarea
          id="criteria"
          rows={3}
          dir="auto"
          placeholder={'The page loads in Arabic and English\nTests cover the empty state'}
          value={form.criteria}
          onChange={(event) => update('criteria', event.target.value)}
          className={inputClass}
        />
        <p className="mt-1.5 text-xs text-ink-muted">
          Each line becomes a numbered criterion. Review and Done stay locked until every one is
          met (with evidence) or dropped.
        </p>
        {template?.criteria?.length > 0 &&
          (form.criteria.trim() ? (
            <p className="mt-1 text-xs text-ink-muted">
              Your criteria replace the {template.label.toLowerCase()} template’s starter criteria.
            </p>
          ) : (
            <div className="mt-2 rounded-lg border border-hairline bg-surface-raised px-3 py-2">
              <p className={`text-xs ${form.use_template ? 'text-ink-secondary' : 'text-ink-muted line-through'}`}>
                With the box empty, these {template.label.toLowerCase()} criteria get added:
              </p>
              <ol
                className={`mt-1 list-decimal space-y-0.5 ps-5 text-xs ${
                  form.use_template ? 'text-ink-secondary' : 'text-ink-muted line-through'
                }`}
              >
                {template.criteria.map((text) => (
                  <li key={text} dir="auto">{text}</li>
                ))}
              </ol>
              <label className="mt-2 inline-flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={!form.use_template}
                  onChange={(event) => update('use_template', !event.target.checked)}
                />
                No template criteria
              </label>
            </div>
          ))}

        <div className="mt-4">
          <PointsPicker value={form.points} onChange={(points) => update('points', points)} />
        </div>

        {isLead && (
          <>
            <fieldset className="mt-4">
              <legend className="text-sm font-medium">Starts in</legend>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {CREATE_STATUSES.map((status) => (
                  <label
                    key={status}
                    className={`flex-1 cursor-pointer rounded-lg border px-3 py-2 text-sm transition ${
                      form.status === status
                        ? 'border-series1 bg-series1/5 text-series1'
                        : 'border-hairline text-ink-secondary hover:text-ink'
                    }`}
                  >
                    <input
                      type="radio"
                      name="status"
                      value={status}
                      checked={form.status === status}
                      onChange={() => update('status', status)}
                      className="sr-only"
                    />
                    {STATUS_LABELS[status]}
                  </label>
                ))}
              </div>
              <p className="mt-1.5 text-xs text-ink-muted">{STATUS_HINTS[form.status]}</p>
            </fieldset>

            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <div>
                <label className="block text-sm font-medium" htmlFor="assignee_1">
                  Assignee
                </label>
                <select
                  id="assignee_1"
                  value={form.assignee_1_id}
                  onChange={(event) => {
                    const value = event.target.value
                    setForm((current) => ({
                      ...current,
                      assignee_1_id: value,
                      assignee_2_id:
                        !value || value === current.assignee_2_id ? '' : current.assignee_2_id,
                    }))
                  }}
                  className={inputClass}
                >
                  <option value="">Unassigned</option>
                  {programmers.map((person) => (
                    <option key={person.id} value={person.id}>
                      {person.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium" htmlFor="assignee_2">
                  Second assignee <span className="font-normal text-ink-muted">(optional)</span>
                </label>
                <select
                  id="assignee_2"
                  value={form.assignee_2_id}
                  disabled={!form.assignee_1_id}
                  onChange={(event) => update('assignee_2_id', event.target.value)}
                  className={`${inputClass} disabled:opacity-50`}
                >
                  <option value="">None</option>
                  {secondChoices.map((person) => (
                    <option key={person.id} value={person.id}>
                      {person.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <p className="mt-2 text-xs text-ink-muted">
              Two assignees share one task. Both see it, and either can move it forward.
            </p>

            <div className="mt-4 space-y-2 text-sm">
              <label className="flex items-start gap-2">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={form.restricted}
                  onChange={(event) => update('restricted', event.target.checked)}
                />
                <span>
                  Restricted
                  <span className="block text-xs text-ink-muted">Only leads can see it.</span>
                </span>
              </label>
              <label className="flex items-start gap-2">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={form.pool}
                  onChange={(event) => update('pool', event.target.checked)}
                />
                <span>
                  Pool
                  <span className="block text-xs text-ink-muted">
                    Any member may claim it, not only its assignees.
                  </span>
                </span>
              </label>
            </div>
          </>
        )}

        {error && (
          <p role="alert" dir="auto" className="mt-4 text-sm text-critical">
            {error}
          </p>
        )}

        <div className="mt-6 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-hairline px-4 py-2 text-sm text-ink-secondary transition hover:text-ink"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={saving}
            className="rounded-lg bg-series1 px-4 py-2 text-sm font-medium text-white transition hover:opacity-90 disabled:opacity-60"
          >
            {saving ? 'Creating…' : 'Create task'}
          </button>
        </div>
      </form>
    </Modal>
  )
}
