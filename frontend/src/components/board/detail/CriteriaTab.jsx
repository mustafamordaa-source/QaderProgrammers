import { useState } from 'react'
import { RichText } from '../../MarkdownPreview'
import { api } from '../../../api/client'
import { ActorBadge, PlainText, StatusBadge } from '../../Badges'
import { CRITERION_LABELS, taskKey } from '../../../lib/constants'
import { formatDateTime } from '../../../lib/format'
import { HandIcon, LockIcon, PartIcon } from '../BoardIcons'
import CrossSideTake from '../CrossSideTake'
import { linkButton, primaryButton, secondaryButton, smallInputClass } from './ui'

const STATE_STYLES = {
  open: 'border-hairline text-ink-secondary',
  met: 'border-good/40 text-good',
  dropped: 'border-hairline text-ink-muted line-through',
}

/** Who holds this part, through which subtask, and how far it is. */
function PartTaken({ subtask, openTask }) {
  const holder = subtask.claim_holder || subtask.assignees?.[0] || null
  return (
    <p className="mt-2 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-ink-secondary">
      <PartIcon className="h-3 w-3 text-ink-muted" />
      <span dir="auto">{holder ? `Taken by @${holder}` : 'Taken'}</span>
      <span aria-hidden="true">·</span>
      <a
        href={`/t/${subtask.id}`}
        onClick={(event) => {
          event.preventDefault()
          openTask(subtask.id)
        }}
        className="tabular text-series1 hover:underline"
      >
        {taskKey(subtask.id)}
      </a>
      {subtask.status && <StatusBadge status={subtask.status} />}
    </p>
  )
}

/**
 * Take this part: the server makes a subtask for it and claims that for you.
 * The answer (or the reason it was refused) shows on the row itself.
 */
function TakePart({ ctx, criterion }) {
  const { task, busy, reload, onOtherChanged } = ctx
  const [taking, setTaking] = useState(false)
  const [error, setError] = useState(null)
  const [done, setDone] = useState(null)

  async function take() {
    setError(null)
    setDone(null)
    setTaking(true)
    try {
      const subtask = await api.takePart(task.id, criterion.n)
      onOtherChanged?.(subtask)
      await reload()
      setDone(
        subtask?.warnings?.length
          ? `You took part ${criterion.n} as ${taskKey(subtask.id)}, with warnings: ${subtask.warnings.join(' ')}`
          : `You took part ${criterion.n}. ${taskKey(subtask.id)} is in progress and yours.`,
      )
    } catch (err) {
      setError(err.message)
      await reload()
    } finally {
      setTaking(false)
    }
  }

  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={take}
        disabled={busy || taking}
        title="Make a subtask for this part, claimed by you"
        className={`${secondaryButton} inline-flex items-center gap-1.5 border-series1/50 text-series1`}
      >
        <HandIcon />
        {taking ? 'Taking…' : 'Take this part'}
      </button>
      {error && (
        <p role="alert" dir="auto" className="mt-1.5 text-xs text-critical">
          {error}
        </p>
      )}
      {done && (
        <p role="status" dir="auto" className="mt-1.5 text-xs text-good">
          {done}
        </p>
      )}
    </div>
  )
}

/** The side rule alone stops this part (the task allows a cross-side claim). */
function crossSidePart(task, criterion) {
  return task.cross_side_ok === true && /your profile lists/i.test(criterion.take_block_text ?? '')
}

/** A part blocked only by the side rule: take it across sides with a reason. */
function TakePartAcross({ ctx, criterion }) {
  const { task, busy, reload, onOtherChanged } = ctx
  const [done, setDone] = useState(null)

  async function take(crossSideReason) {
    setDone(null)
    let subtask
    try {
      subtask = await api.takePart(task.id, criterion.n, { cross_side_reason: crossSideReason })
    } catch (err) {
      await reload()
      throw err
    }
    onOtherChanged?.(subtask)
    await reload()
    setDone(`You took part ${criterion.n} across sides as ${taskKey(subtask.id)}. The hub posted your reason as a note.`)
  }

  return (
    <div className="mt-2">
      {done ? (
        <p role="status" dir="auto" className="text-xs text-good">
          {done}
        </p>
      ) : (
        <CrossSideTake disabled={busy} onSubmit={take} />
      )}
    </div>
  )
}

