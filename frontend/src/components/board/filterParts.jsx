import { createContext, useContext, useEffect, useId, useRef, useState } from 'react'
import { api } from '../../api/client'
import { ChevronDown } from './BoardIcons'

export const control =
  'h-8 rounded-lg border bg-surface-raised px-2.5 text-sm outline-none transition focus:border-series1'

export const chipBase =
  'inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-full border px-3 text-sm transition'

export function chipTone(active, tone = 'series1') {
  if (!active) return 'border-hairline text-ink-secondary hover:border-series1/40 hover:text-ink'
  return tone === 'series2'
    ? 'border-series2 bg-series2/10 text-series2'
    : 'border-series1 bg-series1/10 text-series1'
}

// Inside the phone filter sheet, menus open in place (below their chip)
// instead of floating, so the sheet's own scroll never clips them.
export const InlineMenus = createContext(false)

export function Count({ value }) {
  if (value === undefined || value === null) return null
  return <span className="tabular ms-auto ps-3 text-xs text-ink-muted">{value}</span>
}

/** Facet counts while `enabled`, for `params` (already minus the menu's own filter). */
export function useFacets(params, enabled) {
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

export function without(params, keys) {
  const next = { ...params }
  for (const key of keys) delete next[key]
  return next
}

/**
 * Close an open popover on a click outside `wrapRef` or on Escape (focus goes
 * back to `buttonRef`). Escape is caught in the capture phase and marked
 * handled, so a panel or sheet around the popover stays open on that press.
 */
export function useDismiss(open, setOpen, wrapRef, buttonRef) {
  useEffect(() => {
    if (!open) return undefined
    function onPointer(event) {
      if (!wrapRef.current?.contains(event.target)) setOpen(false)
    }
    function onKey(event) {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      event.preventDefault()
      setOpen(false)
      buttonRef.current?.focus()
    }
    document.addEventListener('mousedown', onPointer)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('mousedown', onPointer)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [open, setOpen, wrapRef, buttonRef])
}

/** Should a popover of `width` px under `button` open towards the inline start? */
export function flipsToEnd(button, width = 256) {
  const rect = button?.getBoundingClientRect()
  if (!rect) return false
  const rtl = getComputedStyle(button).direction === 'rtl'
  return rtl ? rect.right - width < 8 : rect.left + width > window.innerWidth - 8
}

/**
 * A chip that opens a small menu. `children(facets, close)` renders the options;
 * the counts come from /tasks/facets for the current filters minus `omit`, so a
 * menu shows what each of its own options would give.
 */
export function MenuChip({ icon: Glyph, label, summary, active, facetParams, omit = [], children, width = 'w-60' }) {
  const inline = useContext(InlineMenus)
  const [open, setOpen] = useState(false)
  const [alignEnd, setAlignEnd] = useState(false)
  const wrapRef = useRef(null)
  const buttonRef = useRef(null)
  const menuId = useId()
  const { data: facets, failed } = useFacets(without(facetParams, omit), open)
  useDismiss(open && !inline, setOpen, wrapRef, buttonRef)

  function toggle() {
    // Near the screen edge, open the menu the other way so it stays on screen.
    if (!open && !inline) setAlignEnd(flipsToEnd(buttonRef.current))
    setOpen((value) => !value)
  }

  const close = () => {
    setOpen(false)
    if (inline) buttonRef.current?.focus()
  }

  return (
    <div ref={wrapRef} className={inline ? 'w-full' : 'relative'}>
      <button
        ref={buttonRef}
        type="button"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={toggle}
        className={`${chipBase} ${chipTone(active)} ${inline ? 'w-full' : ''}`}
      >
        <Glyph />
        <span>{label}</span>
        {summary && (
          <span dir="auto" className={`truncate font-medium ${inline ? 'min-w-0 flex-1 text-start' : 'max-w-[8rem]'}`}>
            : {summary}
          </span>
        )}
        <ChevronDown className={`h-3 w-3 opacity-70 transition ${inline ? 'ms-auto' : ''} ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div
          id={menuId}
          role="group"
          aria-label={label}
          className={
            inline
              ? 'mt-1 rounded-lg border border-hairline bg-surface p-1'
              : `absolute top-full z-30 mt-1 ${width} max-w-[calc(100vw-2rem)] rounded-lg border border-hairline bg-surface p-1 shadow-lg ${
                  alignEnd ? 'end-0' : 'start-0'
                }`
          }
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

export function Option({ checked, multi = false, onClick, children, count, className = '' }) {
  return (
    <button
      type="button"
      aria-pressed={checked}
      onClick={onClick}
      className={`flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-start text-sm transition hover:bg-surface-raised ${
        checked ? 'font-medium text-series1' : 'text-ink'
      } ${className}`}
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
