import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { AUDIENCE_FILTER_VALUES, PRIORITIES, STATUSES, TASK_KINDS } from '../../lib/constants'

const PREFS_KEY = 'taskflow.board.prefs.v1'
const DENSITIES = ['comfortable', 'compact']
const GROUPS = ['none', 'side', 'assignee']

function readPrefs() {
  try {
    const raw = window.localStorage.getItem(PREFS_KEY)
    const saved = raw ? JSON.parse(raw) : {}
    return {
      collapsed: Array.isArray(saved.collapsed) ? saved.collapsed.filter((k) => typeof k === 'string') : [],
      density: DENSITIES.includes(saved.density) ? saved.density : 'comfortable',
      groupBy: GROUPS.includes(saved.groupBy) ? saved.groupBy : 'none',
      // True once the person has opened or closed the filter panel.
      filtersSeen: saved.filtersSeen === true,
    }
  } catch {
    return { collapsed: [], density: 'comfortable', groupBy: 'none', filtersSeen: false }
  }
}

/**
 * Collapsed columns, card density, grouping and whether the person has used
 * the filter panel, kept per browser. The panel starts open until they open or
 * close it once, so new people find the filters; after that it starts closed.
 */
export function useBoardPrefs() {
  const [prefs, setPrefs] = useState(readPrefs)

  useEffect(() => {
    try {
      window.localStorage.setItem(PREFS_KEY, JSON.stringify(prefs))
    } catch {
      // Private window or blocked storage: the board still works, it only forgets.
    }
  }, [prefs])

  const toggleCollapsed = useCallback((key) => {
    setPrefs((current) => ({
      ...current,
      collapsed: current.collapsed.includes(key)
        ? current.collapsed.filter((k) => k !== key)
        : [...current.collapsed, key],
    }))
  }, [])

  const setDensity = useCallback((density) => setPrefs((current) => ({ ...current, density })), [])
  const setGroupBy = useCallback((groupBy) => setPrefs((current) => ({ ...current, groupBy })), [])
  const markFiltersSeen = useCallback(
    () => setPrefs((current) => (current.filtersSeen ? current : { ...current, filtersSeen: true })),
    [],
  )

  return {
    collapsed: prefs.collapsed,
    density: prefs.density,
    groupBy: prefs.groupBy,
    filtersSeen: prefs.filtersSeen,
    toggleCollapsed,
    setDensity,
    setGroupBy,
    markFiltersSeen,
  }
}

export function useMediaQuery(query) {
  const [matches, setMatches] = useState(() =>
    typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(query).matches : false,
  )
  useEffect(() => {
    if (!window.matchMedia) return undefined
    const list = window.matchMedia(query)
    const update = () => setMatches(list.matches)
    update()
    list.addEventListener('change', update)
    return () => list.removeEventListener('change', update)
  }, [query])
  return matches
}

/**
 * Height that makes the element at `ref` reach the bottom of the window, less
 * `bottomGap` (the page's bottom padding). Re-measured when the window or
 * anything on the page above it changes size, such as a wrapping header or a
 * message appearing. Never below `minHeight`, so short windows scroll the page.
 */
export function useFillHeight(ref, { bottomGap = 24, minHeight = 320 } = {}) {
  const [height, setHeight] = useState(null)

  useLayoutEffect(() => {
    const node = ref.current
    if (!node) return undefined
    let frame = 0
    const measure = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const top = node.getBoundingClientRect().top + window.scrollY
        setHeight(Math.max(minHeight, Math.floor(window.innerHeight - top - bottomGap)))
      })
    }
    measure()
    window.addEventListener('resize', measure)
    // The board's own height does not move its top, so this settles at once.
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null
    observer?.observe(document.body)
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('resize', measure)
      observer?.disconnect()
    }
  }, [ref, bottomGap, minHeight])

  return height
}

// Board filters live in the query string, so a filtered board is a link to share
// and survives a reload. `task` (the open dialog) is left alone.
export const EMPTY_FILTERS = {
  q: '',
  tag: '',
  mine: false,
  ready: false,
  decision: false,
  agents: false,
  side: '',
  area: '',
  lane: '',
  subtasks: 'all',
  status: [],
  priority: [],
  kind: [],
  // Who the task reaches; `none` means not set.
  audience: [],
  // Impact by default: work that reaches students first, oldest first inside
  // each group. It is also the server's default.
  sort: 'impact',
  order: '',
}

