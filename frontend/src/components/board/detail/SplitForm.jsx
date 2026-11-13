import { useState } from 'react'
import { api } from '../../../api/client'
import {
  POINT_LABELS,
  POINT_VALUES,
  SIDES,
  SIDE_LABELS,
  assignablePeople,
  isClosed,
} from '../../../lib/constants'
import { primaryButton, secondaryButton, sectionTitle, smallInputClass } from './ui'

function emptyPart() {
  return { on: false, title: '', assignee_id: '', points: '', criteria: '' }
}

/**
 * POST /tasks/{id}/split: one subtask per ticked side. Leads may assign each
 * part; a member's parts all go to the pool for their side. `order` rows make
 * one part block another ("Backend before Frontend").
 */
export default function SplitForm({ ctx, onDone }) {
  const { task, people, isLead, busy, run, onOtherChanged } = ctx
  const [parts, setParts] = useState(() => Object.fromEntries(SIDES.map((s) => [s, emptyPart()])))
  const [order, setOrder] = useState([])

  // Sides an open subtask already covers; the server refuses them (409).
  const taken = new Set(
    (task.children ?? []).filter((c) => c.side && !isClosed(c.status)).map((c) => c.side),
  )
  const ticked = SIDES.filter((side) => parts[side].on)
  const programmers = assignablePeople(people)

  function updatePart(side, field, value) {
    setParts((current) => ({ ...current, [side]: { ...current[side], [field]: value } }))
  }

  function toggle(side, on) {
    updatePart(side, 'on', on)
    // Drop order rows that name a side no longer ticked.
    if (!on) setOrder((rows) => rows.filter((row) => row.before !== side && row.after !== side))
  }

  function updateRow(index, field, value) {
    setOrder((rows) => rows.map((row, i) => (i === index ? { ...row, [field]: value } : row)))
  }

  const badRow = order.some((row) => !row.before || !row.after || row.before === row.after)

  async function submit(event) {
    event.preventDefault()
    const payload = {
      parts: ticked.map((side) => {
        const part = parts[side]
        const out = { side }
        if (part.title.trim()) out.title = part.title.trim()
        if (isLead && part.assignee_id) out.assignee_id = Number(part.assignee_id)
        if (part.points) out.points = Number(part.points)
        const criteria = part.criteria.split('\n').map((line) => line.trim()).filter(Boolean)
        if (criteria.length) out.criteria = criteria
        return out
      }),
      order: order.map(({ before, after }) => ({ before, after })),
    }
    const ok = await run(() => api.splitTask(task.id, payload), {
      success: `Split into ${ticked.length} part${ticked.length === 1 ? '' : 's'}.`,
    })
    if (!ok) return
    // Put the new parts on the board.
    if (onOtherChanged) {
      api
        .tasks({ parent_id: task.id })
        .then((list) => list.forEach((child) => onOtherChanged(child)))
        .catch(() => {})
    }
    onDone()
  }

  return (
    <form onSubmit={submit} className="mt-2 space-y-4 rounded-lg border border-hairline p-3">
      <div>
        <p className="text-sm font-medium">Split by side</p>
        <p className="mt-0.5 text-xs text-ink-muted">
          Each part becomes a subtask with this task’s priority, tags, areas and due date.
          {isLead
            ? ' A part without an assignee goes to the pool for its side.'
            : ' Your parts go to the pool for their side; a lead assigns people.'}
        </p>
      </div>

      <fieldset>
        <legend className={sectionTitle}>Sides</legend>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {SIDES.map((side) => {
            const covered = taken.has(side)
            return (
              <label
                key={side}
                title={covered ? 'An open subtask already covers this side' : undefined}
                className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-sm transition ${
                  covered
                    ? 'cursor-not-allowed border-hairline text-ink-muted opacity-50'
                    : parts[side].on
                      ? 'cursor-pointer border-series1 bg-series1/5 text-series1'
                      : 'cursor-pointer border-hairline text-ink-secondary hover:text-ink'
                }`}
              >
                <input
                  type="checkbox"
                  disabled={covered}
                  checked={parts[side].on}
                  onChange={(e) => toggle(side, e.target.checked)}
                  className="sr-only"
                />
                {SIDE_LABELS[side]}
                {covered && <span className="text-[11px]">(has a part)</span>}
              </label>
            )
          })}
        </div>
      </fieldset>

      {ticked.map((side) => {
        const part = parts[side]
        const onSide = programmers.filter((p) => (p.sides ?? []).includes(side))
        const others = programmers.filter((p) => !(p.sides ?? []).includes(side))
        return (
          <div key={side} className="rounded-lg border border-hairline bg-surface-raised p-3">
            <p className="text-sm font-medium">{SIDE_LABELS[side]}</p>
            <div className={`mt-2 grid gap-2 ${isLead ? 'sm:grid-cols-[1fr_12rem_9rem]' : 'sm:grid-cols-[1fr_9rem]'}`}>
              <input
                aria-label={`${SIDE_LABELS[side]} title`}
                dir="auto"
                maxLength={200}
                placeholder={`${task.title} (${SIDE_LABELS[side]})`}
                value={part.title}
                onChange={(e) => updatePart(side, 'title', e.target.value)}
                className={smallInputClass}
              />
              {isLead && (
                <select
                  aria-label={`${SIDE_LABELS[side]} assignee`}
                  value={part.assignee_id}
                  onChange={(e) => updatePart(side, 'assignee_id', e.target.value)}
                  className={smallInputClass}
                >
                  <option value="">Pool (unassigned)</option>
                  {onSide.length > 0 && (
                    <optgroup label={`Works on ${SIDE_LABELS[side]}`}>
                      {onSide.map((p) => (
                        <option key={p.id} value={p.id}>{p.name}</option>
                      ))}
                    </optgroup>
                  )}
                  {others.length > 0 && (
                    <optgroup label="Others">
                      {others.map((p) => (
                        <option key={p.id} value={p.id}>{p.name}</option>
                      ))}
                    </optgroup>
                  )}
                </select>
              )}
              <select
                aria-label={`${SIDE_LABELS[side]} points`}
                value={part.points}
                onChange={(e) => updatePart(side, 'points', e.target.value)}
                className={smallInputClass}
              >
                <option value="">Points: same ({task.points})</option>
                {POINT_VALUES.map((v) => (
                  <option key={v} value={v}>{v} · {POINT_LABELS[v]}</option>
                ))}
              </select>
            </div>
            <textarea
              aria-label={`${SIDE_LABELS[side]} criteria`}
              rows={2}
              dir="auto"
              placeholder="Acceptance criteria, one per line (optional)"
              value={part.criteria}
              onChange={(e) => updatePart(side, 'criteria', e.target.value)}
              className={`${smallInputClass} mt-2`}
            />
          </div>
        )
      })}

      {ticked.length >= 2 && (
        <fieldset>
          <legend className={sectionTitle}>Order</legend>
          <p className="mt-0.5 text-xs text-ink-muted">
            The part on the left blocks the part on the right until it closes.
          </p>
          <ul className="mt-1.5 space-y-1.5">
            {order.map((row, index) => (
              <li key={index} className="flex flex-wrap items-center gap-2 text-sm">
                <select
                  aria-label="Side that goes first"
                  value={row.before}
                  onChange={(e) => updateRow(index, 'before', e.target.value)}
                  className={`${smallInputClass} w-40`}
                >
                  {ticked.map((side) => (
                    <option key={side} value={side}>{SIDE_LABELS[side]}</option>
                  ))}
                </select>
                <span className="text-ink-secondary">before</span>
                <select
                  aria-label="Side that waits"
                  value={row.after}
                  onChange={(e) => updateRow(index, 'after', e.target.value)}
                  className={`${smallInputClass} w-40`}
                >
                  {ticked.map((side) => (
                    <option key={side} value={side}>{SIDE_LABELS[side]}</option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => setOrder((rows) => rows.filter((_, i) => i !== index))}
                  className="text-xs text-ink-secondary underline-offset-2 hover:text-ink hover:underline"
                >
                  Remove
                </button>
                {row.before === row.after && (
                  <span className="text-xs text-critical">Pick two different sides</span>
                )}
              </li>
            ))}
          </ul>
          {order.length < 8 && (
            <button
              type="button"
              onClick={() =>
                setOrder((rows) => [
                  ...rows,
                  // Backend before frontend is the usual case; start there when both are ticked.
                  ticked.includes('be') && ticked.includes('fe')
                    ? { before: 'be', after: 'fe' }
                    : { before: ticked[0], after: ticked[1] },
                ])
              }
              className={`${secondaryButton} mt-2`}
            >
              Add order
            </button>
          )}
        </fieldset>
      )}

      <div className="flex justify-end gap-2">
        <button type="button" onClick={onDone} className={secondaryButton}>Cancel</button>
        <button type="submit" disabled={busy || ticked.length === 0 || badRow} className={primaryButton}>
          {ticked.length > 0 ? `Split into ${ticked.length}` : 'Split'}
        </button>
      </div>
    </form>
  )
}
