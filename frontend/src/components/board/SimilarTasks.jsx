import { STATUS_LABELS, taskKey } from '../../lib/constants'

const BAND_STYLE = {
  duplicate: 'border-critical/50 text-critical',
  related: 'border-warning/60 text-warning',
  similar: 'border-hairline text-ink-secondary',
}

/** Tasks that look like the one being written, with a score and a link each. */
export default function SimilarTasks({ matches, loading = false, title = 'Similar tasks' }) {
  if (!loading && (!matches || matches.length === 0)) return null
  return (
    <div className="mt-3 rounded-lg border border-hairline bg-surface-raised px-3 py-2" aria-live="polite">
      <p className="text-xs font-medium text-ink-secondary">
        {title}
        {loading && <span className="ms-2 font-normal text-ink-muted">checking…</span>}
      </p>
      <ul className="mt-1 space-y-1">
        {(matches ?? []).map((m) => (
          <li key={m.id} className="flex flex-wrap items-center gap-2 text-xs">
            <span className={`rounded-full border px-1.5 py-0.5 tabular ${BAND_STYLE[m.band] ?? BAND_STYLE.similar}`}>
              {m.score}%
            </span>
            <a href={`/t/${m.id}`} target="_blank" rel="noreferrer" className="tabular text-series1 hover:underline">
              {taskKey(m.id)}
            </a>
            <span dir="auto" className="min-w-0 flex-1 truncate">{m.title}</span>
            <span className="text-ink-muted">{STATUS_LABELS[m.status] ?? m.status}</span>
            {m.area && (
              <span className={`text-ink-muted ${m.same_area ? '' : 'italic'}`}>
                {m.same_area ? m.area.name : `in ${m.area.name}`}
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}
