import { useState } from 'react'
import { api } from '../../../api/client'
import { ActorBadge, PlainText } from '../../Badges'
import { CRITERION_LABELS } from '../../../lib/constants'
import { formatDateTime } from '../../../lib/format'
import { linkButton, primaryButton, secondaryButton, smallInputClass } from './ui'

const STATE_STYLES = {
  open: 'border-hairline text-ink-secondary',
  met: 'border-good/40 text-good',
  dropped: 'border-hairline text-ink-muted line-through',
}

function CriterionRow({ ctx, criterion }) {
  const { task, isWorker, isViewer, busy, run } = ctx
  // null, 'met' or 'dropped': which inline form is open.
  const [mode, setMode] = useState(null)
  const [evidence, setEvidence] = useState(criterion.evidence ?? '')
  const canEdit = isWorker && !isViewer

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
            <PlainText className="text-[13px] text-ink-secondary">{criterion.evidence}</PlainText>
          </div>
        )}
        {criterion.checked_at && (
          <p className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs text-ink-muted">
            Checked {formatDateTime(criterion.checked_at)}
            {criterion.checked_kind && <ActorBadge kind={criterion.checked_kind} />}
          </p>
        )}

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
  const { task, isWorker, isViewer, closed, busy, run } = ctx
  const [text, setText] = useState('')
  const open = criteria.filter((c) => c.state === 'open').length
  const met = criteria.filter((c) => c.state === 'met').length

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

      {criteria.length > 0 && (
        <ol className="space-y-2">
          {criteria.map((criterion) => (
            <CriterionRow key={criterion.id} ctx={ctx} criterion={criterion} />
          ))}
        </ol>
      )}

      {isWorker && !isViewer && !closed && (
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
