import { useState } from 'react'
import Modal from '../Modal'
import { PRIORITIES, PRIORITY_LABELS } from '../../lib/constants'
import { fromDateInputValue } from '../../lib/format'

const inputClass =
  'mt-1.5 w-full rounded-lg border border-hairline bg-surface-raised px-3 py-2 text-sm outline-none focus:border-series1'

export default function CreateTaskModal({ programmers, onClose, onCreate }) {
  const [form, setForm] = useState({
    title: '',
    description: '',
    priority: 'medium',
    due_date: '',
    assignee_1_id: '',
    assignee_2_id: '',
  })
  const [error, setError] = useState(null)
  const [saving, setSaving] = useState(false)

  function update(field, value) {
    setForm((current) => ({ ...current, [field]: value }))
  }

  async function handleSubmit(event) {
    event.preventDefault()
    setError(null)
    setSaving(true)
    try {
      await onCreate({
        title: form.title.trim(),
        description: form.description.trim() || null,
        priority: form.priority,
        due_date: fromDateInputValue(form.due_date, true),
        assignee_1_id: form.assignee_1_id ? Number(form.assignee_1_id) : null,
        assignee_2_id: form.assignee_2_id ? Number(form.assignee_2_id) : null,
      })
      onClose()
    } catch (err) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  // The second slot is for pairing, so it can't repeat the first assignee.
  const secondChoices = programmers.filter(
    (person) => String(person.id) !== form.assignee_1_id,
  )

  return (
    <Modal title="Create task" onClose={onClose} wide>
      <form onSubmit={handleSubmit}>
        <label className="block text-sm font-medium" htmlFor="title">
          Title
        </label>
        <input
          id="title"
          required
          maxLength={200}
          value={form.title}
          onChange={(event) => update('title', event.target.value)}
          className={inputClass}
        />

        <label className="mt-4 block text-sm font-medium" htmlFor="description">
          Description
        </label>
        <textarea
          id="description"
          rows={4}
          value={form.description}
          onChange={(event) => update('description', event.target.value)}
          className={inputClass}
        />

        <div className="mt-4 grid gap-4 sm:grid-cols-2">
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
            <label className="block text-sm font-medium" htmlFor="assignee_1">
              Assignee
            </label>
            <select
              id="assignee_1"
              value={form.assignee_1_id}
              onChange={(event) => {
                update('assignee_1_id', event.target.value)
                if (event.target.value === form.assignee_2_id) update('assignee_2_id', '')
                if (!event.target.value) update('assignee_2_id', '')
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
          Two assignees share one task — both see it, and either can move it forward.
        </p>

        {error && (
          <p role="alert" className="mt-4 text-sm text-critical">
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
