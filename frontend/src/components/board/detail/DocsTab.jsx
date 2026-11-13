import { useCallback, useEffect, useState } from 'react'
import { ApiError, api } from '../../../api/client'
import { ActorBadge, PlainText } from '../../Badges'
import Markdown from '../../../lib/markdown'
import { DOC_KINDS, DOC_KIND_LABELS } from '../../../lib/constants'
import { formatDateTime } from '../../../lib/format'
import {
  inputClass,
  linkButton,
  primaryButton,
  secondaryButton,
  sectionTitle,
} from './ui'

const versionSelect =
  'rounded-lg border border-hairline bg-surface-raised px-2.5 py-1.5 text-sm outline-none focus:border-series1'

function KindBadge({ kind }) {
  return (
    <span className="inline-flex items-center rounded-full border border-hairline bg-surface-raised px-2 py-0.5 text-[11px] font-medium text-ink-secondary">
      {DOC_KIND_LABELS[kind] ?? kind}
    </span>
  )
}

function authorName(author) {
  if (!author) return 'someone'
  return author.handle ? `${author.name} (@${author.handle})` : author.name
}

/** Lines of a unified diff, coloured. The text stays plain text. */
function DiffView({ text }) {
  const lines = (text || '').replace(/\n$/, '').split('\n')
  return (
    <pre dir="ltr" className="max-h-[28rem] overflow-auto rounded-lg border border-hairline bg-surface-raised p-0 font-mono text-xs leading-relaxed">
      {lines.map((line, index) => {
        let style = 'text-ink-secondary'
        if (line.startsWith('+++') || line.startsWith('---')) style = 'font-semibold text-ink'
        else if (line.startsWith('@@')) style = 'bg-series1/5 text-series1'
        else if (line.startsWith('+')) style = 'bg-good/10 text-good'
        else if (line.startsWith('-')) style = 'bg-critical/10 text-critical'
        return (
          <span key={index} dir="auto" className={`block whitespace-pre-wrap break-words px-3 ${style}`}>
            {line || ' '}
          </span>
        )
      })}
    </pre>
  )
}

function NewDocForm({ ctx, onCreated, onCancel }) {
  const { task } = ctx
  const [form, setForm] = useState({ title: '', kind: 'notes', body: '', note: '' })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)

  function update(field, value) {
    setForm((current) => ({ ...current, [field]: value }))
  }

  async function submit(event) {
    event.preventDefault()
    setError(null)
    setSaving(true)
    try {
      const doc = await api.createDoc(task.id, {
        title: form.title.trim(),
        kind: form.kind,
        body: form.body,
        note: form.note.trim() || null,
      })
      await ctx.reload()
      onCreated(doc.slug)
    } catch (err) {
      setError(err.message)
      setSaving(false)
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3 rounded-lg border border-hairline p-3">
      <p className="text-sm font-medium">New document</p>
      <div className="grid gap-3 sm:grid-cols-[1fr_12rem]">
        <div>
          <label htmlFor="doc-title" className="block text-xs text-ink-muted">Title</label>
          <input
            id="doc-title"
            required
            maxLength={200}
            dir="auto"
            value={form.title}
            onChange={(e) => update('title', e.target.value)}
            className={inputClass}
          />
        </div>
        <div>
          <label htmlFor="doc-kind" className="block text-xs text-ink-muted">Kind</label>
          <select id="doc-kind" value={form.kind} onChange={(e) => update('kind', e.target.value)} className={inputClass}>
            {DOC_KINDS.map((k) => (
              <option key={k} value={k}>{DOC_KIND_LABELS[k]}</option>
            ))}
          </select>
        </div>
      </div>
      <div>
        <label htmlFor="doc-body" className="block text-xs text-ink-muted">Body (Markdown)</label>
        <textarea
          id="doc-body"
          rows={12}
          dir="auto"
          value={form.body}
          onChange={(e) => update('body', e.target.value)}
          className={`${inputClass} font-mono text-xs leading-relaxed`}
        />
      </div>
      <div>
        <label htmlFor="doc-note" className="block text-xs text-ink-muted">Note for the history (optional)</label>
        <input
          id="doc-note"
          maxLength={300}
          dir="auto"
          value={form.note}
          onChange={(e) => update('note', e.target.value)}
          className={inputClass}
        />
      </div>
      {error && <p role="alert" dir="auto" className="text-sm text-critical">{error}</p>}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} className={secondaryButton}>Cancel</button>
        <button type="submit" disabled={saving || !form.title.trim()} className={primaryButton}>
          {saving ? 'Creating…' : 'Create document'}
        </button>
      </div>
    </form>
  )
}

