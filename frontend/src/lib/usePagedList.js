import { useCallback, useEffect, useRef, useState } from 'react'
import { PAGE_SIZE } from '../api/client'

const byId = (row) => row.id

/**
 * A list read one page at a time (20 rows), for "load more" and infinite
 * scroll. `fetchPage(page, pageSize)` resolves to `{ items, total }` (the
 * `api.*Page` calls do). The list starts over whenever `fetchPage` changes, so
 * wrap it in `useCallback` with the filters as dependencies.
 */
export function usePagedList(fetchPage, { pageSize = PAGE_SIZE, keyOf = byId } = {}) {
  const [items, setItems] = useState([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState(null)
  // Rows the server has handed over; the next page is worked out from it.
  const served = useRef(0)
  const requestId = useRef(0)
  const busy = useRef(false)

  const reload = useCallback(async () => {
    const id = ++requestId.current
    busy.current = true
    setLoading(true)
    try {
      const first = await fetchPage(1, pageSize)
      if (id !== requestId.current) return
      served.current = first.items.length
      setItems(first.items)
      setTotal(first.total)
      setError(null)
    } catch (err) {
      if (id === requestId.current) setError(err.message)
    } finally {
      if (id === requestId.current) {
        busy.current = false
        setLoading(false)
        setLoadingMore(false)
      }
    }
  }, [fetchPage, pageSize])

  useEffect(() => {
    reload()
  }, [reload])

  const loadMore = useCallback(async () => {
    if (busy.current) return
    const id = requestId.current
    busy.current = true
    setLoadingMore(true)
    try {
      const pageNumber = Math.floor(served.current / pageSize) + 1
      const next = await fetchPage(pageNumber, pageSize)
      if (id !== requestId.current) return
      served.current = (pageNumber - 1) * pageSize + next.items.length
      setItems((current) => {
        const seen = new Set(current.map(keyOf))
        const fresh = next.items.filter((row) => !seen.has(keyOf(row)))
        return fresh.length ? [...current, ...fresh] : current
      })
      // A page with nothing new means the end, whatever the count says.
      setTotal(next.items.length === 0 ? served.current : Math.max(next.total, served.current))
      setError(null)
    } catch (err) {
      if (id === requestId.current) setError(err.message)
    } finally {
      if (id === requestId.current) {
        busy.current = false
        setLoadingMore(false)
      }
    }
  }, [fetchPage, pageSize, keyOf])

  return {
    items,
    setItems,
    total: Math.max(total, items.length),
    setTotal,
    loading,
    loadingMore,
    error,
    setError,
    hasMore: !loading && served.current < total,
    loadMore,
    reload,
  }
}
