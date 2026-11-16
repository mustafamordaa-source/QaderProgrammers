import { useEffect, useId, useMemo, useRef, useState } from 'react'
import {
  AUDIENCE_FILTER_VALUES,
  AUDIENCE_LABELS,
  KIND_LABELS,
  PRIORITIES,
  PRIORITY_LABELS,
  SIDES,
  SIDE_LABELS,
  STATUSES,
  STATUS_LABELS,
  TASK_KINDS,
} from '../../lib/constants'
import { loadAreas } from './AreaPicker'
import AreaTreeMenu, { areaPath, buildAreaTree } from './AreaTreeMenu'
import {
  AgentIcon,
  AudienceIcon,
  BlockedIcon,
  CloseIcon,
  HandIcon,
  HashIcon,
  KindIcon,
  PersonIcon,
  PriorityIcon,
  QuestionIcon,
  SearchIcon,
  SideIcon,
  StatusIcon,
  SubtasksIcon,
} from './BoardIcons'
import {
  InlineMenus,
  MenuChip,
  Option,
  chipBase,
  chipTone,
  control,
  flipsToEnd,
  useDismiss,
  useFacets,
  without,
} from './filterParts'
import { filtersMatch } from './useBoardPrefs'

// Ready-made views. Each one replaces every filter, so it always shows the same board.
export const VIEWS = [
  {
    key: 'free',
    label: 'Free to take',
    icon: HandIcon,
    title: 'Tasks you can claim right now: To do first, then Backlog',
    filters: { ready: true },
    hideReadOnly: true,
  },
  { key: 'mine', label: 'My work', icon: PersonIcon, title: 'Assigned to you or claimed by you', filters: { mine: true } },
  {
    key: 'decision',
    label: 'Needs decision',
    icon: QuestionIcon,
    title: 'Tasks with an open question to you (a lead sees questions to any lead)',
    filters: { decision: true },
    hideReadOnly: true,
  },
  {
    key: 'blocked',
    label: 'Blocked',
    icon: BlockedIcon,
    title: 'Blocked or waiting for confirmation',
    filters: { status: ['blocked', 'needs_confirm'] },
  },
]

const LANE_LABELS = { planned: 'Planned (To do)', backlog: 'Backlog' }
const SUBTASK_LABELS = { all: 'All tasks', top: 'Hide subtasks', only: 'Only subtasks' }

// Two toolbar glyphs the shared icon set does not have.
const FilterIcon = ({ className = 'h-3.5 w-3.5' }) => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" aria-hidden="true" focusable="false" className={`shrink-0 ${className}`}>
    <path d="M2.5 4h11M4.5 8h7M6.5 12h3" />
  </svg>
)
const SlidersIcon = ({ className = 'h-3.5 w-3.5' }) => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" aria-hidden="true" focusable="false" className={`shrink-0 ${className}`}>
    <path d="M2.5 5h6M11.5 5h2M2.5 11h2M7.5 11h6" />
    <circle cx="10" cy="5" r="1.5" />
    <circle cx="6" cy="11" r="1.5" />
  </svg>
)

function toggleIn(list, value) {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value]
}

function summaryOf(values, labels) {
  if (values.length === 0) return null
  if (values.length === 1) return labels[values[0]] ?? values[0]
  return `${values.length}`
}

function MultiMenu({ icon, label, values, options, labels, facetKey, onChange, facetParams, omit }) {
  return (
    <MenuChip
      icon={icon}
      label={label}
      summary={summaryOf(values, labels)}
      active={values.length > 0}
      facetParams={facetParams}
      omit={omit}
    >
      {(facets) => (
        <>
          {options.map((value) => (
            <Option
              key={value}
              multi
              checked={values.includes(value)}
              onClick={() => onChange(toggleIn(values, value))}
              count={facets ? facets[facetKey]?.[value] ?? 0 : undefined}
            >
              {labels[value] ?? value}
            </Option>
          ))}
          {values.length > 0 && (
            <button
              type="button"
              onClick={() => onChange([])}
              className="mt-1 w-full rounded-md px-2 py-1 text-start text-xs text-ink-secondary hover:bg-surface-raised hover:text-ink"
            >
              Show all
            </button>
          )}
        </>
      )}
    </MenuChip>
  )
}

