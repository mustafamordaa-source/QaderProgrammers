import { useEffect, useRef, useState } from 'react'
import { api } from '../api/client'
import { useAuth } from '../auth/AuthContext'
import TaskDetailModal from '../components/board/TaskDetailModal'
import { PlainText } from '../components/Badges'
import { repoLabel } from '../components/board/detail/ContextTab'
import { DOC_KIND_LABELS, LIBRARY_KIND_LABELS, githubBlobUrl, safeHttpsUrl } from '../lib/constants'
import { formatDateTime } from '../lib/format'

const controlClass =
  'rounded-lg border border-hairline bg-surface-raised px-3 py-1.5 text-sm outline-none focus:border-series1'

const KIND_STYLES = {
  hub_doc: 'border-series1/40 text-series1',
  repo_path: 'border-series3/40 text-series3',
  url: 'border-series2/40 text-series2',
}

function useDebounced(value, delay = 300) {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay)
    return () => clearTimeout(timer)
  }, [value, delay])
  return debounced
}

/** Everything written down that you can see: hub documents on tasks and the
 *  repo files and pages tasks link to (GET /library). */
export default function DocumentsPage() {
  const { user } = useAuth()
  const [items, setItems] = useState([])
  const [people, setPeople] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [search, setSearch] = useState('')
  const [kind, setKind] = useState('')
  const [repoInput, setRepoInput] = useState('')
  const [repos, setRepos] = useState([])
  const [selected, setSelected] = useState(null)
  const q = useDebounced(search.trim())
  const repo = useDebounced(repoInput.trim())
  const requestId = useRef(0)

  useEffect(() => {
    const id = ++requestId.current
    setLoading(true)
    api
      .library({ q, kind, repo })
      .then((list) => {
        if (id !== requestId.current) return
        setItems(list)
        setError(null)
        // Remember every repo seen, so the filter can suggest them.
        setRepos((current) => [...new Set([...current, ...list.map((i) => i.repo).filter(Boolean)])].sort())
      })
      .catch((err) => id === requestId.current && setError(err.message))
      .finally(() => id === requestId.current && setLoading(false))
  }, [q, kind, repo])

  useEffect(() => {
    api.directory().then(setPeople).catch(() => setPeople([]))
  }, [])

  async function openTask(item) {
    setError(null)
    try {
      const task = await api.task(item.task_id)
      setSelected({ task, tab: item.kind === 'hub_doc' ? 'docs' : 'context', slug: item.slug ?? null })
    } catch (err) {
      setError(err.message)
    }
  }

  const filtered = q || kind || repo

  return (
    <>
      <div className="mb-4">
        <h1 className="text-xl font-semibold tracking-tight">Documents</h1>
        <p className="mt-0.5 text-sm text-ink-secondary">
          Hub documents on tasks, and the repo files and pages tasks point to. Read here before you
          write a new plan.
        </p>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-2" role="search">
        <input
          type="search"
          aria-label="Search titles, summaries and paths"
          placeholder="Search…"
          dir="auto"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className={`${controlClass} w-64`}
        />
        <select aria-label="Kind" value={kind} onChange={(e) => setKind(e.target.value)} className={controlClass}>
          <option value="">All kinds</option>
          {Object.entries(LIBRARY_KIND_LABELS).map(([value, label]) => (
            <option key={value} value={value}>{label}</option>
          ))}
        </select>
        <input
          aria-label="Repository"
          placeholder="owner/repo"
          dir="ltr"
          list="library-repos"
          value={repoInput}
          onChange={(e) => setRepoInput(e.target.value)}
          className={`${controlClass} w-48 font-mono text-xs`}
        />
        <datalist id="library-repos">
          {repos.map((r) => <option key={r} value={r} />)}
        </datalist>
        {filtered && (
          <button
            type="button"
            onClick={() => {
              setSearch('')
              setKind('')
              setRepoInput('')
            }}
            className="text-xs text-ink-secondary underline-offset-2 hover:text-ink hover:underline"
          >
            Clear filters
          </button>
        )}
        {repo && (
          <span className="text-xs text-ink-muted">A repo filter leaves hub documents out.</span>
        )}
      </div>

      {error && (
        <p role="alert" dir="auto" className="mb-4 rounded-lg border border-critical/40 px-3 py-2 text-sm text-critical">
          {error}
        </p>
      )}

      {loading && items.length === 0 ? (
        <p className="text-sm text-ink-muted">Loading documents…</p>
      ) : items.length === 0 ? (
        <div className="rounded-xl border border-dashed border-hairline px-6 py-12 text-center">
          <p className="text-sm font-medium">{filtered ? 'Nothing matches.' : 'Nothing written down yet.'}</p>
          <p className="mt-1 text-sm text-ink-muted">
            Documents come from a task’s Docs tab; repo files and pages from its Context tab.
          </p>
        </div>
      ) : (
        <ul className={`divide-y divide-hairline overflow-hidden rounded-xl border border-hairline bg-surface ${loading ? 'opacity-60' : ''}`}>
          {items.map((item, index) => {
            const external =
              item.kind === 'repo_path'
                ? githubBlobUrl(item.repo, item.ref, item.path)
                : item.kind === 'url'
                  ? safeHttpsUrl(item.url)
                  : null
            return (
              <li key={`${item.kind}-${item.task_id}-${item.slug ?? item.path ?? item.url ?? index}`} className="px-4 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${KIND_STYLES[item.kind] ?? 'border-hairline text-ink-secondary'}`}>
                    {LIBRARY_KIND_LABELS[item.kind] ?? item.kind}
                  </span>
                  {item.kind === 'hub_doc' ? (
                    <button
                      type="button"
                      onClick={() => openTask(item)}
                      dir="auto"
                      className="min-w-0 break-words text-start text-sm font-medium hover:text-series1"
                    >
                      {item.title}
                    </button>
                  ) : external ? (
                    <a
                      href={external}
                      target="_blank"
                      rel="noopener noreferrer"
                      dir="auto"
                      className="min-w-0 break-words text-sm font-medium hover:text-series1"
                    >
                      {item.title}
                    </a>
                  ) : (
                    <span dir="auto" className="min-w-0 break-words text-sm font-medium">{item.title}</span>
                  )}
                  {item.kind === 'hub_doc' && item.version && (
                    <span className="tabular text-xs text-ink-muted">v{item.version}</span>
                  )}
                  <time className="ms-auto text-xs text-ink-muted">{formatDateTime(item.updated_at)}</time>
                </div>
                {item.kind === 'repo_path' && (
                  <code dir="ltr" className="mt-1 block break-all font-mono text-xs text-ink-secondary">
                    {repoLabel(item)}
                  </code>
                )}
                {item.kind === 'url' && item.url && (
                  <code dir="ltr" className="mt-1 block break-all font-mono text-xs text-ink-secondary">{item.url}</code>
                )}
                {item.kind === 'hub_doc' ? (
                  item.summary && (
                    <span className="mt-1 inline-block text-xs text-ink-muted">
                      {DOC_KIND_LABELS[item.summary] ?? item.summary}
                    </span>
                  )
                ) : (
                  <PlainText className="mt-1 line-clamp-3 text-sm text-ink-secondary">{item.summary}</PlainText>
                )}
                <button
                  type="button"
                  onClick={() => openTask(item)}
                  className="mt-1 flex max-w-full items-baseline gap-1.5 text-start text-xs text-ink-muted hover:text-ink"
                >
                  <span className="tabular shrink-0">Task #{item.task_id}</span>
                  <span dir="auto" className="truncate">{item.task_title}</span>
                </button>
              </li>
            )
          })}
        </ul>
      )}

      {selected && (
        <TaskDetailModal
          key={`${selected.task.id}-${selected.tab}-${selected.slug ?? ''}`}
          task={selected.task}
          user={user}
          people={people}
          initialTab={selected.tab}
          initialDoc={selected.slug}
          onClose={() => setSelected(null)}
          onChanged={(task) => setSelected((current) => (current ? { ...current, task } : current))}
        />
      )}
    </>
  )
}
