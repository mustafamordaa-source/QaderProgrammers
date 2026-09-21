import { useCallback, useEffect, useState } from 'react'
import { api } from '../api/client'
import { useAuth } from '../auth/AuthContext'
import DateRangeFilter, { rangeForDays } from '../components/kpi/DateRangeFilter'
import StatTile, { rateTone } from '../components/kpi/StatTile'
import {
  CompletionsChart,
  CycleTimeTrend,
  OpenByStatus,
  ProgrammerComparison,
  TimeInStatusChart,
} from '../components/kpi/Charts'
import { formatDate, formatHours, formatHoursTogether, formatPercent } from '../lib/format'

function Headline({ report }) {
  const { speed, quality, volume, on_time: onTime } = report
  const [cycleAvg, cycleMedian] = formatHoursTogether(
    speed.avg_cycle_time_hours,
    speed.median_cycle_time_hours,
  )

  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {/* Volume leads on points: task counts alone rate every task the same. */}
      <StatTile
        label="Points completed"
        value={volume.points_completed}
        caption={
          volume.completed_total > 0
            ? `${volume.completed_total} task${volume.completed_total === 1 ? '' : 's'}, averaging ${volume.avg_points_per_task} points each`
            : 'Nothing closed in this range'
        }
      />
      <StatTile
        label="Avg cycle time"
        value={cycleAvg}
        caption={`Median ${cycleMedian} · raw elapsed time, whatever the difficulty`}
      />
      <StatTile
        label="Hours per point"
        value={formatHours(speed.hours_per_point)}
        caption="Total time over total points — comparable across easy and hard work"
      />
      <StatTile
        label="On-time rate"
        value={formatPercent(onTime.on_time_rate)}
        tone={rateTone(onTime.on_time_rate)}
        caption={`${onTime.on_time} of ${onTime.completed_with_due_date} closed by their due date`}
      />
      <StatTile
        label="First-pass rate"
        value={formatPercent(quality.first_pass_rate)}
        tone={rateTone(quality.first_pass_rate, { good: 0.75, poor: 0.5 })}
        caption="Approved on the first submission, no rework"
      />
      <StatTile
        label="Rejection rate"
        value={formatPercent(quality.rejection_rate)}
        tone={rateTone(quality.rejection_rate, { higherIsBetter: false, good: 0.85, poor: 0.7 })}
        caption={`${quality.rejections} sent back across ${quality.review_submissions} review submission${quality.review_submissions === 1 ? '' : 's'}`}
      />
    </div>
  )
}

export default function KpiPage() {
  const { isLeader, user } = useAuth()

  const [range, setRange] = useState(() => rangeForDays(90))
  const [preset, setPreset] = useState(90)
  const [report, setReport] = useState(null)
  const [focusedProgrammer, setFocusedProgrammer] = useState(null)
  const [focusedReport, setFocusedReport] = useState(null)
  const [measure, setMeasure] = useState('points')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setReport(isLeader ? await api.teamKpi(range) : await api.myKpi(range))
      setError(null)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [isLeader, range])

  useEffect(() => {
    load()
  }, [load])

  useEffect(() => {
    if (!focusedProgrammer) {
      setFocusedReport(null)
      return
    }
    let cancelled = false
    api
      .programmerKpi(focusedProgrammer, range)
      .then((result) => !cancelled && setFocusedReport(result))
      .catch((err) => !cancelled && setError(err.message))
    return () => {
      cancelled = true
    }
  }, [focusedProgrammer, range])

  function choosePreset(days) {
    setPreset(days)
    setRange(rangeForDays(days))
  }

  function chooseCustom(customRange) {
    setPreset(null)
    setRange(customRange)
  }

  if (loading && !report) {
    return <p className="text-sm text-ink-muted">Loading metrics…</p>
  }

  if (error && !report) {
    return (
      <p role="alert" className="rounded-lg border border-critical/40 px-3 py-2 text-sm text-critical">
        {error}
      </p>
    )
  }

  const detail = focusedReport ?? report

  return (
    <>
      <div className="mb-5">
        <h1 className="text-xl font-semibold tracking-tight">
          {isLeader ? 'Team metrics' : 'My metrics'}
        </h1>
        <p className="mt-0.5 text-sm text-ink-secondary">
          {isLeader
            ? 'Everything here is derived from the task event log.'
            : `Your delivery metrics, ${user.name}. Derived from your task history.`}
        </p>
      </div>

      <div className="mb-5">
        <DateRangeFilter activePreset={preset} onPreset={choosePreset} onCustom={chooseCustom} />
        <p className="mt-2 text-xs text-ink-muted">
          {formatDate(report.range_start)} – {formatDate(report.range_end)}
          {' · '}Volume is difficulty-weighted: the leader rates each task 1–13 when
          creating it.
          {isLeader && (
            <>
              {' '}A task shared by two programmers counts once for the team and in full
              for each of them.
            </>
          )}
        </p>
      </div>

      {error && (
        <p role="alert" className="mb-4 rounded-lg border border-critical/40 px-3 py-2 text-sm text-critical">
          {error}
        </p>
      )}

      {isLeader && report.programmers?.length > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <span className="text-xs text-ink-secondary">Viewing:</span>
          <button
            type="button"
            onClick={() => setFocusedProgrammer(null)}
            aria-pressed={!focusedProgrammer}
            className={`rounded-lg border px-3 py-1.5 text-xs transition ${
              !focusedProgrammer
                ? 'border-series1 text-series1'
                : 'border-hairline text-ink-secondary hover:text-ink'
            }`}
          >
            Whole team
          </button>
          {report.programmers.map((person) => (
            <button
              key={person.user_id}
              type="button"
              onClick={() => setFocusedProgrammer(person.user_id)}
              aria-pressed={focusedProgrammer === person.user_id}
              className={`rounded-lg border px-3 py-1.5 text-xs transition ${
                focusedProgrammer === person.user_id
                  ? 'border-series1 text-series1'
                  : 'border-hairline text-ink-secondary hover:text-ink'
              }`}
            >
              {person.user_name}
            </button>
          ))}
        </div>
      )}

      <Headline report={detail} />

      <div className="mt-3 grid gap-3 lg:grid-cols-2">
        <CompletionsChart
          perWeek={detail.volume.completed_per_week}
          pointsPerWeek={detail.volume.points_per_week}
        />
        <CycleTimeTrend perWeek={detail.speed.avg_cycle_time_per_week} />
        <TimeInStatusChart perStatus={detail.speed.avg_time_in_status_hours} />
        <OpenByStatus
          openByStatus={detail.volume.open_by_status}
          openPointsByStatus={detail.volume.open_points_by_status}
          openTotal={detail.volume.open_total}
          openPointsTotal={detail.volume.open_points_total}
        />
      </div>

      {isLeader && report.programmers?.length > 0 && (
        <div className="mt-3">
          <ProgrammerComparison
            reports={report.programmers}
            measure={measure}
            onMeasureChange={setMeasure}
            onSelect={setFocusedProgrammer}
          />
        </div>
      )}
    </>
  )
}
