// Shared Recharts chrome. Colours are CSS custom properties rather than literal
// hex, so SVG marks pick up the light/dark token swap with no JS involved.
export const axisProps = {
  tick: { fill: 'var(--text-muted)', fontSize: 11 },
  tickLine: false,
  axisLine: { stroke: 'var(--baseline)' },
}

export const gridProps = {
  stroke: 'var(--grid)',
  strokeDasharray: '0',
  vertical: false,
}

export const SERIES_1 = 'var(--series-1)'

/** Tooltip styled from the design tokens; Recharts' default ignores them. */
export function Tooltip({ active, payload, label, formatter }) {
  if (!active || !payload?.length) return null
  return (
    <div className="rounded-lg border border-hairline bg-surface px-3 py-2 text-xs shadow-lg">
      <p className="font-medium text-ink">{label}</p>
      {payload.map((entry) => (
        <p key={entry.dataKey} className="tabular mt-0.5 text-ink-secondary">
          {formatter ? formatter(entry.value) : entry.value}
        </p>
      ))}
    </div>
  )
}

export const EmptyState = ({ children = 'No data in this range.' }) => (
  <div className="grid h-[200px] place-items-center text-sm text-ink-muted">{children}</div>
)
