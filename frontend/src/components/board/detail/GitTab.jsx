import { useState } from 'react'
import { api } from '../../../api/client'
import { ActorBadge } from '../../Badges'
import { GIT_KINDS, GIT_KIND_LABELS, GIT_STATES } from '../../../lib/constants'
import { formatDateTime } from '../../../lib/format'
import { primaryButton, smallInputClass } from './ui'

const STATE_STYLES = {
  open: 'border-series1/40 text-series1',
  merged: 'border-good/40 text-good',
  closed: 'border-hairline text-ink-muted',
}

function shortRef(link) {
  if (link.kind === 'commit') return link.ref.slice(0, 12)
  if (link.kind === 'pr') return `#${link.ref}`
  return link.ref
}

// The server only stores https URLs; check again before making a link.
function safeUrl(url) {
  return typeof url === 'string' && url.startsWith('https://') ? url : null
}

function AddLinkForm({ ctx }) {
  const { task, busy, run } = ctx
  const empty = { repo: '', kind: 'branch', ref: '', url: '', title: '', state: '' }
  const [form, setForm] = useState(empty)

  function update(field, value) {
    setForm((current) => ({ ...current, [field]: value }))
  }

  async function submit(event) {
    event.preventDefault()
    const payload = {
      repo: form.repo.trim(),
      kind: form.kind,
      ref: form.ref.trim(),
      url: form.url.trim() || null,
      title: form.title.trim() || null,
      state: form.state || null,
    }
    const ok = await run(() => api.addGitLink(task.id, payload), { reloadAfter: true })
    if (ok) setForm(empty)
  }

  const refHint = {
    branch: 'branch name',
    pr: 'PR number',
    commit: 'commit hash (7 to 40 hex)',
  }[form.kind]

  return (
    <form onSubmit={submit} className="space-y-2 rounded-lg border border-hairline p-3">
      <p className="text-sm font-medium">Link a branch, PR or commit</p>
      <p className="text-xs text-ink-muted">Linking the same ref again updates its title, URL and state.</p>
      <div className="grid gap-2 sm:grid-cols-[1fr_9rem_1fr]">
        <input
          aria-label="Repository"
          required
          dir="ltr"
          placeholder="owner/name"
          value={form.repo}
          onChange={(e) => update('repo', e.target.value)}
          className={`${smallInputClass} font-mono text-xs`}
        />
        <select aria-label="Kind" value={form.kind} onChange={(e) => update('kind', e.target.value)} className={smallInputClass}>
          {GIT_KINDS.map((k) => (
            <option key={k} value={k}>{GIT_KIND_LABELS[k]}</option>
          ))}
        </select>
        <input
          aria-label="Ref"
          required
          dir="ltr"
          maxLength={200}
          placeholder={refHint}
          value={form.ref}
          onChange={(e) => update('ref', e.target.value)}
          className={`${smallInputClass} font-mono text-xs`}
        />
      </div>
      <div className="grid gap-2 sm:grid-cols-[1fr_1fr_9rem]">
        <input
          aria-label="Title"
          dir="auto"
          maxLength={300}
          placeholder="title (optional)"
          value={form.title}
          onChange={(e) => update('title', e.target.value)}
          className={smallInputClass}
        />
        <input
          aria-label="URL"
          type="url"
          dir="ltr"
          pattern="https://.*"
          maxLength={500}
          placeholder="https://… (optional)"
          value={form.url}
          onChange={(e) => update('url', e.target.value)}
          className={`${smallInputClass} text-xs`}
        />
        <select aria-label="State" value={form.state} onChange={(e) => update('state', e.target.value)} className={smallInputClass}>
          <option value="">No state</option>
          {GIT_STATES.map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
      </div>
      <div className="flex justify-end">
        <button type="submit" disabled={busy || !form.repo.trim() || !form.ref.trim()} className={primaryButton}>
          Add link
        </button>
      </div>
    </form>
  )
}

export default function GitTab({ ctx, links }) {
  const { isWorker, isViewer } = ctx

  return (
    <div className="space-y-4">
      {links.length === 0 ? (
        <p className="text-sm text-ink-muted">No branches, PRs or commits linked yet.</p>
      ) : (
        <ul className="divide-y divide-hairline rounded-lg border border-hairline">
          {links.map((link) => {
            const url = safeUrl(link.url)
            const ref = <code dir="ltr" className="font-mono text-xs">{shortRef(link)}</code>
            return (
              <li key={link.id} className="flex flex-wrap items-center gap-2 px-3 py-2.5 text-sm">
                <span className="w-24 shrink-0 text-xs text-ink-muted">{GIT_KIND_LABELS[link.kind] ?? link.kind}</span>
                <code dir="ltr" className="font-mono text-xs text-ink-secondary">{link.repo}</code>
                {url ? (
                  <a href={url} target="_blank" rel="noopener noreferrer" className="text-series1 underline-offset-2 hover:underline">
                    {ref}
                  </a>
                ) : (
                  ref
                )}
                {link.title && (
                  <span dir="auto" className="min-w-0 flex-1 truncate text-ink-secondary" title={link.title}>
                    {link.title}
                  </span>
                )}
                {link.state && (
                  <span className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${STATE_STYLES[link.state] ?? STATE_STYLES.closed}`}>
                    {link.state}
                  </span>
                )}
                <ActorBadge kind={link.actor_kind} />
                <time className="ms-auto text-xs text-ink-muted">{formatDateTime(link.updated_at)}</time>
              </li>
            )
          })}
        </ul>
      )}
      {isWorker && !isViewer && <AddLinkForm ctx={ctx} />}
    </div>
  )
}
