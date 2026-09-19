import { useState } from 'react'
import { fromDateInputValue } from '../../lib/format'

const PRESETS = [
  { label: 'Last 7 days', days: 7 },
  { label: 'Last 30 days', days: 30 },
  { label: 'Last 90 days', days: 90 },
  { label: 'Last 12 months', days: 365 },
]

function rangeForDays(days) {
  const end = new Date()
  const start = new Date(end)
  start.setDate(end.getDate() - days)
  return {
    range_start: start.toISOString().slice(0, 19),
    range_end: end.toISOString().slice(0, 19),
  }
}

export { rangeForDays }

/** Presets in one row above the charts, with a custom range behind a divider. */
export default function DateRangeFilter({ activePreset, onPreset, onCustom }) {
  const [custom, setCustom] = useState({ from: '', to: '' })

  function applyCustom(event) {
    event.preventDefault()
    if (!custom.from || !custom.to) return
    onCustom({
      range_start: fromDateInputValue(custom.from),
      range_end: fromDateInputValue(custom.to, true),
    })
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {PRESETS.map((preset) => (
        <button
          key={preset.days}
          type="button"
          onClick={() => onPreset(preset.days)}
          aria-pressed={activePreset === preset.days}
          className={`rounded-lg border px-3 py-1.5 text-xs transition ${
            activePreset === preset.days
              ? 'border-series1 text-series1'
              : 'border-hairline text-ink-secondary hover:text-ink'
          }`}
        >
          {preset.label}
        </button>
      ))}

      <form onSubmit={applyCustom} className="flex items-center gap-1.5 border-l border-hairline pl-2">
        <input
          type="date"
          aria-label="Range start"
          value={custom.from}
          onChange={(event) => setCustom((c) => ({ ...c, from: event.target.value }))}
          className="rounded-lg border border-hairline bg-surface-raised px-2 py-1 text-xs outline-none focus:border-series1"
        />
        <span className="text-xs text-ink-muted">to</span>
        <input
          type="date"
          aria-label="Range end"
          value={custom.to}
          onChange={(event) => setCustom((c) => ({ ...c, to: event.target.value }))}
          className="rounded-lg border border-hairline bg-surface-raised px-2 py-1 text-xs outline-none focus:border-series1"
        />
        <button
          type="submit"
          disabled={!custom.from || !custom.to}
          className="rounded-lg border border-hairline px-2.5 py-1 text-xs text-ink-secondary transition hover:text-ink disabled:opacity-40"
        >
          Apply
        </button>
      </form>
    </div>
  )
}
