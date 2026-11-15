import { useEffect, useId, useRef, useState } from 'react'
import { api } from '../../api/client'
import {
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
import {
  AgentIcon,
  AreaIcon,
  BlockedIcon,
  ChevronDown,
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
import { filtersMatch } from './useBoardPrefs'

const control =
  'h-8 rounded-lg border bg-surface-raised px-2.5 text-sm outline-none transition focus:border-series1'

const chipBase =
  'inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-full border px-3 text-sm transition'

function chipTone(active, tone = 'series1') {
  if (!active) return 'border-hairline text-ink-secondary hover:border-series1/40 hover:text-ink'
  return tone === 'series2'
    ? 'border-series2 bg-series2/10 text-series2'
    : 'border-series1 bg-series1/10 text-series1'
}

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

function Count({ value }) {
  if (value === undefined || value === null) return null
  return <span className="tabular ms-auto ps-3 text-xs text-ink-muted">{value}</span>
}

/** Facet counts while `enabled`, for `params` (already minus the menu's own filter). */
function useFacets(params, enabled) {
  const [state, setState] = useState({ data: null, failed: false })
  const paramsKey = JSON.stringify(params)
  useEffect(() => {
    if (!enabled) return undefined
    let cancelled = false
    api
      .facets(JSON.parse(paramsKey))
      .then((data) => {
        if (!cancelled) setState({ data, failed: false })
      })
      .catch(() => {
        // Counts are a help, not the filter: the menu still works without them.
        if (!cancelled) setState((current) => ({ data: current.data, failed: true }))
      })
    return () => {
      cancelled = true
    }
  }, [paramsKey, enabled])
  return state
}

function without(params, keys) {
  const next = { ...params }
  for (const key of keys) delete next[key]
  return next
}

/**
 * A chip that opens a small menu. `children(facets, close)` renders the options;
 * the counts come from /tasks/facets for the current filters minus `omit`, so a
 * menu shows what each of its own options would give.
 */
function MenuChip({ icon: Glyph, label, summary, active, facetParams, omit = [], children, width = 'w-60' }) {
  const [open, setOpen] = useState(false)
  const [alignEnd, setAlignEnd] = useState(false)
  const wrapRef = useRef(null)
  const buttonRef = useRef(null)
  const menuId = useId()
  const { data: facets, failed } = useFacets(without(facetParams, omit), open)

  useEffect(() => {
    if (!open) return undefined
    function onPointer(event) {
      if (!wrapRef.current?.contains(event.target)) setOpen(false)
    }
    function onKey(event) {
      if (event.key === 'Escape') {
        setOpen(false)
        buttonRef.current?.focus()
      }
    }
    document.addEventListener('mousedown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  function toggle() {
    if (!open) {
      // Near the right edge (phones), open the menu leftwards so it stays on screen.
      const rect = buttonRef.current?.getBoundingClientRect()
      setAlignEnd(Boolean(rect && rect.left + 256 > window.innerWidth - 8))
    }
    setOpen((value) => !value)
  }

  const close = () => setOpen(false)

  return (
    <div ref={wrapRef} className="relative">
      <button
        ref={buttonRef}
        type="button"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={toggle}
        className={`${chipBase} ${chipTone(active)}`}
      >
        <Glyph />
        <span>{label}</span>
        {summary && <span className="max-w-[8rem] truncate font-medium">: {summary}</span>}
        <ChevronDown className="h-3 w-3 opacity-70" />
      </button>
      {open && (
        <div
          id={menuId}
          role="group"
          aria-label={label}
          className={`absolute top-full z-30 mt-1 ${width} max-w-[calc(100vw-2rem)] rounded-lg border border-hairline bg-surface p-1 shadow-lg ${
            alignEnd ? 'right-0' : 'left-0'
          }`}
        >
          {children(facets, close)}
          {failed && !facets && (
            <p className="px-2 py-1 text-[11px] text-ink-muted">Counts are not available right now.</p>
          )}
        </div>
      )}
    </div>
  )
}

function Option({ checked, multi = false, onClick, children, count }) {
  return (
    <button
      type="button"
      aria-pressed={checked}
      onClick={onClick}
      className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-start text-sm transition hover:bg-surface-raised ${
        checked ? 'font-medium text-series1' : 'text-ink'
      }`}
    >
      <span
        aria-hidden="true"
        className={`grid h-3.5 w-3.5 shrink-0 place-items-center border ${multi ? 'rounded' : 'rounded-full'} ${
          checked ? 'border-series1 bg-series1' : 'border-hairline'
        }`}
      >
        {checked && <span className={`block h-1.5 w-1.5 bg-white ${multi ? 'rounded-sm' : 'rounded-full'}`} />}
      </span>
      <span dir="auto" className="min-w-0 truncate">
        {children}
      </span>
      <Count value={count} />
    </button>
  )
}

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

function AreaMenu({ value, areas, onChange, facetParams }) {
  const [query, setQuery] = useState('')
  const current = areas.find((a) => a.slug === value)
  const needle = query.trim().toLowerCase()
  const shown = needle
    ? areas.filter((a) => a.name.toLowerCase().includes(needle) || a.slug.includes(needle))
    : areas
  return (
    <MenuChip
      icon={AreaIcon}
      label="Area"
      summary={value ? current?.name ?? value : null}
      active={Boolean(value)}
      facetParams={facetParams}
      omit={['area']}
      width="w-64"
    >
      {(facets, close) => {
        const pick = (slug) => {
          onChange(slug)
          close()
        }
        return (
          <>
            {areas.length > 8 && (
              <input
                type="search"
                aria-label="Find an area"
                placeholder="Find an area…"
                dir="auto"
                autoFocus
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                className={`${control} mb-1 w-full border-hairline`}
              />
            )}
            <div className="max-h-64 overflow-y-auto">
              <Option checked={!value} onClick={() => pick('')} count={facets?.total}>
                All areas
              </Option>
              {shown.map((a) => (
                <Option
                  key={a.slug}
                  checked={value === a.slug}
                  onClick={() => pick(a.slug)}
                  count={facets ? facets.area?.[a.slug] ?? 0 : undefined}
                >
                  {a.name}
                </Option>
              ))}
              {shown.length === 0 && <p className="px-2 py-1.5 text-xs text-ink-muted">No area matches.</p>}
            </div>
          </>
        )
      }}
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

function Group({ label, children }) {
  return (
    <div role="group" aria-label={label} className="flex flex-wrap items-center gap-1.5">
      <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-muted">{label}</span>
      {children}
    </div>
  )
}

function ActiveChip({ label, onRemove }) {
  return (
    <span className="inline-flex max-w-full items-center gap-1 rounded-full border border-series1/40 bg-series1/5 py-0.5 pe-1 ps-2.5 text-xs text-series1">
      <span dir="auto" className="truncate">
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

/**
 * The board's filter bar. Row one: search, ready-made views, the result count
 * and how cards show. Row two: filter chips grouped as Who, What and Subtasks,
 * each with a menu that shows counts. Row three: the active filters, each
 * removable, and Clear all. Filters live in the URL (see useBoardFilters).
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
}) {
  const [areas, setAreas] = useState([])
  useEffect(() => {
    loadAreas().then(setAreas).catch(() => setAreas([]))
  }, [])

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
  if (filters.side) add('side', SIDE_LABELS[filters.side] ?? filters.side, { side: '' })
  if (filters.area) {
    add('area', `Area: ${areas.find((a) => a.slug === filters.area)?.name ?? filters.area}`, { area: '' })
  }
  if (filters.tag) add('tag', `Tag: ${filters.tag}`, { tag: '' })
  if (filters.subtasks !== 'all') add('subtasks', SUBTASK_LABELS[filters.subtasks], { subtasks: 'all' })

  return (
    <div className="flex min-w-0 flex-col gap-2.5" role="search" aria-label="Filter the board">
      <div className="flex flex-wrap items-center gap-2">
        <label className="relative w-full sm:w-60">
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

        <div role="group" aria-label="Ready-made views" className="flex flex-wrap items-center gap-1.5">
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
                className={`${chipBase} ${chipTone(pressed, view.key === 'decision' ? 'series2' : 'series1')}`}
              >
                <Glyph />
                {view.label}
              </button>
            )
          })}
        </div>

        <span className="tabular text-xs text-ink-muted" role="status" aria-live="polite">
          {refreshing ? 'Updating…' : `${resultCount} task${resultCount === 1 ? '' : 's'}`}
        </span>

        <div className="ms-auto flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1.5 text-xs text-ink-secondary">
            Group by
            <select
              value={groupBy}
              onChange={(event) => onGroupBy(event.target.value)}
              className={`${control} ${groupBy !== 'none' ? 'border-series1 text-series1' : 'border-hairline'}`}
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

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <Group label="Who">
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
        </Group>

        <Group label="What">
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
            <AreaMenu value={filters.area} areas={areas} onChange={(area) => update({ area })} facetParams={facetParams} />
          )}
          <TagMenu value={filters.tag} onChange={(tag) => update({ tag })} facetParams={facetParams} />
        </Group>

        <Group label="Subtasks">
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
      </div>

      {active.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5" aria-label="Active filters">
          {active.map((chip) => (
            <ActiveChip key={chip.key} label={chip.label} onRemove={chip.remove} />
          ))}
          <button
            type="button"
            onClick={() => {
              onSearch('')
              replace({})
            }}
            className="h-6 rounded-md px-2 text-xs text-ink-secondary underline-offset-2 hover:text-ink hover:underline"
          >
            Clear all
          </button>
        </div>
      )}
    </div>
  )
}
