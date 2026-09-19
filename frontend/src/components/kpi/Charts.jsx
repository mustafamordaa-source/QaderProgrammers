import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip as RechartsTooltip,
  XAxis,
  YAxis,
} from 'recharts'
import ChartCard from './ChartCard'
import { EmptyState, SERIES_1, Tooltip, axisProps, gridProps } from './chartTheme'
import { STATUS_SHORT_LABELS } from '../../lib/constants'
import { formatHours, formatWeekKey } from '../../lib/format'

const HEIGHT = 220

/**
 * One unit for the whole axis, chosen from the largest value. Formatting each
 * tick independently produced axes that read "0h, 30h, 3d, 4d" — the same scale
 * in two units, with the day figures rounded past the point of being true.
 */
function durationAxis(values) {
  const max = Math.max(0, ...values)
  return max >= 48
    ? { formatter: (value) => `${(value / 24).toFixed(1)}d` }
    : { formatter: (value) => `${Math.round(value)}h` }
}

/**
 * Completions per week. One measure over time with a natural zero, so bars —
 * and one series, so the title names it and no legend is needed.
 */
export function CompletionsChart({ perWeek }) {
  const data = Object.entries(perWeek).map(([week, count]) => ({
    week,
    label: formatWeekKey(week),
    count,
  }))

  return (
    <ChartCard
      title="Tasks completed per week"
      subtitle="By the week the task was closed"
      table={{
        columns: ['Week of', 'Completed'],
        rows: data.map((row) => [row.label, row.count]),
      }}
    >
      {data.length === 0 ? (
        <EmptyState />
      ) : (
        <ResponsiveContainer width="100%" height={HEIGHT}>
          <BarChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: -18 }}>
            <CartesianGrid {...gridProps} />
            <XAxis dataKey="label" {...axisProps} />
            <YAxis allowDecimals={false} {...axisProps} />
            <RechartsTooltip
              cursor={{ fill: 'var(--surface-2)' }}
              content={<Tooltip formatter={(value) => `${value} completed`} />}
            />
            {/* 4px rounded ends at the data end only; the baseline stays square. */}
            <Bar dataKey="count" fill={SERIES_1} radius={[4, 4, 0, 0]} maxBarSize={44} />
          </BarChart>
        </ResponsiveContainer>
      )}
    </ChartCard>
  )
}

/** Average cycle time per week — change over time, so a line. */
export function CycleTimeTrend({ perWeek }) {
  const data = Object.entries(perWeek).map(([week, hours]) => ({
    week,
    label: formatWeekKey(week),
    hours,
  }))

  return (
    <ChartCard
      title="Average cycle time"
      subtitle="Created to closed, by the week the task was closed"
      table={{
        columns: ['Week of', 'Avg cycle time'],
        rows: data.map((row) => [row.label, formatHours(row.hours)]),
      }}
    >
      {data.length === 0 ? (
        <EmptyState />
      ) : (
        <ResponsiveContainer width="100%" height={HEIGHT}>
          <LineChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: -12 }}>
            <CartesianGrid {...gridProps} />
            <XAxis dataKey="label" {...axisProps} />
            <YAxis {...axisProps} width={52} tickFormatter={durationAxis(data.map((d) => d.hours)).formatter} />
            <RechartsTooltip
              cursor={{ stroke: 'var(--baseline)', strokeWidth: 1 }}
              content={<Tooltip formatter={formatHours} />}
            />
            <Line
              type="monotone"
              dataKey="hours"
              stroke={SERIES_1}
              strokeWidth={2}
              dot={{ r: 4, fill: SERIES_1, stroke: 'var(--surface-1)', strokeWidth: 2 }}
              activeDot={{ r: 5 }}
            />
          </LineChart>
        </ResponsiveContainer>
      )}
    </ChartCard>
  )
}

/**
 * Dwell time per stage. The categories are named, not ordered in time, so the
 * bars run horizontally and each one is direct-labelled.
 */
export function TimeInStatusChart({ perStatus }) {
  const data = Object.entries(perStatus)
    .filter(([, hours]) => hours !== null && hours !== undefined)
    .map(([status, hours]) => ({
      status,
      label: STATUS_SHORT_LABELS[status] ?? status,
      hours,
    }))

  return (
    <ChartCard
      title="Average time in each stage"
      subtitle="How long a task waits before moving on"
      table={{
        columns: ['Stage', 'Average'],
        rows: data.map((row) => [row.label, formatHours(row.hours)]),
      }}
    >
      {data.length === 0 ? (
        <EmptyState />
      ) : (
        <ResponsiveContainer width="100%" height={HEIGHT}>
          <BarChart
            data={data}
            layout="vertical"
            margin={{ top: 4, right: 48, bottom: 0, left: 8 }}
          >
            <XAxis type="number" hide />
            <YAxis type="category" dataKey="label" width={56} {...axisProps} />
            <RechartsTooltip
              cursor={{ fill: 'var(--surface-2)' }}
              content={<Tooltip formatter={formatHours} />}
            />
            <Bar
              dataKey="hours"
              fill={SERIES_1}
              radius={[0, 4, 4, 0]}
              maxBarSize={24}
              label={{
                position: 'right',
                formatter: formatHours,
                fill: 'var(--text-secondary)',
                fontSize: 11,
              }}
            />
          </BarChart>
        </ResponsiveContainer>
      )}
    </ChartCard>
  )
}

