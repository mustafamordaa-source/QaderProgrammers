// All timestamps arrive as naive UTC from the API; everything here converts to
// the viewer's local time for display.

function asUtcDate(value) {
  if (!value) return null
  // A naive ISO string has no zone designator; mark it as UTC before parsing.
  const normalised = /[Zz]|[+-]\d{2}:?\d{2}$/.test(value) ? value : `${value}Z`
  const date = new Date(normalised)
  return Number.isNaN(date.getTime()) ? null : date
}

export function formatDateTime(value) {
  const date = asUtcDate(value)
  return date
    ? date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
    : '—'
}

export function formatDate(value) {
  const date = asUtcDate(value)
  return date ? date.toLocaleDateString(undefined, { dateStyle: 'medium' }) : '—'
}

/** ISO date (yyyy-mm-dd) in local terms, for <input type="date"> round-trips. */
export function toDateInputValue(value) {
  const date = asUtcDate(value)
  if (!date) return ''
  const offset = date.getTimezoneOffset() * 60_000
  return new Date(date.getTime() - offset).toISOString().slice(0, 10)
}

/** Turn a date input's value into the naive-UTC string the API expects. */
export function fromDateInputValue(value, endOfDay = false) {
  if (!value) return null
  const local = new Date(`${value}T${endOfDay ? '23:59:59' : '00:00:00'}`)
  return local.toISOString().slice(0, 19)
}

export function isOverdue(dueDate, status) {
  const date = asUtcDate(dueDate)
  return Boolean(date) && status !== 'done' && date.getTime() < Date.now()
}

/** Hours as a compact, human-readable duration. */
export function formatHours(hours) {
  if (hours === null || hours === undefined) return '—'
  if (hours < 1) return `${Math.round(hours * 60)}m`
  if (hours < 48) return `${hours.toFixed(1)}h`
  return `${(hours / 24).toFixed(1)}d`
}

export function formatPercent(rate) {
  return rate === null || rate === undefined ? '—' : `${Math.round(rate * 100)}%`
}

/** "2026-W12" -> "Mar 16", the Monday that week starts on. */
export function formatWeekKey(key) {
  const match = /^(\d{4})-W(\d{1,2})$/.exec(key)
  if (!match) return key
  const [, year, week] = match
  // ISO week 1 contains Jan 4th; step back to its Monday, then forward.
  const jan4 = new Date(Date.UTC(Number(year), 0, 4))
  const isoWeekday = jan4.getUTCDay() || 7
  const week1Monday = new Date(jan4)
  week1Monday.setUTCDate(jan4.getUTCDate() - isoWeekday + 1)
  const monday = new Date(week1Monday)
  monday.setUTCDate(week1Monday.getUTCDate() + (Number(week) - 1) * 7)
  return monday.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export function initials(name) {
  return (name || '?')
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('')
}
