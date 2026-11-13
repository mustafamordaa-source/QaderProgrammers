import { useMemo, useRef, useState } from 'react'

const MAX_SUGGESTIONS = 6

// An "@" that starts a mention: at the start or after a character that cannot
// be part of a word or an email address, matching MENTION_RE in
// backend/app/notify.py.
const OPEN_MENTION = /(?:^|[^\w@.])@([a-z0-9_-]{0,39})$/i

/** People who can be mentioned: active people and bots with a handle, not you.
 * A tagged bot gets a notification and replies in the thread. */
export function mentionablePeople(people, user) {
  return (people ?? []).filter(
    (p) => p.handle && p.is_active !== false && p.id !== user?.id,
  )
}

function openQuery(text, caret) {
  const match = OPEN_MENTION.exec(text.slice(0, caret))
  return match ? { query: match[1].toLowerCase(), start: caret - match[1].length - 1 } : null
}

/**
 * A textarea that suggests people when you type "@". Picking one inserts
 * "@handle ". Arrow keys move, Enter or Tab picks, Escape closes.
 */
export default function MentionTextarea({ value, onChange, people, user, className = '', ...props }) {
  const ref = useRef(null)
  const [mention, setMention] = useState(null)
  const [active, setActive] = useState(0)

  const candidates = useMemo(() => mentionablePeople(people, user), [people, user])

  const suggestions = useMemo(() => {
    if (!mention) return []
    const q = mention.query
    const starts = []
    const contains = []
    for (const p of candidates) {
      const handle = p.handle.toLowerCase()
      const name = (p.name ?? '').toLowerCase()
      if (handle.startsWith(q) || name.startsWith(q)) starts.push(p)
      else if (handle.includes(q) || name.includes(q)) contains.push(p)
    }
    return [...starts, ...contains].slice(0, MAX_SUGGESTIONS)
  }, [mention, candidates])

  function track(el) {
    const next = el.selectionStart === el.selectionEnd ? openQuery(el.value, el.selectionStart) : null
    if (!next || !mention || mention.query !== next.query || mention.start !== next.start) setActive(0)
    setMention(next)
  }

  function pick(person) {
    const el = ref.current
    const caret = el?.selectionStart ?? value.length
    const before = value.slice(0, mention.start)
    const after = value.slice(caret)
    const inserted = `@${person.handle}${after.startsWith(' ') ? '' : ' '}`
    onChange(before + inserted + after)
    setMention(null)
    const pos = before.length + inserted.length
    requestAnimationFrame(() => {
      if (!ref.current) return
      ref.current.focus()
      ref.current.setSelectionRange(pos, pos)
    })
  }

  function onKeyDown(event) {
    if (!mention || suggestions.length === 0) return
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActive((i) => (i + 1) % suggestions.length)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActive((i) => (i - 1 + suggestions.length) % suggestions.length)
    } else if (event.key === 'Enter' || event.key === 'Tab') {
      event.preventDefault()
      pick(suggestions[Math.min(active, suggestions.length - 1)])
    } else if (event.key === 'Escape') {
      // Close the list without closing the task modal around it.
      event.preventDefault()
      event.stopPropagation()
      event.nativeEvent.stopImmediatePropagation?.()
      setMention(null)
    }
  }

  const listId = props.id ? `${props.id}-mentions` : undefined
  const open = Boolean(mention) && suggestions.length > 0

  return (
    <div className="relative">
      <textarea
        {...props}
        ref={ref}
        value={value}
        onChange={(event) => {
          onChange(event.target.value)
          track(event.target)
        }}
        onKeyDown={onKeyDown}
        onClick={(event) => track(event.currentTarget)}
        onKeyUp={(event) => {
          if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) track(event.currentTarget)
        }}
        onBlur={() => setTimeout(() => setMention(null), 150)}
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        className={className}
      />
      {open && (
        <ul
          id={listId}
          role="listbox"
          aria-label="People to mention"
          className="absolute start-0 top-full z-10 mt-1 w-64 max-w-full overflow-hidden rounded-lg border border-hairline bg-surface shadow-lg"
        >
          {suggestions.map((p, index) => (
            <li key={p.id} role="option" aria-selected={index === active}>
              <button
                type="button"
                tabIndex={-1}
                onMouseDown={(event) => {
                  // Keep focus in the textarea so the caret position survives.
                  event.preventDefault()
                  pick(p)
                }}
                onMouseEnter={() => setActive(index)}
                className={`flex w-full items-baseline gap-2 px-3 py-1.5 text-start text-sm ${
                  index === active ? 'bg-surface-raised' : ''
                }`}
              >
                <span dir="ltr" className="font-mono text-xs text-series1">@{p.handle}</span>
                <span dir="auto" className="min-w-0 truncate text-ink-secondary">{p.name}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export function MentionHint() {
  return (
    <p className="text-xs text-ink-muted">
      Type @ to mention someone by handle. People you mention get a notification if they can see this task.
    </p>
  )
}