function CriterionRow({ ctx, criterion }) {
  const { task, isWorker, isReadOnly, busy, run, openTask } = ctx
  // null, 'met' or 'dropped': which inline form is open.
  const [mode, setMode] = useState(null)
  const [evidence, setEvidence] = useState(criterion.evidence ?? '')
  const canEdit = isWorker && !isReadOnly

  async function submit(event) {
    event.preventDefault()
    const payload = { state: mode }
    if (evidence.trim()) payload.evidence = evidence.trim()
    const ok = await run(() => api.updateCriterion(task.id, criterion.n, payload), {
      reloadAfter: true,
    })
    if (ok) setMode(null)
  }

  return (
    <li className="flex gap-3 rounded-lg border border-hairline p-3">
      <span className="tabular mt-0.5 w-6 shrink-0 text-right text-sm font-semibold text-ink-muted">
        {criterion.n}.
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <PlainText
            className={`min-w-0 flex-1 text-sm ${criterion.state === 'dropped' ? 'text-ink-muted line-through' : ''}`}
          >
            {criterion.text}
          </PlainText>
          <span
            className={`shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-medium ${STATE_STYLES[criterion.state]}`}
          >
            {CRITERION_LABELS[criterion.state] ?? criterion.state}
          </span>
        </div>

        {criterion.evidence && (
          <div className="mt-2 rounded-md border border-hairline bg-surface-raised px-2.5 py-1.5">
            <span className="text-[11px] font-medium uppercase tracking-wide text-ink-muted">Evidence</span>
            <RichText className="text-[13px] text-ink-secondary">{criterion.evidence}</RichText>
          </div>
        )}
        {criterion.checked_at && (
          <p className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs text-ink-muted">
            Checked {formatDateTime(criterion.checked_at)}
            {criterion.checked_kind && <ActorBadge kind={criterion.checked_kind} />}
          </p>
        )}

        {criterion.subtask ? (
          <PartTaken subtask={criterion.subtask} openTask={openTask} />
        ) : criterion.state === 'open' && criterion.can_take && !isReadOnly ? (
          <TakePart ctx={ctx} criterion={criterion} />
        ) : criterion.state === 'open' && criterion.take_block_text ? (
          <p dir="auto" className="mt-2 flex items-start gap-1.5 text-xs text-ink-muted">
            <LockIcon className="mt-0.5 h-3 w-3" />
            <span>{criterion.take_block_text}</span>
          </p>
        ) : null}
        {!criterion.subtask &&
          criterion.state === 'open' &&
          !criterion.can_take &&
          !isReadOnly &&
          crossSidePart(task, criterion) && <TakePartAcross ctx={ctx} criterion={criterion} />}

        {canEdit && !mode && (
          <div className="mt-2 flex flex-wrap gap-3">
            {criterion.state === 'open' ? (
              <>
                <button type="button" className={linkButton} disabled={busy} onClick={() => setMode('met')}>
                  Mark met
                </button>
                <button type="button" className={linkButton} disabled={busy} onClick={() => setMode('dropped')}>
                  Drop
                </button>
              </>
            ) : (
              <button
                type="button"
                className={linkButton}
                disabled={busy}
                onClick={() =>
                  run(() => api.updateCriterion(task.id, criterion.n, { state: 'open' }), {
                    reloadAfter: true,
                  })
                }
              >
                Reopen
              </button>
            )}
          </div>
        )}

        {mode && (
          <form onSubmit={submit} className="mt-2 space-y-2">
            <label className="block text-xs font-medium" htmlFor={`evidence-${criterion.n}`}>
              {mode === 'met'
                ? 'Evidence: the command and its result, a commit or a PR link (required)'
                : 'Why drop it? (optional)'}
            </label>
            <textarea
              id={`evidence-${criterion.n}`}
              rows={3}
              dir="auto"
              autoFocus
              maxLength={4000}
              required={mode === 'met'}
              value={evidence}
              onChange={(e) => setEvidence(e.target.value)}
              className={smallInputClass}
            />
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setMode(null)} className={secondaryButton}>
                Cancel
              </button>
              <button
                type="submit"
                disabled={busy || (mode === 'met' && !evidence.trim())}
                className={primaryButton}
              >
                {mode === 'met' ? 'Mark met' : 'Drop criterion'}
              </button>
            </div>
          </form>
        )}
      </div>
    </li>
  )
}

export default function CriteriaTab({ ctx, criteria }) {
  const { task, isWorker, isReadOnly, closed, busy, run } = ctx
  const [text, setText] = useState('')
  const open = criteria.filter((c) => c.state === 'open').length
  const met = criteria.filter((c) => c.state === 'met').length
  const taken = criteria.filter((c) => c.subtask).length
  const partsOpen = criteria.some((c) => c.can_take)

  async function add(event) {
    event.preventDefault()
    const ok = await run(() => api.addCriterion(task.id, text.trim()), { reloadAfter: true })
    if (ok) setText('')
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-ink-secondary">
        {criteria.length === 0
          ? 'No acceptance criteria yet.'
          : `${met} met, ${open} open, ${criteria.length - met - open} dropped. Review and Done stay locked while any is open.`}
      </p>
      {(taken > 0 || partsOpen) && (
        <p className="text-xs text-ink-muted">
          Each criterion is a part one person can take. Taking a part makes a subtask for it, claimed by you; the
          part is marked met when that subtask is approved. {taken} of {criteria.length} part
          {criteria.length === 1 ? '' : 's'} taken.
        </p>
      )}

      {criteria.length > 0 && (
        <ol className="space-y-2">
          {criteria.map((criterion) => (
            <CriterionRow key={criterion.id} ctx={ctx} criterion={criterion} />
          ))}
        </ol>
      )}

      {isWorker && !isReadOnly && !closed && (
        <form onSubmit={add} className="flex flex-wrap items-start gap-2">
          <textarea
            aria-label="New criterion"
            rows={2}
            dir="auto"
            maxLength={1000}
            placeholder="Add a checkable line of done"
            value={text}
            onChange={(e) => setText(e.target.value)}
            className={`${smallInputClass} min-w-[16rem] flex-1`}
          />
          <button type="submit" disabled={busy || !text.trim()} className={primaryButton}>
            Add
          </button>
        </form>
      )}
    </div>
  )
}