function TagMenu({ value, onChange, facetParams }) {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  return (
    <MenuChip
      icon={HashIcon}
      label="Tag"
      summary={value || null}
      active={Boolean(value)}
      facetParams={facetParams}
      omit={['tag']}
    >
      {(_facets, close) => (
        <form
          className="space-y-2 p-1"
          onSubmit={(event) => {
            event.preventDefault()
            onChange(draft.trim())
            close()
          }}
        >
          <label className="block text-xs text-ink-secondary">
            One tag, matched whole: phase-0, type-fix, needs-approval
            <input
              placeholder="phase-0"
              autoCapitalize="none"
              spellCheck={false}
              autoFocus
              dir="auto"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              className={`${control} mt-1 w-full border-hairline`}
            />
          </label>
          <div className="flex justify-end gap-2">
            {value && (
              <button
                type="button"
                onClick={() => {
                  onChange('')
                  close()
                }}
                className="h-7 rounded-md px-2 text-xs text-ink-secondary hover:text-ink"
              >
                Remove
              </button>
            )}
            <button
              type="submit"
              className="h-7 rounded-md bg-series1 px-3 text-xs font-medium text-white hover:opacity-90"
            >
              Apply
            </button>
          </div>
        </form>
      )}
    </MenuChip>
  )
}

function Group({ label, stacked, children }) {
  return (
    <div
      role="group"
      aria-label={label}
      className={stacked ? 'flex flex-col items-stretch gap-1.5' : 'flex flex-wrap items-center gap-1.5'}
    >
      <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-muted">{label}</span>
      {children}
    </div>
  )
}

