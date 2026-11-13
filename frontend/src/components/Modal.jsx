import { useEffect, useRef } from 'react'

const SIZES = { normal: 'max-w-lg', wide: 'max-w-2xl', xl: 'max-w-5xl' }

// Open modals, newest last. Escape closes only the top one, so a create form
// opened from a task's detail does not take the detail down with it.
const openStack = []

export default function Modal({ title, onClose, children, wide = false, size }) {
  const panelRef = useRef(null)
  // Keep the latest onClose without re-running the effect: a parent that
  // re-renders with a new arrow function would otherwise pull focus out of
  // whatever field the user is typing in.
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  useEffect(() => {
    const token = {}
    openStack.push(token)
    function onKeyDown(event) {
      if (event.key === 'Escape' && openStack[openStack.length - 1] === token) onCloseRef.current()
    }
    document.addEventListener('keydown', onKeyDown)
    panelRef.current?.focus()
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      const index = openStack.indexOf(token)
      if (index !== -1) openStack.splice(index, 1)
    }
  }, [])

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 py-10"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className={`w-full rounded-xl border border-hairline bg-surface shadow-xl outline-none ${
          SIZES[size ?? (wide ? 'wide' : 'normal')]
        }`}
      >
        <header className="flex items-center justify-between border-b border-hairline px-5 py-3.5">
          <h2 className="text-sm font-semibold">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-md px-2 py-1 text-ink-muted transition hover:text-ink"
          >
            ✕
          </button>
        </header>
        <div className="px-5 py-4">{children}</div>
      </div>
    </div>
  )
}