const FLAGS = ['mine', 'ready', 'decision', 'agents']
const TEXTS = ['q', 'tag', 'side', 'area']
const LISTS = { status: STATUSES, priority: PRIORITIES, kind: TASK_KINDS, audience: AUDIENCE_FILTER_VALUES }
const ONE_OF = {
  lane: ['planned', 'backlog'],
  subtasks: ['all', 'top', 'only'],
  sort: ['impact', 'created', 'updated', 'priority', 'points', 'due', 'title'],
  order: ['', 'asc', 'desc'],
}
// Other spellings people may have in old links.
const ALIASES = { status: 'statuses', kind: 'kinds', decision: 'awaiting_decision' }
const FILTER_KEYS = [...FLAGS, ...TEXTS, ...Object.keys(LISTS), ...Object.keys(ONE_OF), ...Object.values(ALIASES)]

function readParam(params, key) {
  return params.get(key) ?? (ALIASES[key] ? params.get(ALIASES[key]) : null)
}

export function readBoardFilters(params) {
  const filters = { ...EMPTY_FILTERS }
  for (const key of FLAGS) filters[key] = ['1', 'true', 'yes'].includes((readParam(params, key) ?? '').toLowerCase())
  for (const key of TEXTS) filters[key] = (readParam(params, key) ?? '').trim()
  for (const [key, allowed] of Object.entries(LISTS)) {
    const wanted = (readParam(params, key) ?? '').split(',').map((v) => v.trim())
    filters[key] = allowed.filter((value) => wanted.includes(value))
  }
  for (const [key, allowed] of Object.entries(ONE_OF)) {
    const value = readParam(params, key)
    filters[key] = allowed.includes(value) ? value : EMPTY_FILTERS[key]
  }
  return filters
}

function writeBoardFilters(params, filters) {
  for (const alias of Object.values(ALIASES)) params.delete(alias)
  for (const key of FLAGS) {
    if (filters[key]) params.set(key, '1')
    else params.delete(key)
  }
  for (const key of TEXTS) {
    const value = (filters[key] ?? '').trim()
    if (value) params.set(key, value)
    else params.delete(key)
  }
  for (const key of Object.keys(LISTS)) {
    if (filters[key]?.length) params.set(key, filters[key].join(','))
    else params.delete(key)
  }
  for (const key of Object.keys(ONE_OF)) {
    if (filters[key] && filters[key] !== EMPTY_FILTERS[key]) params.set(key, filters[key])
    else params.delete(key)
  }
  return params
}

/** True when any filter differs from the empty board. */
export function hasFilters(filters) {
  return Object.keys(EMPTY_FILTERS).filter((key) => key !== 'sort' && key !== 'order').some((key) =>
    Array.isArray(EMPTY_FILTERS[key]) ? filters[key].length > 0 : filters[key] !== EMPTY_FILTERS[key],
  )
}

/** Does `filters` show exactly the board `preset` describes (a ready-made view)? */
export function filtersMatch(filters, preset) {
  const want = { ...EMPTY_FILTERS, ...preset }
  return Object.keys(EMPTY_FILTERS).every((key) =>
    Array.isArray(want[key])
      ? want[key].length === filters[key].length && want[key].every((v) => filters[key].includes(v))
      : want[key] === filters[key],
  )
}

/**
 * The board filters from the URL. `update(patch)` changes some of them;
 * `replace(preset)` starts from an empty board (ready-made views, Clear all).
 * Both replace the history entry, so Back still closes an open task.
 */
export function useBoardFilters() {
  const [params, setParams] = useSearchParams()
  // Only the filter params: opening a task must not look like a filter change.
  const key = FILTER_KEYS.map((k) => `${k}=${params.get(k) ?? ''}`).join('&')
  // Keyed on the filter params alone; `params` is read fresh inside.
  const filters = useMemo(() => readBoardFilters(params), [key])

  const update = useCallback(
    (patch) =>
      setParams((current) => writeBoardFilters(current, { ...readBoardFilters(current), ...patch }), {
        replace: true,
      }),
    [setParams],
  )
  const replace = useCallback(
    (preset = {}) =>
      setParams((current) => writeBoardFilters(current, { ...EMPTY_FILTERS, ...preset }), { replace: true }),
    [setParams],
  )

  return { filters, update, replace }
}
