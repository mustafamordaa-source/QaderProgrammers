/**
 * A single headline figure. No plot, so no hover layer — the value is the whole
 * message. `tone` uses the reserved status palette and always ships alongside
 * the caption text, so it never carries meaning on its own.
 */
const TONE_CLASS = {
  neutral: 'text-ink',
  good: 'text-good',
  warning: 'text-warning',
  critical: 'text-critical',
}

export default function StatTile({ label, value, caption, tone = 'neutral' }) {
  return (
    <div className="rounded-xl border border-hairline bg-surface p-4">
      <h3 className="text-xs font-medium uppercase tracking-wide text-ink-secondary">
        {label}
      </h3>
      <p className={`mt-2 text-3xl font-semibold leading-none ${TONE_CLASS[tone]}`}>
        {value}
      </p>
      {caption && <p className="mt-2 text-xs leading-snug text-ink-muted">{caption}</p>}
    </div>
  )
}

/** Thresholds for the rate tiles, so colour and wording stay in step. */
export function rateTone(rate, { higherIsBetter = true, good = 0.8, poor = 0.5 } = {}) {
  if (rate === null || rate === undefined) return 'neutral'
  const score = higherIsBetter ? rate : 1 - rate
  if (score >= good) return 'good'
  if (score >= poor) return 'warning'
  return 'critical'
}