function ActiveChip({ label, onRemove }) {
  return (
    <span className="inline-flex max-w-[22rem] shrink-0 items-center gap-1 rounded-full border border-series1/40 bg-series1/5 py-0.5 pe-1 ps-2.5 text-xs text-series1">
      <span dir="auto" className="truncate" title={label}>
        {label}
      </span>
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove filter ${label}`}
        className="grid h-5 w-5 shrink-0 place-items-center rounded-full hover:bg-series1/15"
      >
        <CloseIcon className="h-3 w-3" />
      </button>
    </span>
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

// Sorts and the direction each starts in. Impact is the board default: work
// that reaches students first, oldest first inside each group.
const SORTS = [
  { value: 'impact', label: 'Impact (students first)', asc: 'Students first', desc: 'Team first', natural: 'asc' },
  { value: 'created', label: 'Created', asc: 'Oldest first', desc: 'Newest first', natural: 'asc' },
  { value: 'updated', label: 'Last change', asc: 'Least recent first', desc: 'Most recent first', natural: 'desc' },
  { value: 'priority', label: 'Priority', asc: 'Urgent first', desc: 'Low first', natural: 'asc' },
  { value: 'points', label: 'Effort', asc: 'Easiest first', desc: 'Biggest first', natural: 'asc' },
  { value: 'due', label: 'Due date', asc: 'Soonest first', desc: 'Latest first', natural: 'asc' },
  { value: 'title', label: 'Title', asc: 'A to Z', desc: 'Z to A', natural: 'asc' },
]
const sortOf = (filters) => SORTS.find((s) => s.value === filters.sort) ?? SORTS[0]
const currentOrder = (filters) => filters.order || sortOf(filters).natural
const orderLabel = (filters) => sortOf(filters)[currentOrder(filters)]

/** Sort (with reverse), group-by and card density, behind one small button. */
function ViewMenu({ filters, update, groupBy, onGroupBy, density, onDensity }) {
  const [open, setOpen] = useState(false)
  const [alignEnd, setAlignEnd] = useState(true)
  const wrapRef = useRef(null)
  const buttonRef = useRef(null)
  const menuId = useId()
  const sortId = useId()
  useDismiss(open, setOpen, wrapRef, buttonRef)
  const changed = filters.sort !== 'impact' || Boolean(filters.order) || groupBy !== 'none'
  const sortName = sortOf(filters).label.replace(/ \(.*\)$/, '')

  return (
    <div ref={wrapRef} className="relative">
      <button
        ref={buttonRef}
        type="button"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={`View: sorted by ${sortName}, ${orderLabel(filters)}${groupBy !== 'none' ? `, grouped by ${groupBy}` : ''}, ${density} cards`}
        title="Sort, group and card density"
        onClick={() => {
          if (!open) setAlignEnd(flipsToEnd(buttonRef.current, 288))
          setOpen((value) => !value)
        }}
        className={`${chipBase} ${chipTone(changed)} px-2.5 sm:px-3`}
      >
        <SlidersIcon />
        <span className="hidden sm:inline">View</span>
        {changed && <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-series1" />}
      </button>
      {open && (
        <div
          id={menuId}
          role="group"
          aria-label="View options"
          className={`absolute top-full z-30 mt-1 w-72 max-w-[calc(100vw-2rem)] space-y-3 rounded-lg border border-hairline bg-surface p-3 shadow-lg ${
            alignEnd ? 'end-0' : 'start-0'
          }`}
        >
          <div className="space-y-1.5">
            <label htmlFor={sortId} className="block text-[11px] font-semibold uppercase tracking-wide text-ink-muted">
              Sort
            </label>
            <div className="flex items-center gap-1.5">
              <select
                id={sortId}
                value={filters.sort}
                onChange={(event) => update({ sort: event.target.value, order: '' })}
                className={`${control} min-w-0 flex-1 ${filters.sort !== 'impact' ? 'border-series1 text-series1' : 'border-hairline'}`}
              >
                {SORTS.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => update({ order: currentOrder(filters) === 'asc' ? 'desc' : 'asc' })}
                title="Reverse the order"
                aria-label={`Reverse the order (now ${orderLabel(filters)})`}
                className={`${control} shrink-0 ${filters.order ? 'border-series1 text-series1' : 'border-hairline'}`}
              >
                {orderLabel(filters)} ⇅
              </button>
            </div>
          </div>
          <div className="space-y-1.5">
            <span className="block text-[11px] font-semibold uppercase tracking-wide text-ink-muted">Group by</span>
            <Segmented
              label="Group by"
              value={groupBy}
              onChange={onGroupBy}
              options={[
                { value: 'none', label: 'None', title: 'Plain columns' },
                { value: 'side', label: 'Side', title: 'A swimlane per side' },
                { value: 'assignee', label: 'Assignee', title: 'A swimlane per person' },
              ]}
            />
          </div>
          <div className="space-y-1.5">
            <span className="block text-[11px] font-semibold uppercase tracking-wide text-ink-muted">Cards</span>
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
      )}
    </div>
  )
}

/** Keep Tab inside `node` (the phone filter sheet). */
function trapTab(event, node) {
  if (event.key !== 'Tab' || !node) return
  const items = [...node.querySelectorAll('button, input, select, [href], [tabindex]:not([tabindex="-1"])')].filter(
    (el) => !el.disabled && el.offsetParent !== null,
  )
  if (items.length === 0) return
  const first = items[0]
  const last = items[items.length - 1]
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first.focus()
  }
}

/**
 * The board's filter bar, built to leave the height to the tasks:
 * - one toolbar row: the page title, search, ready-made views, a Filters button
 *   with a count of active filters, the result count, a View menu (sort,
 *   group-by, density) and the page action (`action`);
 * - the filter chips (Who, What, Subtasks) in a panel the Filters button opens
 *   and closes, or a side sheet on phones; the panel starts open until the
 *   person has used it once (`filtersSeen`), then starts closed;
 * - one thin row of removable chips for the active filters, only when any are on.
 * Filters live in the URL (see useBoardFilters).
 */
export default function BoardFilters({
  filters,
  update,
  replace,
  search,
  onSearch,
  facetParams,
  resultCount,
  refreshing,
  isLead,
  isReadOnly,
  groupBy,
  onGroupBy,
  density,
  onDensity,
  isMobile = false,
  filtersSeen = true,
  onFiltersSeen = () => {},
  title = null,
  action = null,
}) {
  const [areas, setAreas] = useState([])
  useEffect(() => {
    loadAreas().then(setAreas).catch(() => setAreas([]))
  }, [])
  const tree = useMemo(() => buildAreaTree(areas), [areas])

  const [panelOpen, setPanelOpen] = useState(!filtersSeen)
  const [sheetOpen, setSheetOpen] = useState(false)
  const filtersButton = useRef(null)
  const sheetRef = useRef(null)
  const panelId = useId()

  // How many tasks are free to take with the other filters, for the Who chip.
  const { data: base } = useFacets(without(facetParams, ['ready', 'lane']), !isReadOnly)
  const freeCount = base?.claimable

  const statusOptions = STATUSES.filter((s) => s !== 'dropped' && (s !== 'proposed' || isLead))
  const views = VIEWS.filter((view) => !(view.hideReadOnly && isReadOnly))

  const active = []
  const add = (key, label, patch) => active.push({ key, label, remove: () => update(patch) })
  if (filters.q) {
    active.push({
      key: 'q',
      label: `Search: ${filters.q}`,
      remove: () => {
        onSearch('')
        update({ q: '' })
      },
    })
  }
  if (filters.mine) add('mine', 'Mine', { mine: false })
  if (filters.ready) add('ready', 'Free to take', { ready: false, lane: '' })
  if (filters.lane) add('lane', LANE_LABELS[filters.lane], { lane: '' })
  if (filters.decision) add('decision', 'Needs decision', { decision: false })
  if (filters.agents) add('agents', 'From agents', { agents: false })
  for (const s of filters.status) {
    add(`status-${s}`, STATUS_LABELS[s] ?? s, { status: filters.status.filter((v) => v !== s) })
  }
  for (const p of filters.priority) {
    add(`priority-${p}`, `${PRIORITY_LABELS[p] ?? p} priority`, { priority: filters.priority.filter((v) => v !== p) })
  }
  for (const k of filters.kind) {
    add(`kind-${k}`, KIND_LABELS[k] ?? k, { kind: filters.kind.filter((v) => v !== k) })
  }
  for (const a of filters.audience) {
    add(`audience-${a}`, `Reaches: ${AUDIENCE_LABELS[a] ?? a}`, {
      audience: filters.audience.filter((v) => v !== a),
    })
  }
  if (filters.side) add('side', SIDE_LABELS[filters.side] ?? filters.side, { side: '' })
  if (filters.area) {
    const path = areaPath(tree, filters.area)
    const below = tree.kids.has(filters.area) ? ' (with sub-areas)' : ''
    add('area', `Area: ${path.join(' › ')}${below}`, { area: '' })
  }
  if (filters.tag) add('tag', `Tag: ${filters.tag}`, { tag: '' })
  if (filters.subtasks !== 'all') add('subtasks', SUBTASK_LABELS[filters.subtasks], { subtasks: 'all' })
  // The search box shows its own state; the badge counts the rest.
  const filterCount = active.filter((chip) => chip.key !== 'q').length

  const open = isMobile ? sheetOpen : panelOpen
  function setOpen(next, { restoreFocus = false } = {}) {
    if (isMobile) setSheetOpen(next)
    else setPanelOpen(next)
    onFiltersSeen()
    if (!next && restoreFocus) filtersButton.current?.focus()
  }

  // The sheet takes focus when it opens.
  useEffect(() => {
    if (isMobile && sheetOpen) sheetRef.current?.querySelector('button, input')?.focus()
  }, [isMobile, sheetOpen])

  function onPanelKey(event) {
    // A menu inside handles its own Escape first (see useDismiss).
    if (event.key === 'Escape' && !event.defaultPrevented) {
      event.preventDefault()
      setOpen(false, { restoreFocus: true })
    }
  }

  const stacked = isMobile
  const groups = (
    <>
      <Group label="Who" stacked={stacked}>
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            aria-pressed={filters.mine}
            onClick={() => update({ mine: !filters.mine })}
            title="Tasks assigned to you or claimed by you"
            className={`${chipBase} ${chipTone(filters.mine)}`}
          >
            <PersonIcon />
            Mine
          </button>
          {!isReadOnly && (
            <button
              type="button"
              aria-pressed={filters.ready}
              onClick={() => update({ ready: !filters.ready, lane: '' })}
              title="Tasks you can claim right now, in To do and Backlog"
              className={`${chipBase} ${chipTone(filters.ready)}`}
            >
              <HandIcon />
              Free to take
              {freeCount !== undefined && freeCount !== null && (
                <span className="tabular text-xs opacity-75">{freeCount}</span>
              )}
            </button>
          )}
          {isLead && (
            <button
              type="button"
              aria-pressed={filters.agents}
              onClick={() => update({ agents: !filters.agents })}
              title="Only tasks an agent filed, for triage"
              className={`${chipBase} ${chipTone(filters.agents, 'series2')}`}
            >
              <AgentIcon />
              From agents
            </button>
          )}
        </div>
        {filters.ready && (
          <MenuChip
            icon={StatusIcon}
            label="Lane"
            summary={filters.lane ? LANE_LABELS[filters.lane] : null}
            active={Boolean(filters.lane)}
            facetParams={facetParams}
            omit={['lane']}
          >
            {(facets, close) =>
              ['', 'planned', 'backlog'].map((lane) => (
                <Option
                  key={lane || 'both'}
                  checked={filters.lane === lane}
                  onClick={() => {
                    update({ lane })
                    close()
                  }}
                  count={facets ? (lane ? facets.lane?.[lane] ?? 0 : facets.total) : undefined}
                >
                  {lane ? LANE_LABELS[lane] : 'Both'}
                </Option>
              ))
            }
          </MenuChip>
        )}
      </Group>

      <Group label="What" stacked={stacked}>
        <MultiMenu
          icon={StatusIcon}
          label="Status"
          values={filters.status}
          options={statusOptions}
          labels={STATUS_LABELS}
          facetKey="status"
          onChange={(status) => update({ status })}
          facetParams={facetParams}
          omit={['statuses']}
        />
        <MultiMenu
          icon={PriorityIcon}
          label="Priority"
          values={filters.priority}
          options={[...PRIORITIES].reverse()}
          labels={PRIORITY_LABELS}
          facetKey="priority"
          onChange={(priority) => update({ priority })}
          facetParams={facetParams}
          omit={['priority']}
        />
        <MultiMenu
          icon={KindIcon}
          label="Kind"
          values={filters.kind}
          options={TASK_KINDS}
          labels={KIND_LABELS}
          facetKey="kind"
          onChange={(kind) => update({ kind })}
          facetParams={facetParams}
          omit={['kinds']}
        />
        <MultiMenu
          icon={AudienceIcon}
          label="Audience"
          values={filters.audience}
          options={AUDIENCE_FILTER_VALUES}
          labels={AUDIENCE_LABELS}
          facetKey="audience"
          onChange={(audience) => update({ audience })}
          facetParams={facetParams}
          omit={['audience']}
        />
        <MenuChip
          icon={SideIcon}
          label="Side"
          summary={filters.side ? SIDE_LABELS[filters.side] ?? filters.side : null}
          active={Boolean(filters.side)}
          facetParams={facetParams}
          omit={['side']}
        >
          {(facets, close) => {
            const pick = (side) => {
              update({ side })
              close()
            }
            return (
              <>
                <Option checked={!filters.side} onClick={() => pick('')} count={facets?.total}>
                  All sides
                </Option>
                {SIDES.map((value) => (
                  <Option
                    key={value}
                    checked={filters.side === value}
                    onClick={() => pick(value)}
                    count={facets ? facets.side?.[value] ?? 0 : undefined}
                  >
                    {SIDE_LABELS[value]}
                  </Option>
                ))}
              </>
            )
          }}
        </MenuChip>
        {areas.length > 0 && (
          <AreaTreeMenu
            key={filters.area}
            value={filters.area}
            tree={tree}
            onChange={(area) => update({ area })}
            facetParams={facetParams}
          />
        )}
        <TagMenu value={filters.tag} onChange={(tag) => update({ tag })} facetParams={facetParams} />
      </Group>

      <Group label="Subtasks" stacked={stacked}>
        <MenuChip
          icon={SubtasksIcon}
          label={SUBTASK_LABELS[filters.subtasks]}
          active={filters.subtasks !== 'all'}
          facetParams={facetParams}
          omit={['subtasks']}
        >
          {(facets, close) =>
            ['all', 'top', 'only'].map((value) => {
              let count
              if (facets) {
                const total = facets.total ?? 0
                const subtasks = facets.subtasks ?? 0
                count = value === 'all' ? total : value === 'only' ? subtasks : Math.max(0, total - subtasks)
              }
              return (
                <Option
                  key={value}
                  checked={filters.subtasks === value}
                  onClick={() => {
                    update({ subtasks: value })
                    close()
                  }}
                  count={count}
                >
                  {SUBTASK_LABELS[value]}
                </Option>
              )
            })
          }
        </MenuChip>
      </Group>
    </>
  )

  const countText = refreshing ? 'Updating…' : `${resultCount} task${resultCount === 1 ? '' : 's'}`
  const clearAll = () => {
    onSearch('')
    replace({})
  }

  return (
    <div className="flex min-w-0 flex-col gap-2" role="search" aria-label="Filter the board">
      <div className="flex flex-wrap items-center gap-2">
        {title}

        <label className="relative min-w-0 flex-1 sm:w-56 sm:flex-none">
          <span className="sr-only">Search title, description and summary</span>
          <SearchIcon className="pointer-events-none absolute start-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-muted" />
          <input
            type="search"
            placeholder="Search, or HUB-12…"
            dir="auto"
            value={search}
            onChange={(event) => onSearch(event.target.value)}
            className={`${control} w-full ps-8 ${search ? 'border-series1' : 'border-hairline'}`}
          />
        </label>

        {/* Phones and narrow laptops: the views get their own line that scrolls sideways. */}
        <div
          role="group"
          aria-label="Ready-made views"
          className="board-scroll order-last -mx-1 flex w-full items-center gap-1.5 overflow-x-auto px-1 xl:order-none xl:mx-0 xl:w-auto xl:overflow-visible xl:px-0"
        >
          {views.map((view) => {
            const pressed = filtersMatch(filters, view.filters)
            const Glyph = view.icon
            return (
              <button
                key={view.key}
                type="button"
                aria-pressed={pressed}
                title={view.title}
                onClick={() => {
                  onSearch('')
                  replace(pressed ? {} : view.filters)
                }}
                className={`${chipBase} shrink-0 ${chipTone(pressed, view.key === 'decision' ? 'series2' : 'series1')}`}
              >
                <Glyph />
                {view.label}
              </button>
            )
          })}
        </div>

        <button
          ref={filtersButton}
          type="button"
          aria-expanded={open}
          aria-controls={open ? panelId : undefined}
          aria-label={`Filters${filterCount ? `, ${filterCount} on` : ''}`}
          onClick={() => setOpen(!open)}
          onKeyDown={(event) => open && onPanelKey(event)}
          className={`${chipBase} ${chipTone(open || filterCount > 0)} px-2.5 sm:px-3`}
        >
          <FilterIcon />
          <span className="hidden sm:inline">Filters</span>
          {filterCount > 0 && (
            <span className="tabular grid h-4 min-w-[1rem] place-items-center rounded-full bg-series1 px-1 text-[10px] font-semibold text-white">
              {filterCount}
            </span>
          )}
        </button>

        <span
          className="tabular sr-only whitespace-nowrap text-xs text-ink-muted sm:not-sr-only"
          role="status"
          aria-live="polite"
        >
          {countText}
        </span>

        <div className="ms-auto flex items-center gap-2">
          <ViewMenu
            filters={filters}
            update={update}
            groupBy={groupBy}
            onGroupBy={onGroupBy}
            density={density}
            onDensity={onDensity}
          />
          {action}
        </div>
      </div>

      {!isMobile && panelOpen && (
        <div
          id={panelId}
          role="region"
          aria-label="Filters"
          onKeyDown={onPanelKey}
          className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-hairline bg-surface-raised/40 px-3 py-2"
        >
          {groups}
        </div>
      )}

      {isMobile && sheetOpen && (
        <div className="fixed inset-0 z-50" onKeyDown={onPanelKey}>
          <div aria-hidden="true" className="absolute inset-0 bg-black/40" onMouseDown={() => setOpen(false, { restoreFocus: true })} />
          <div
            ref={sheetRef}
            id={panelId}
            role="dialog"
            aria-modal="true"
            aria-label="Filters"
            onKeyDown={(event) => trapTab(event, sheetRef.current)}
            className="absolute inset-y-0 end-0 flex w-[min(22rem,90vw)] flex-col border-s border-hairline bg-surface shadow-xl"
          >
            <div className="flex items-center gap-2 border-b border-hairline px-4 py-3">
              <h2 className="text-sm font-semibold">Filters</h2>
              {filterCount > 0 && (
                <button
                  type="button"
                  onClick={clearAll}
                  className="text-xs text-ink-secondary underline-offset-2 hover:text-ink hover:underline"
                >
                  Clear all
                </button>
              )}
              <button
                type="button"
                onClick={() => setOpen(false, { restoreFocus: true })}
                aria-label="Close filters"
                className="ms-auto grid h-8 w-8 place-items-center rounded-lg text-ink-secondary hover:bg-surface-raised hover:text-ink"
              >
                <CloseIcon />
              </button>
            </div>
            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-3">
              <InlineMenus.Provider value>{groups}</InlineMenus.Provider>
            </div>
            <div className="border-t border-hairline px-4 py-3">
              <button
                type="button"
                onClick={() => setOpen(false, { restoreFocus: true })}
                className="h-9 w-full rounded-lg bg-series1 text-sm font-medium text-white hover:opacity-90"
              >
                Show {countText.toLowerCase()}
              </button>
            </div>
          </div>
        </div>
      )}

      {active.length > 0 && (
        <div className="flex min-w-0 items-center gap-1.5" aria-label="Active filters" role="group">
          <div className="board-scroll flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto">
            {active.map((chip) => (
              <ActiveChip key={chip.key} label={chip.label} onRemove={chip.remove} />
            ))}
          </div>
          <button
            type="button"
            onClick={clearAll}
            className="h-6 shrink-0 rounded-md px-2 text-xs text-ink-secondary underline-offset-2 hover:text-ink hover:underline"
          >
            Clear all
          </button>
        </div>
      )}
    </div>
  )
}
