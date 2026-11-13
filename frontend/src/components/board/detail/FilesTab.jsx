import { useEffect, useRef, useState } from 'react'
import { api } from '../../../api/client'
import { ActorBadge, PlainText } from '../../Badges'
import { FILE_EXTENSIONS, FILE_MAX_MB, IMAGE_MIMES, formatBytes } from '../../../lib/constants'
import { formatDateTime } from '../../../lib/format'
import { dangerButton, secondaryButton, smallInputClass } from './ui'

/** An image attachment, fetched with the Authorization header and shown from
 *  a blob URL that is freed again when the row goes away. */
function Thumbnail({ taskId, file }) {
  const [url, setUrl] = useState(null)
  const [failed, setFailed] = useState(false)
  const [large, setLarge] = useState(false)

  useEffect(() => {
    let objectUrl = null
    let cancelled = false
    api
      .fileBlob(taskId, file.id)
      .then((blob) => {
        if (cancelled) return
        // Re-type the blob from the allow-list so the browser never guesses.
        objectUrl = URL.createObjectURL(new Blob([blob], { type: file.mime }))
        setUrl(objectUrl)
      })
      .catch(() => !cancelled && setFailed(true))
    return () => {
      cancelled = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [taskId, file.id, file.mime])

  if (failed) return <span className="text-xs text-ink-muted">Preview unavailable</span>
  if (!url) return <span className="block h-16 w-24 animate-pulse rounded border border-hairline bg-surface-raised" />
  return (
    <button
      type="button"
      onClick={() => setLarge((v) => !v)}
      aria-label={large ? `Shrink ${file.name}` : `Enlarge ${file.name}`}
      className="block"
    >
      <img
        src={url}
        alt={file.name}
        className={`rounded border border-hairline object-contain ${large ? 'max-h-[28rem] max-w-full' : 'h-16 w-24 object-cover'}`}
      />
    </button>
  )
}

async function download(taskId, file) {
  const blob = await api.fileBlob(taskId, file.id)
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = file.name
  link.rel = 'noopener'
  document.body.appendChild(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function Uploader({ ctx }) {
  const { task } = ctx
  const inputRef = useRef(null)
  const [note, setNote] = useState('')
  const [over, setOver] = useState(false)
  const [busy, setBusy] = useState(false)
  const [results, setResults] = useState([])

  async function upload(fileList) {
    const files = [...(fileList ?? [])]
    if (files.length === 0) return
    setBusy(true)
    const out = []
    for (const file of files) {
      try {
        await api.uploadFile(task.id, file, note.trim() || null)
        out.push({ name: file.name, ok: true })
      } catch (err) {
        // The server's words: type not accepted, too large, not a real PNG, space full.
        out.push({ name: file.name, ok: false, error: err.message })
      }
    }
    setResults(out)
    if (out.some((r) => r.ok)) {
      setNote('')
      await ctx.reload()
    }
    setBusy(false)
    if (inputRef.current) inputRef.current.value = ''
  }

  return (
    <div className="space-y-2">
      <div
        onDragOver={(event) => {
          event.preventDefault()
          setOver(true)
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(event) => {
          event.preventDefault()
          setOver(false)
          if (!busy) upload(event.dataTransfer.files)
        }}
        className={`rounded-lg border-2 border-dashed px-4 py-5 text-center transition ${
          over ? 'border-series1 bg-series1/5' : 'border-hairline'
        }`}
      >
        <p className="text-sm">
          {busy ? 'Uploading…' : 'Drop files here or '}
          {!busy && (
            <button type="button" onClick={() => inputRef.current?.click()} className="text-series1 underline-offset-2 hover:underline">
              pick files
            </button>
          )}
        </p>
        <p className="mt-1 text-xs text-ink-muted">
          <span dir="ltr">{FILE_EXTENSIONS.join(' ')}</span> · up to {FILE_MAX_MB} MB each. No SVG or HTML.
        </p>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept={FILE_EXTENSIONS.join(',')}
          onChange={(event) => upload(event.target.files)}
          className="sr-only"
          tabIndex={-1}
          aria-hidden="true"
        />
      </div>
      <input
        aria-label="Note for the next upload"
        placeholder="Note for the next upload (optional)"
        dir="auto"
        maxLength={300}
        value={note}
        onChange={(e) => setNote(e.target.value)}
        className={smallInputClass}
      />
      {results.length > 0 && (
        <ul className="space-y-0.5 text-sm" role="status">
          {results.map((r, index) => (
            <li key={`${r.name}-${index}`} dir="auto" className={r.ok ? 'text-good' : 'text-critical'}>
              {r.ok ? `Uploaded ${r.name}` : `${r.name}: ${r.error}`}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export default function FilesTab({ ctx }) {
  const { task, user, people, isLead, isWorker, isReadOnly, busy, run } = ctx
  const files = task.files ?? []
  const peopleById = Object.fromEntries((people ?? []).map((p) => [p.id, p]))
  const [error, setError] = useState(null)
  const canUpload = isWorker && !isReadOnly

  async function remove(file) {
    if (!window.confirm(`Remove ${file.name} from this task?`)) return
    await run(() => api.removeFile(task.id, file.id), { reloadAfter: true, success: `Removed ${file.name}.` })
  }

  return (
    <div className="space-y-4">
      {error && <p role="alert" dir="auto" className="text-sm text-critical">{error}</p>}
      {files.length === 0 ? (
        <p className="text-sm text-ink-muted">No files attached.</p>
      ) : (
        <ul className="divide-y divide-hairline rounded-lg border border-hairline">
          {files.map((file) => {
            const uploader = peopleById[file.uploaded_by]
            const canRemove = !isReadOnly && (isLead || file.uploaded_by === user.id)
            return (
              <li key={file.id} className="flex flex-wrap items-start gap-3 px-3 py-2.5 text-sm">
                {IMAGE_MIMES.includes(file.mime) && <Thumbnail taskId={task.id} file={file} />}
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span dir="auto" className="break-all font-medium">{file.name}</span>
                    <span className="tabular text-xs text-ink-muted">{formatBytes(file.size)}</span>
                  </div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-ink-muted">
                    <span dir="auto">{uploader?.name ?? `user ${file.uploaded_by}`}</span>
                    <ActorBadge kind={file.actor_kind} agent={file.agent_name} />
                    <time>{formatDateTime(file.created_at)}</time>
                  </div>
                  <PlainText className="mt-1 text-sm text-ink-secondary">{file.note}</PlainText>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setError(null)
                      download(task.id, file).catch((err) => setError(`${file.name}: ${err.message}`))
                    }}
                    className={secondaryButton}
                  >
                    Download
                  </button>
                  {canRemove && (
                    <button type="button" disabled={busy} onClick={() => remove(file)} className={dangerButton}>
                      Remove
                    </button>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      )}
      {canUpload ? (
        <Uploader ctx={ctx} />
      ) : (
        !isReadOnly && (
          <p className="text-xs text-ink-muted">
            The people on this task and leads can attach files.
          </p>
        )
      )}
    </div>
  )
}