/**
 * Per-programmer comparison. One measure at a time rather than several series
 * side by side: the measures have different units, and a single scale keeps the
 * comparison honest.
 */
const MEASURES = {
  completed: {
    label: 'Tasks completed',
    value: (report) => report.volume.completed_total,
    format: (value) => String(value),
    allowDecimals: false,
  },
  cycle: {
    label: 'Avg cycle time',
    value: (report) => report.speed.avg_cycle_time_hours ?? 0,
    format: formatHours,
    allowDecimals: true,
  },
  open: {
    label: 'Open tasks',
    value: (report) => report.volume.open_total,
    format: (value) => String(value),
    allowDecimals: false,
  },
}

export function ProgrammerComparison({ reports, measure, onMeasureChange, onSelect }) {
  const spec = MEASURES[measure]
  const data = reports
    .map((report) => ({
      id: report.user_id,
      label: report.user_name,
      value: spec.value(report),
    }))
    .sort((a, b) => b.value - a.value)

  return (
    <ChartCard
      title="By programmer"
      subtitle="Select a name to see their full breakdown"
      table={{
        columns: ['Programmer', spec.label],
        rows: data.map((row) => [row.label, spec.format(row.value)]),
      }}
    >
      <div className="mb-3 flex flex-wrap gap-1.5">
        {Object.entries(MEASURES).map(([key, item]) => (
          <button
            key={key}
            type="button"
            onClick={() => onMeasureChange(key)}
            aria-pressed={measure === key}
            className={`rounded-md border px-2.5 py-1 text-[11px] transition ${
              measure === key
                ? 'border-series1 text-series1'
                : 'border-hairline text-ink-secondary hover:text-ink'
            }`}
          >
            {item.label}
          </button>
        ))}
      </div>

      {data.length === 0 ? (
        <EmptyState>No programmers yet.</EmptyState>
      ) : (
        <ResponsiveContainer width="100%" height={Math.max(HEIGHT, data.length * 44)}>
          <BarChart
            data={data}
            layout="vertical"
            margin={{ top: 4, right: 52, bottom: 0, left: 8 }}
          >
            <XAxis type="number" hide allowDecimals={spec.allowDecimals} />
            <YAxis type="category" dataKey="label" width={110} {...axisProps} />
            <RechartsTooltip
              cursor={{ fill: 'var(--surface-2)' }}
              content={<Tooltip formatter={spec.format} />}
            />
            <Bar
              dataKey="value"
              fill={SERIES_1}
              radius={[0, 4, 4, 0]}
              maxBarSize={24}
              onClick={(entry) => onSelect?.(entry.id)}
              className="cursor-pointer"
              label={{
                position: 'right',
                formatter: spec.format,
                fill: 'var(--text-secondary)',
                fontSize: 11,
              }}
            />
          </BarChart>
        </ResponsiveContainer>
      )}
    </ChartCard>
  )
}

/** Current open work by stage. A plain list — five numbers don't need a plot. */
export function OpenByStatus({ openByStatus, openTotal }) {
  const entries = Object.entries(openByStatus)
  const max = Math.max(1, ...entries.map(([, count]) => count))

  return (
    <div className="rounded-xl border border-hairline bg-surface p-4">
      <h3 className="text-sm font-semibold">Open work right now</h3>
      <p className="mt-0.5 text-xs text-ink-muted">
        {openTotal} task{openTotal === 1 ? '' : 's'} not yet closed
      </p>
      <ul className="mt-3 space-y-2">
        {entries.map(([status, count]) => (
          <li key={status} className="flex items-center gap-3">
            <span className="w-14 shrink-0 text-xs text-ink-secondary">
              {STATUS_SHORT_LABELS[status] ?? status}
            </span>
            <span className="h-2 flex-1 overflow-hidden rounded-full bg-surface-raised">
              <span
                className="block h-full rounded-full bg-series1"
                style={{ width: `${(count / max) * 100}%` }}
              />
            </span>
            <span className="tabular w-6 shrink-0 text-right text-xs text-ink">{count}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
