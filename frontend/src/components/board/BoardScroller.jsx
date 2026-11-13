import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight } from './BoardIcons'
import { COLUMN_GAP, COLUMN_STEP } from './boardLayout'

// Pointer presses on these never start a drag-to-scroll.
const INTERACTIVE = '[data-card], button, a, input, select, textarea, label, [role="tab"]'
const EDGE = 64 // px from an edge where a dragged card scrolls the board

/**
 * The board's horizontal scroll area. Its scrollbar sits at the bottom of the
 * window because the area is sized to fill it. Besides the scrollbar, wheel
 * and trackpad, it moves with the edge buttons, by dragging empty space with
 * the mouse, with the arrow keys while it has focus, and on its own when a
 * dragged card nears an edge.
 *
 * `step` mode: 'column' moves one column (desktop), 'page' moves one full
 * width (phones, where a column fills the screen).
 */
export default function BoardScroller({
  scrollRef,
  children,
  label,
  step = 'column',
  vertical = false,
  showEdgeButtons = true,
  snap = false,
  onScrollChange,
  contentKey = '',
}) {
  const [edges, setEdges] = useState({ left: false, right: false })
  const drag = useRef(null)

  const update = useCallback(() => {
    const node = scrollRef.current
    if (!node) return
    const max = node.scrollWidth - node.clientWidth
    // The board lays out left to right; the edge buttons are physical left and right.
    const at = Math.abs(node.scrollLeft)
    setEdges((current) => {
      const next = { left: at > 2, right: at < max - 2 }
      return current.left === next.left && current.right === next.right ? current : next
    })
    onScrollChange?.(node)
  }, [scrollRef, onScrollChange])

  useEffect(() => {
    const node = scrollRef.current
    if (!node) return undefined
    update()
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(update) : null
    observer?.observe(node)
    if (node.firstElementChild) observer?.observe(node.firstElementChild)
    window.addEventListener('resize', update)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', update)
    }
  }, [scrollRef, update, contentKey])

  const stepSize = useCallback(
    (node, wide = false) => {
      if (step === 'page') return node.clientWidth + COLUMN_GAP
      // Buttons move a screenful less one column, so you keep your bearings.
      return wide ? Math.max(COLUMN_STEP, node.clientWidth - COLUMN_STEP) : COLUMN_STEP
    },
    [step],
  )

  const scrollByStep = useCallback(
    (direction, wide = false) => {
      const node = scrollRef.current
      if (!node) return
      node.scrollBy({ left: direction * stepSize(node, wide), behavior: 'smooth' })
    },
    [scrollRef, stepSize],
  )

  function handleKeyDown(event) {
    if (event.target !== event.currentTarget) return
    const node = event.currentTarget
    if (event.key === 'ArrowRight') {
      event.preventDefault()
      scrollByStep(1)
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault()
      scrollByStep(-1)
    } else if (event.key === 'Home') {
      event.preventDefault()
      node.scrollTo({ left: 0, behavior: 'smooth' })
    } else if (event.key === 'End') {
      event.preventDefault()
      node.scrollTo({ left: node.scrollWidth, behavior: 'smooth' })
    }
  }

  // Drag-to-scroll on empty space, mouse only (touch already pans natively).
  function handlePointerDown(event) {
    if (event.pointerType !== 'mouse' || event.button !== 0) return
    const target = event.target
    if (!(target instanceof Element) || target.closest(INTERACTIVE)) return
    // A press on a column's own scrollbar belongs to that scrollbar.
    if (target.clientWidth && (event.offsetX > target.clientWidth || event.offsetY > target.clientHeight)) return
    const node = scrollRef.current
    drag.current = {
      x: event.clientX,
      y: event.clientY,
      left: node.scrollLeft,
      top: node.scrollTop,
      moved: false,
      id: event.pointerId,
    }
  }

  function handlePointerMove(event) {
    const state = drag.current
    if (!state || state.id !== event.pointerId) return
    const node = scrollRef.current
    const dx = event.clientX - state.x
    const dy = event.clientY - state.y
    if (!state.moved) {
      if (Math.abs(dx) < 4 && Math.abs(dy) < 4) return
      state.moved = true
      node.setPointerCapture?.(event.pointerId)
      node.dataset.dragging = 'true'
      window.getSelection?.()?.removeAllRanges()
    }
    node.scrollLeft = state.left - dx
    if (vertical) node.scrollTop = state.top - dy
  }

  function endPointer(event) {
    const state = drag.current
    if (!state || state.id !== event.pointerId) return
    const node = scrollRef.current
    if (state.moved) {
      node.releasePointerCapture?.(event.pointerId)
      delete node.dataset.dragging
    }
    drag.current = null
  }

  // A card dragged near an edge scrolls the board that way.
  function handleDragOver(event) {
    const node = scrollRef.current
    if (!node) return
    const rect = node.getBoundingClientRect()
    if (event.clientX < rect.left + EDGE) node.scrollLeft -= 18
    else if (event.clientX > rect.right - EDGE) node.scrollLeft += 18
    if (vertical) {
      if (event.clientY < rect.top + EDGE) node.scrollTop -= 14
      else if (event.clientY > rect.bottom - EDGE) node.scrollTop += 14
    }
  }

  const edgeButton =
    'absolute top-1/2 z-30 hidden -translate-y-1/2 place-items-center rounded-full border border-hairline bg-surface/95 p-2 text-ink-secondary shadow-md backdrop-blur transition hover:text-ink md:grid'

  return (
    <div className="relative h-full min-h-0">
      <div
        ref={scrollRef}
        tabIndex={0}
        role="region"
        aria-label={`${label}. Arrow keys scroll sideways.`}
        onKeyDown={handleKeyDown}
        onScroll={update}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endPointer}
        onPointerCancel={endPointer}
        onDragOver={handleDragOver}
        className={[
          'board-scroll h-full overflow-x-auto overscroll-x-contain rounded-xl focus-visible:outline-offset-[-2px]',
          vertical ? 'overflow-y-auto' : 'overflow-y-hidden',
          snap ? 'snap-x snap-mandatory' : '',
        ].join(' ')}
      >
        {children}
      </div>

      {showEdgeButtons && edges.left && (
        <button
          type="button"
          onClick={() => scrollByStep(-1, true)}
          aria-label="Scroll board left"
          title="Scroll left"
          className={`${edgeButton} left-2`}
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
      )}
      {showEdgeButtons && edges.right && (
        <button
          type="button"
          onClick={() => scrollByStep(1, true)}
          aria-label="Scroll board right"
          title="Scroll right"
          className={`${edgeButton} right-2`}
        >
          <ChevronRight className="h-4 w-4" />
        </button>
      )}
    </div>
  )
}
