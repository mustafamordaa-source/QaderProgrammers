import { useEffect, useRef } from 'react'
import { PAGE_SIZE } from '../api/client'

/**
 * The end of a paged list: a count ("20 of 134") and a button that loads the
 * next page. The next page also loads on its own when this row scrolls into
 * view. Pass `scrollRoot` (a CSS selector) when the list scrolls inside a box
 * instead of the page. Renders nothing once everything is shown.
 */
export default function LoadMore({
  shown,
  total,
  hasMore,
  loading = false,
  onMore,
  noun = 'rows',
  scrollRoot = null,
  compact = false,
}) {
  const ref = useRef(null)
  const onMoreRef = useRef(onMore)
  onMoreRef.current = onMore

  useEffect(() => {
    const node = ref.current
    if (!node || !hasMore || loading || typeof IntersectionObserver === 'undefined') return undefined
    const root = scrollRoot ? node.closest(scrollRoot) : null
    // A fresh observer reports straight away, so a list too short to scroll
    // keeps loading until it fills the view.
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) onMoreRef.current()
      },
      { root, rootMargin: '200px 0px' },
    )
    observer.observe(node)
    return () => observer.disconnect()
  }, [hasMore, loading, shown, scrollRoot])

  if (!hasMore) return null
  const next = Math.max(1, Math.min(PAGE_SIZE, total - shown))
  return (
    <div
      ref={ref}
      className={`flex flex-wrap items-center justify-center gap-2 ${compact ? 'mt-2' : 'mt-3'} text-xs text-ink-muted`}
    >
      {!compact && (
        <span className="tabular">
          {shown} of {total} {noun}
        </span>
      )}
      <button
        type="button"
        onClick={onMore}
        disabled={loading}
        className="rounded-md px-2 py-1 font-medium text-series1 transition hover:bg-surface disabled:opacity-60"
      >
        {loading ? 'Loading…' : `Load ${next} more`}
      </button>
    </div>
  )
}
