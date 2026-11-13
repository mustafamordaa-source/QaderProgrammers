import { useCallback, useEffect, useLayoutEffect, useState } from 'react'

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
    }
  } catch {
    return { collapsed: [], density: 'comfortable', groupBy: 'none' }
  }
}

/** Collapsed columns, card density and grouping, kept per browser. */
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

  return {
    collapsed: prefs.collapsed,
    density: prefs.density,
    groupBy: prefs.groupBy,
    toggleCollapsed,
    setDensity,
    setGroupBy,
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