/** Edit the current version. Saving names the version you started from; when
 *  someone saved a newer one meanwhile, the server answers 409 and the editor
 *  loads theirs while keeping your text beside it. */
function DocEditor({ ctx, doc, onSaved, onCancel, onReloaded }) {
  const { task } = ctx
  const [title, setTitle] = useState(doc.title)
  const [kind, setKind] = useState(doc.kind)
  const [body, setBody] = useState(doc.body)
  const [note, setNote] = useState('')
  const [base, setBase] = useState(doc.version)
  const [mine, setMine] = useState(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)

  async function save(event) {
    event.preventDefault()
    setError(null)
    setSaving(true)
    try {
      const saved = await api.saveDoc(task.id, doc.slug, {
        body,
        base_version: base,
        title: title.trim() || undefined,
        kind,
        note: note.trim() || null,
      })
      await ctx.reload()
      onSaved(saved)
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        try {
          const latest = await api.doc(task.id, doc.slug)
          setMine({ body, title })
          setBody(latest.body)
          setTitle(latest.title)
          setKind(latest.kind)
          setBase(latest.version)
          onReloaded(latest)
          setError(
            `Someone saved a newer version (${latest.version}) while you were editing. ` +
              'The editor now holds their text; yours is in the box below. Merge your change in and save again.',
          )
        } catch (loadErr) {
          setError(`${err.message} Loading the newer version failed: ${loadErr.message}`)
        }
      } else {
        setError(err.message)
      }
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={save} className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-[1fr_12rem]">
        <div>
          <label htmlFor="edit-doc-title" className="block text-xs text-ink-muted">Title</label>
          <input
            id="edit-doc-title"
            required
            maxLength={200}
            dir="auto"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className={inputClass}
          />
        </div>
        <div>
          <label htmlFor="edit-doc-kind" className="block text-xs text-ink-muted">Kind</label>
          <select id="edit-doc-kind" value={kind} onChange={(e) => setKind(e.target.value)} className={inputClass}>
            {DOC_KINDS.map((k) => (
              <option key={k} value={k}>{DOC_KIND_LABELS[k]}</option>
            ))}
          </select>
        </div>
      </div>

      {error && (
        <p role="alert" dir="auto" className="rounded-lg border border-warning/50 px-3 py-2 text-sm text-ink-secondary">
          {error}
        </p>
      )}

      <div>
        <label htmlFor="edit-doc-body" className="block text-xs text-ink-muted">
          {mine ? `Version ${base} (saved by someone else). Edit this one.` : `Body (Markdown), editing version ${base}`}
        </label>
        <textarea
          id="edit-doc-body"
          rows={16}
          dir="auto"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          className={`${inputClass} font-mono text-xs leading-relaxed`}
        />
      </div>

      {mine && (
        <div>
          <div className="flex items-center justify-between">
            <label htmlFor="edit-doc-mine" className="block text-xs text-ink-muted">
              Your text, not saved{mine.title !== title ? ` (your title: ${mine.title})` : ''}
            </label>
            <button type="button" onClick={() => setMine(null)} className={linkButton}>
              Done merging, hide it
            </button>
          </div>
          <textarea
            id="edit-doc-mine"
            rows={10}
            dir="auto"
            value={mine.body}
            onChange={(e) => setMine((m) => ({ ...m, body: e.target.value }))}
            className={`${inputClass} border-warning/50 font-mono text-xs leading-relaxed`}
          />
        </div>
      )}

      <div>
        <label htmlFor="edit-doc-note" className="block text-xs text-ink-muted">What changed (note for the history)</label>
        <input
          id="edit-doc-note"
          maxLength={300}
          dir="auto"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          className={inputClass}
        />
      </div>
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} className={secondaryButton}>Cancel</button>
        <button type="submit" disabled={saving} className={primaryButton}>
          {saving ? 'Saving…' : 'Save new version'}
        </button>
      </div>
    </form>
  )
}

