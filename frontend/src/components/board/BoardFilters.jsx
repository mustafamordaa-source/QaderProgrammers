import { KIND_LABELS, SIDES, SIDE_LABELS, TASK_KINDS } from '../../lib/constants'

const control =
  'h-8 rounded-lg border bg-surface-raised px-2.5 text-sm outline-none transition focus:border-series1'

function on(active) {
  return active ? 'border-series1 text-series1' : 'border-hairline'
}

function Toggle({ pressed, onClick, title, tone = 'series1', children }) {
  const pressedClass =
    tone === 'series2' ? 'border-series2 bg-series2/10 text-series2' : 'border-series1 bg-series1/10 text-series1'
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      title={title}
      className={`h-8 whitespace-nowrap rounded-full border px-3 text-sm transition ${
        pressed ? pressedClass : 'border-hairline text-ink-secondary hover:text-ink'
      }`}
    >
      {children}
    </button>
  )
}

/** Two or three exclusive choices as one control. */
function Segmented({ label, value, options, onChange }) {
  return (
    <div role="group" aria-label={label} className="inline-flex h-8 items-center rounded-lg border border-hairline p-0.5">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
          title={option.title}
          className={`h-full rounded-md px-2.5 text-xs font-medium transition ${
            value === option.value ? 'bg-surface-raised text-ink shadow-sm' : 'text-ink-muted hover:text-ink'
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

/**
 * One wrapping row: what to show (search and filters, sent to the API), then
 * how to show it (grouping and card density, kept in this browser).
 */
export default function BoardFilters({
  values,
  set,
  onClear,
  activeCount,
  resultCount,
  refreshing,
  isLead,
  isReadOnly,
  mySides,
  groupBy,
  onGroupBy,
  density,
  onDensity,
}) {
  const { search, mine, side, tagInput, kind, fromAgents, openParts } = values

  return (
    <div className="flex flex-wrap items-center gap-2" role="search" aria-label="Filter the board">
      <input
        type="search"
        aria-label="Search title, description and summary"
        placeholder="Search, or HUB-12…"
        dir="auto"
        value={search}
        onChange={(event) => set.search(event.target.value)}
        className={`${control} ${on(Boolean(search))} w-full sm:w-56`}
      />
      <Toggle pressed={mine} onClick={() => set.mine(!mine)} title="Tasks assigned to you or claimed by you">
        Mine
      </Toggle>
      <select
        aria-label="Side"
        value={side}
        onChange={(event) => set.side(event.target.value)}
        className={`${control} ${on(Boolean(side))}`}
      >
        <option value="">All sides</option>
        {SIDES.map((value) => (
          <option key={value} value={value}>
            {SIDE_LABELS[value]}
          </option>
        ))}
      </select>
      <input
        aria-label="Tag"
        placeholder="Tag"
        dir="auto"
        value={tagInput}
        onChange={(event) => set.tagInput(event.target.value)}
        className={`${control} ${on(Boolean(tagInput.trim()))} w-28`}
      />
      <select
        aria-label="Kind"
        value={kind}
        onChange={(event) => set.kind(event.target.value)}
        className={`${control} ${on(Boolean(kind))}`}
      >
        <option value="">All kinds</option>
        {TASK_KINDS.map((value) => (
          <option key={value} value={value}>
            {KIND_LABELS[value]}
          </option>
        ))}
      </select>
      {isLead && (
        <Toggle
          pressed={fromAgents}
          onClick={() => set.fromAgents(!fromAgents)}
          title="Only tasks an agent filed, for triage"
          tone="series2"
        >
          From agents
        </Toggle>
      )}
      {mySides.length > 0 && !isReadOnly && (
        <Toggle
          pressed={openParts}
          onClick={() => set.openParts(!openParts)}
          title={`Pool tasks in To do on your sides: ${mySides.map((s) => SIDE_LABELS[s] ?? s).join(', ')}`}
        >
          Open parts for my sides
        </Toggle>
      )}
      {activeCount > 0 && (
        <button
          type="button"
          onClick={onClear}
          className="h-8 rounded-lg px-2 text-xs text-ink-secondary underline-offset-2 hover:text-ink hover:underline"
        >
          Clear {activeCount} filter{activeCount === 1 ? '' : 's'}
        </button>
      )}

      <span className="tabular text-xs text-ink-muted" role="status" aria-live="polite">
        {refreshing ? 'Updating…' : `${resultCount} task${resultCount === 1 ? '' : 's'}`}
      </span>

      <div className="ms-auto flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-1.5 text-xs text-ink-secondary">
          Group by
          <select
            value={groupBy}
            onChange={(event) => onGroupBy(event.target.value)}
            className={`${control} ${on(groupBy !== 'none')}`}
          >
            <option value="none">None</option>
            <option value="side">Side</option>
            <option value="assignee">Assignee</option>
          </select>
        </label>
        <Segmented
          label="Card density"
          value={density}
          onChange={onDensity}
          options={[
            { value: 'comfortable', label: 'Comfortable', title: 'Full cards with every badge' },
            { value: 'compact', label: 'Compact', title: 'Short cards: title, ID and icons' },
          ]}
        />
      </div>
    </div>
  )
}
