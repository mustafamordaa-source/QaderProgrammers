import { useState } from 'react'
import Markdown from '../lib/markdown'

/**
 * Write / Preview tabs around a text box that takes Markdown. `children` is
 * the text box itself; Preview shows `value` rendered the way readers will see
 * it (same safe renderer as documents: no HTML, no images).
 */
export default function WithPreview({ value, children }) {
  const [preview, setPreview] = useState(false)
  const tab = (on) =>
    `rounded-md px-2 py-0.5 text-xs ${on ? 'bg-surface-raised font-medium text-ink' : 'text-ink-muted hover:text-ink'}`
  return (
    <div>
      <div role="tablist" aria-label="Write or preview" className="mb-1 flex items-center gap-1">
        <button type="button" role="tab" aria-selected={!preview} className={tab(!preview)} onClick={() => setPreview(false)}>
          Write
        </button>
        <button type="button" role="tab" aria-selected={preview} className={tab(preview)} onClick={() => setPreview(true)}>
          Preview
        </button>
        <span className="ms-auto text-[11px] text-ink-muted">Markdown supported</span>
      </div>
      {preview ? (
        <div className="min-h-[5rem] rounded-lg border border-hairline px-3 py-2">
          {value?.trim() ? <Markdown source={value} /> : <p className="text-sm text-ink-muted">Nothing to preview.</p>}
        </div>
      ) : (
        children
      )}
    </div>
  )
}

/** Markdown for task text people wrote (description, summary, comments). */
export function RichText({ children, className = '' }) {
  if (children === null || children === undefined || children === '') return null
  return <Markdown source={String(children)} className={className} />
}