function DocHistory({ ctx, doc, canWrite, onView, onRestored }) {
  const { task } = ctx
  const [versions, setVersions] = useState(null)
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [diff, setDiff] = useState(null)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    api
      .docHistory(task.id, doc.slug)
      .then((list) => {
        if (cancelled) return
        setVersions(list)
        if (list.length >= 2) {
          setTo(String(list[0].n))
          setFrom(String(list[1].n))
        }
      })
      .catch((err) => !cancelled && setError(err.message))
    return () => {
      cancelled = true
    }
  }, [task.id, doc.slug, doc.current_version])

  async function showDiff() {
    setError(null)
    setBusy(true)
    try {
      setDiff(await api.docDiff(task.id, doc.slug, from, to))
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  async function restore(n) {
    if (!window.confirm(`Save version ${n} again as the newest version? History keeps everything.`)) return
    setError(null)
    setBusy(true)
    try {
      const restored = await api.restoreDoc(task.id, doc.slug, n)
      await ctx.reload()
      onRestored(restored)
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  if (error && !versions) return <p role="alert" dir="auto" className="text-sm text-critical">{error}</p>
  if (!versions) return <p className="text-sm text-ink-muted">Loading history…</p>

  return (
    <div className="space-y-4">
      <ul className="divide-y divide-hairline rounded-lg border border-hairline">
        {versions.map((v) => (
          <li key={v.n} className="flex flex-wrap items-center gap-2 px-3 py-2.5 text-sm">
            <span className="tabular w-10 shrink-0 font-medium">v{v.n}</span>
            <span dir="auto" className="text-ink-secondary">{authorName(v.author)}</span>
            <ActorBadge kind={v.actor_kind} agent={v.agent_name} />
            <span className="tabular text-xs text-ink-muted">{v.size.toLocaleString()} chars</span>
            <time className="text-xs text-ink-muted">{formatDateTime(v.created_at)}</time>
            <span className="ms-auto flex gap-2">
              <button type="button" onClick={() => onView(v.n)} className={linkButton}>View</button>
              {canWrite && v.n !== doc.current_version && (
                <button type="button" disabled={busy} onClick={() => restore(v.n)} className={linkButton}>
                  Restore
                </button>
              )}
            </span>
            {(v.note || v.title !== doc.title) && (
              <div className="basis-full ps-12 text-xs text-ink-secondary">
                {v.title !== doc.title && <PlainText as="span" className="block">Title: {v.title}</PlainText>}
                <PlainText as="span" className="block">{v.note}</PlainText>
              </div>
            )}
          </li>
        ))}
      </ul>

      {versions.length >= 2 && (
        <div className="space-y-2">
          <h4 className={sectionTitle}>Compare versions</h4>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <label className="flex items-center gap-1.5">
              From
              <select value={from} onChange={(e) => setFrom(e.target.value)} className={versionSelect}>
                {versions.map((v) => <option key={v.n} value={v.n}>v{v.n}</option>)}
              </select>
            </label>
            <label className="flex items-center gap-1.5">
              To
              <select value={to} onChange={(e) => setTo(e.target.value)} className={versionSelect}>
                {versions.map((v) => <option key={v.n} value={v.n}>v{v.n}</option>)}
              </select>
            </label>
            <button type="button" disabled={busy || from === to} onClick={showDiff} className={secondaryButton}>
              Show changes
            </button>
          </div>
          {error && <p role="alert" dir="auto" className="text-sm text-critical">{error}</p>}
          {diff !== null && <DiffView text={diff} />}
        </div>
      )}
    </div>
  )
}

const MODES = [
  { key: 'view', label: 'Read' },
  { key: 'raw', label: 'Raw' },
  { key: 'history', label: 'History' },
]

function DocView({ ctx, slug, canWrite, onBack }) {
  const { task } = ctx
  const [doc, setDoc] = useState(null)
  const [mode, setMode] = useState('view')
  const [error, setError] = useState(null)

  const load = useCallback(
    async (version) => {
      setError(null)
      try {
        setDoc(await api.doc(task.id, slug, version))
      } catch (err) {
        setError(err.message)
      }
    },
    [task.id, slug],
  )

  useEffect(() => {
    load()
  }, [load])

  if (error && !doc) {
    return (
      <div className="space-y-2">
        <button type="button" onClick={onBack} className={linkButton}>← All documents</button>
        <p role="alert" dir="auto" className="text-sm text-critical">{error}</p>
      </div>
    )
  }
  if (!doc) return <p className="text-sm text-ink-muted">Loading document…</p>

  const isCurrent = doc.version === doc.current_version

  return (
    <div className="space-y-3">
      <button type="button" onClick={onBack} className={linkButton}>← All documents</button>

      <div className="flex flex-wrap items-center gap-2">
        <h4 dir="auto" className="min-w-0 break-words text-base font-semibold">{doc.title}</h4>
        <KindBadge kind={doc.kind} />
        <span className="tabular text-xs text-ink-muted">
          Version {doc.version} of {doc.current_version}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs text-ink-muted">
        <span dir="auto">Saved by {authorName(doc.version_author)}</span>
        <ActorBadge kind={doc.version_actor_kind} agent={doc.version_agent_name} />
        <time>{formatDateTime(doc.version_created_at)}</time>
        {doc.note && <PlainText as="span" className="text-ink-secondary">· {doc.note}</PlainText>}
      </div>

      {!isCurrent && (
        <p className="rounded-lg border border-warning/50 px-3 py-2 text-sm text-ink-secondary">
          You are reading an older version.{' '}
          <button type="button" onClick={() => load()} className={linkButton}>
            Go to the current one
          </button>
        </p>
      )}

      {mode !== 'edit' && (
        <div className="flex flex-wrap items-center gap-1 border-b border-hairline">
          {MODES.map(({ key, label }) => (
            <button
              key={key}
              type="button"
              aria-pressed={mode === key}
              onClick={() => setMode(key)}
              className={`-mb-px border-b-2 px-3 py-1.5 text-sm transition ${
                mode === key ? 'border-series1 font-medium text-ink' : 'border-transparent text-ink-secondary hover:text-ink'
              }`}
            >
              {label}
            </button>
          ))}
          {canWrite && isCurrent && (
            <button type="button" onClick={() => setMode('edit')} className={`${secondaryButton} mb-1 ms-auto`}>
              Edit
            </button>
          )}
        </div>
      )}

      {mode === 'view' && (
        <div className="rounded-lg border border-hairline p-4">
          <Markdown source={doc.body} />
        </div>
      )}
      {mode === 'raw' && (
        <pre dir="auto" className="max-h-[32rem] overflow-auto whitespace-pre-wrap break-words rounded-lg border border-hairline bg-surface-raised p-3 font-mono text-xs leading-relaxed">
          {doc.body || ' '}
        </pre>
      )}
      {mode === 'edit' && (
        <DocEditor
          ctx={ctx}
          doc={doc}
          onCancel={() => setMode('view')}
          onReloaded={setDoc}
          onSaved={(saved) => {
            setDoc(saved)
            setMode('view')
          }}
        />
      )}
      {mode === 'history' && (
        <DocHistory
          ctx={ctx}
          doc={doc}
          canWrite={canWrite}
          onView={(n) => {
            load(n)
            setMode('view')
          }}
          onRestored={(restored) => {
            setDoc(restored)
            setMode('view')
          }}
        />
      )}
    </div>
  )
}

export default function DocsTab({ ctx, initialSlug = null }) {
  const { task, isWorker, isReadOnly } = ctx
  const [openSlug, setOpenSlug] = useState(initialSlug)
  const [creating, setCreating] = useState(false)
  const docs = task.docs ?? []
  // The server lets the people working on the task (and leads) write.
  const canWrite = isWorker && !isReadOnly

  if (openSlug) {
    return <DocView key={openSlug} ctx={ctx} slug={openSlug} canWrite={canWrite} onBack={() => setOpenSlug(null)} />
  }

  return (
    <div className="space-y-4">
      {docs.length === 0 ? (
        <p className="text-sm text-ink-muted">
          No documents yet. Specs, plans, test plans and hand-overs live here, with every version kept.
        </p>
      ) : (
        <ul className="divide-y divide-hairline rounded-lg border border-hairline">
          {docs.map((doc) => (
            <li key={doc.id}>
              <button
                type="button"
                onClick={() => setOpenSlug(doc.slug)}
                className="flex w-full flex-wrap items-center gap-2 px-3 py-2.5 text-start text-sm transition hover:bg-surface-raised"
              >
                <span dir="auto" className="min-w-0 flex-1 break-words font-medium">{doc.title}</span>
                <KindBadge kind={doc.kind} />
                <span className="tabular text-xs text-ink-muted">v{doc.current_version}</span>
                {doc.last_author && (
                  <span dir="auto" className="text-xs text-ink-secondary">{doc.last_author}</span>
                )}
                {doc.last_actor_kind && <ActorBadge kind={doc.last_actor_kind} />}
                <time className="text-xs text-ink-muted">{formatDateTime(doc.updated_at)}</time>
              </button>
            </li>
          ))}
        </ul>
      )}

      {canWrite &&
        (creating ? (
          <NewDocForm
            ctx={ctx}
            onCancel={() => setCreating(false)}
            onCreated={(slug) => {
              setCreating(false)
              setOpenSlug(slug)
            }}
          />
        ) : (
          <button type="button" onClick={() => setCreating(true)} className={secondaryButton}>
            New document
          </button>
        ))}
    </div>
  )
}
