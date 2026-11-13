import { useState } from 'react'
import { api } from '../../../api/client'
import { ActorBadge, PlainText } from '../../Badges'
import { githubBlobUrl, safeHttpsUrl } from '../../../lib/constants'
import { formatDateTime } from '../../../lib/format'
import { dangerButton, primaryButton, smallInputClass } from './ui'

/** `owner/repo: path @ref`, the way agents write it. */
export function repoLabel(link) {
  return `${link.repo}: ${link.path}${link.ref ? ` @${link.ref}` : ''}`
}

function hostOf(url) {
  try {
    return new URL(url).host
  } catch {
    return ''
  }
}

const EMPTY = { kind: 'repo_path', repo: '', path: '', ref: '', commit: '', url: '', title: '', summary: '' }

function AddContextForm({ ctx }) {
  const { task, busy, run } = ctx
  const [form, setForm] = useState(EMPTY)
  const repoKind = form.kind === 'repo_path'

  function update(field, value) {
    setForm((current) => ({ ...current, [field]: value }))
  }

  async function submit(event) {
    event.preventDefault()
    const payload = { kind: form.kind, title: form.title.trim(), summary: form.summary.trim() || null }
    if (repoKind) {
      Object.assign(payload, {
        repo: form.repo.trim(),
        path: form.path.trim(),
        ref: form.ref.trim() || null,
        commit: form.commit.trim().toLowerCase() || null,
      })
    } else {
      payload.url = form.url.trim()
    }
    const ok = await run(() => api.addContext(task.id, payload), { reloadAfter: true })
    if (ok) setForm({ ...EMPTY, kind: form.kind })
  }

  const ready = form.title.trim() && (repoKind ? form.repo.trim() && form.path.trim() : form.url.trim())

  return (
    <form onSubmit={submit} className="space-y-2 rounded-lg border border-hairline p-3">
      <p className="text-sm font-medium">Add a context link</p>
      <div className="flex gap-1.5" role="radiogroup" aria-label="Link kind">
        {[
          ['repo_path', 'File in a repo'],
          ['url', 'Web page'],
        ].map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={form.kind === value}
            onClick={() => update('kind', value)}
            className={`rounded-lg border px-3 py-1.5 text-sm transition ${
              form.kind === value
                ? 'border-series1 bg-series1/5 text-series1'
                : 'border-hairline text-ink-secondary hover:text-ink'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {repoKind ? (
        <>
          <div className="grid gap-2 sm:grid-cols-[14rem_1fr]">
            <input
              aria-label="Repository"
              required
              dir="ltr"
              maxLength={200}
              pattern="[\w.\-]+/[\w.\-]+"
              title="owner/name"
              placeholder="owner/name"
              value={form.repo}
              onChange={(e) => update('repo', e.target.value)}
              className={`${smallInputClass} font-mono text-xs`}
            />
            <input
              aria-label="Path in the repo"
              required
              dir="ltr"
              maxLength={400}
              placeholder="plans/cross-team/2026-11-13/feature.md"
              value={form.path}
              onChange={(e) => update('path', e.target.value)}
              className={`${smallInputClass} font-mono text-xs`}
            />
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <input
              aria-label="Branch or ref"
              dir="ltr"
              maxLength={200}
              placeholder="branch or ref (optional, default HEAD)"
              value={form.ref}
              onChange={(e) => update('ref', e.target.value)}
              className={`${smallInputClass} font-mono text-xs`}
            />
            <input
              aria-label="Commit"
              dir="ltr"
              maxLength={40}
              pattern="[0-9a-fA-F]{7,40}"
              title="7 to 40 hex characters"
              placeholder="commit hash (optional)"
              value={form.commit}
              onChange={(e) => update('commit', e.target.value)}
              className={`${smallInputClass} font-mono text-xs`}
            />
          </div>
        </>
      ) : (
        <input
          aria-label="URL"
          type="url"
          required
          dir="ltr"
          pattern="https://.*"
          maxLength={500}
          placeholder="https://… (allowed hosts only)"
          value={form.url}
          onChange={(e) => update('url', e.target.value)}
          className={`${smallInputClass} text-xs`}
        />
      )}

      <input
        aria-label="Title"
        required
        dir="auto"
        maxLength={200}
        placeholder="Title"
        value={form.title}
        onChange={(e) => update('title', e.target.value)}
        className={smallInputClass}
      />
      <textarea
        aria-label="Summary"
        rows={3}
        dir="auto"
        maxLength={2000}
        placeholder="Summary: what an agent learns there, in a few lines"
        value={form.summary}
        onChange={(e) => update('summary', e.target.value)}
        className={smallInputClass}
      />
      <div className="flex justify-end">
        <button type="submit" disabled={busy || !ready} className={primaryButton}>
          Add link
        </button>
      </div>
    </form>
  )
}

export default function ContextTab({ ctx }) {
  const { task, isWorker, isReadOnly, busy, run } = ctx
  const links = task.context ?? []
  const canWrite = isWorker && !isReadOnly

  async function remove(link) {
    if (!window.confirm(`Remove the link "${link.title}"?`)) return
    await run(() => api.removeContext(task.id, link.id), { reloadAfter: true })
  }

  return (
    <div className="space-y-4">
      {links.length === 0 ? (
        <p className="text-sm text-ink-muted">
          No context links. Point to plans, contract sections and docs in a repo so the repo stays the
          source of truth.
        </p>
      ) : (
        <ul className="divide-y divide-hairline rounded-lg border border-hairline">
          {links.map((link) => {
            const isRepo = link.kind === 'repo_path'
            const href = isRepo ? githubBlobUrl(link.repo, link.ref, link.path) : safeHttpsUrl(link.url)
            return (
              <li key={link.id} className="space-y-1 px-3 py-2.5 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span dir="auto" className="font-medium">{link.title}</span>
                  <span className="rounded-full border border-hairline px-2 py-0.5 text-[11px] text-ink-muted">
                    {isRepo ? 'Repo file' : 'Web page'}
                  </span>
                  <ActorBadge kind={link.actor_kind} />
                  <time className="text-xs text-ink-muted">{formatDateTime(link.created_at)}</time>
                  {canWrite && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => remove(link)}
                      className={`${dangerButton} ms-auto`}
                    >
                      Remove
                    </button>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {isRepo ? (
                    <code dir="ltr" className="break-all font-mono text-xs text-ink-secondary">
                      {repoLabel(link)}
                    </code>
                  ) : (
                    <code dir="ltr" className="break-all font-mono text-xs text-ink-secondary">{link.url}</code>
                  )}
                  {isRepo && link.commit && (
                    <code dir="ltr" className="font-mono text-xs text-ink-muted">commit {link.commit.slice(0, 12)}</code>
                  )}
                  {href && (
                    <a
                      href={href}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs text-series1 underline-offset-2 hover:underline"
                    >
                      {isRepo ? 'Open on GitHub' : `Open ${hostOf(href)}`}
                    </a>
                  )}
                </div>
                <PlainText className="text-sm text-ink-secondary">{link.summary}</PlainText>
              </li>
            )
          })}
        </ul>
      )}
      {canWrite && <AddContextForm ctx={ctx} />}
    </div>
  )
}
