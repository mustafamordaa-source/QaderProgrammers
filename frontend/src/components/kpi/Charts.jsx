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
 * Throughput per week, measured in points. One measure over time with a natural
 * zero, so bars — and one series, so the title names it and no legend is needed.
 *
 * Points rather than task counts, because a week of three 13-pointers is not
 * the same week as three 1-pointers. The task count rides along in the tooltip
 * and the table so the item view is still one click away.
 */
export function CompletionsChart({ perWeek, pointsPerWeek }) {
  const data = Object.keys({ ...pointsPerWeek, ...perWeek })
    .sort()
    .map((week) => ({
      week,
      label: formatWeekKey(week),
      points: pointsPerWeek[week] ?? 0,
      count: perWeek[week] ?? 0,
    }))

  return (
    <ChartCard
      title="Points completed per week"
      subtitle="Difficulty-weighted throughput, by the week the task was closed"
      table={{
        columns: ['Week of', 'Points', 'Tasks'],
        rows: data.map((row) => [row.label, row.points, row.count]),
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
              content={
                <Tooltip
                  formatter={(value, entry) =>
                    `${value} point${value === 1 ? '' : 's'} · ${entry?.count ?? 0} task${
                      entry?.count === 1 ? '' : 's'
                    }`
                  }
                />
              }
            />
            {/* 4px rounded ends at the data end only; the baseline stays square. */}
            <Bar dataKey="points" fill={SERIES_1} radius={[4, 4, 0, 0]} maxBarSize={44} />
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
  points: {
    label: 'Points completed',
    value: (report) => report.volume.points_completed,
    format: (value) => `${value} pts`,
    allowDecimals: false,
  },
  completed: {
    label: 'Tasks completed',
    value: (report) => report.volume.completed_total,
    format: (value) => String(value),
    allowDecimals: false,
  },
  perPoint: {
    label: 'Hours per point',
    value: (report) => report.speed.hours_per_point ?? 0,
    format: formatHours,
    allowDecimals: true,
  },
  cycle: {
    label: 'Avg cycle time',
    value: (report) => report.speed.avg_cycle_time_hours ?? 0,
    format: formatHours,
    allowDecimals: true,
  },
  openPoints: {
    label: 'Open points',
    value: (report) => report.volume.open_points_total,
    format: (value) => `${value} pts`,
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

/**
 * Current open work by stage. A plain list — five numbers don't need a plot.
 * The bar is sized by points, so a stage holding one 13-pointer reads as
 * heavier than one holding two 1-pointers.
 */
export function OpenByStatus({ openByStatus, openPointsByStatus, openTotal, openPointsTotal }) {
  const entries = Object.entries(openByStatus)
  const max = Math.max(1, ...entries.map(([status]) => openPointsByStatus?.[status] ?? 0))

  return (
    <div className="rounded-xl border border-hairline bg-surface p-4">
      <h3 className="text-sm font-semibold">Open work right now</h3>
      <p className="mt-0.5 text-xs text-ink-muted">
        {openPointsTotal} point{openPointsTotal === 1 ? '' : 's'} across {openTotal} task
        {openTotal === 1 ? '' : 's'}, not yet closed
      </p>
      <ul className="mt-3 space-y-2">
        {entries.map(([status, count]) => {
          const points = openPointsByStatus?.[status] ?? 0
          return (
            <li key={status} className="flex items-center gap-3">
              <span className="w-14 shrink-0 text-xs text-ink-secondary">
                {STATUS_SHORT_LABELS[status] ?? status}
              </span>
              <span className="h-2 flex-1 overflow-hidden rounded-full bg-surface-raised">
                <span
                  className="block h-full rounded-full bg-series1"
                  style={{ width: `${(points / max) * 100}%` }}
                />
              </span>
              <span className="tabular w-16 shrink-0 whitespace-nowrap text-right text-xs text-ink">
                {points} pt{points === 1 ? '' : 's'}
              </span>
              <span className="tabular w-16 shrink-0 whitespace-nowrap text-right text-xs text-ink-muted">
                {count} task{count === 1 ? '' : 's'}
              </span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
