import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api/client'
import { useAuth } from '../auth/AuthContext'
import { TOKEN_MAX_DAYS } from '../lib/constants'
import { formatDateTime } from '../lib/format'

const inputClass =
  'mt-1.5 w-full rounded-lg border border-hairline bg-surface-raised px-3 py-2 text-sm outline-none focus:border-series1'

function tokenState(token) {
  if (token.revoked_at) return 'revoked'
  const stamp = /[Zz]|[+-]\d{2}:?\d{2}$/.test(token.expires_at) ? token.expires_at : `${token.expires_at}Z`
  return new Date(stamp).getTime() <= Date.now() ? 'expired' : 'active'
}

const STATE_STYLES = {
  active: 'border-good/40 text-good',
  expired: 'border-hairline text-ink-muted',
  revoked: 'border-critical/40 text-critical',
}

function NewTokenPanel({ token, onDismiss }) {
  const [copied, setCopied] = useState(false)
  const fieldRef = useRef(null)

  async function copy() {
    try {
      await navigator.clipboard.writeText(token.token)
      setCopied(true)
    } catch {
      // Clipboard access can be refused; select the text so Ctrl+C works.
      fieldRef.current?.select()
    }
  }

  return (
    <div role="status" className="mb-6 rounded-xl border border-warning/60 bg-surface p-4">
      <h2 className="text-sm font-semibold">Copy your new token now</h2>
      <p className="mt-1 text-sm text-ink-secondary">
        This is the only time TaskFlow shows it. The server keeps a hash, so nobody can show it
        again. Store it where your agent reads secrets, never in a repo, a task or a comment.
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <input
          ref={fieldRef}
          readOnly
          dir="ltr"
          aria-label="New API token"
          value={token.token}
          onFocus={(event) => event.target.select()}
          className="min-w-0 flex-1 rounded-lg border border-hairline bg-surface-raised px-3 py-2 font-mono text-xs outline-none"
        />
        <button
          type="button"
          onClick={copy}
          className="rounded-lg bg-series1 px-4 py-2 text-sm font-medium text-white transition hover:opacity-90"
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
        <button
          type="button"
          onClick={onDismiss}
          className="rounded-lg border border-hairline px-4 py-2 text-sm text-ink-secondary transition hover:text-ink"
        >
          I saved it
        </button>
      </div>
    </div>
  )
}

export default function SettingsPage() {
  const { isViewer } = useAuth()
  const [tokens, setTokens] = useState([])
  const [scopes, setScopes] = useState({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [created, setCreated] = useState(null)

  const [name, setName] = useState('')
  const [picked, setPicked] = useState([])
  const [days, setDays] = useState(30)
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    try {
      const [tokenList, scopeMap] = await Promise.all([api.tokens(), api.scopes()])
      setTokens(tokenList)
      setScopes(scopeMap)
      setPicked((current) => (current.length ? current : Object.keys(scopeMap)))
      setError(null)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  function toggleScope(scope) {
    setPicked((current) =>
      current.includes(scope) ? current.filter((s) => s !== scope) : [...current, scope],
    )
  }

  async function create(event) {
    event.preventDefault()
    setError(null)
    setSaving(true)
    try {
      const result = await api.createToken({
        name: name.trim(),
        scopes: picked,
        expires_days: Math.min(TOKEN_MAX_DAYS, Math.max(1, Number(days) || 30)),
      })
      setCreated(result)
      setName('')
      await load()
    } catch (err) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  async function revoke(token) {
    if (!window.confirm(`Revoke "${token.name}"? Agents using it stop working at once.`)) return
    setError(null)
    try {
      const updated = await api.revokeToken(token.id)
      setTokens((current) => current.map((t) => (t.id === updated.id ? updated : t)))
    } catch (err) {
      setError(err.message)
    }
  }

  return (
    <>
      <div className="mb-5">
        <h1 className="text-xl font-semibold tracking-tight">Settings</h1>
        <p className="mt-0.5 text-sm text-ink-secondary">
          Personal API tokens let your AI agents work in TaskFlow as you, limited to the scopes
          you pick. An agent must name itself in the X-Agent header.
        </p>
      </div>

      {created && <NewTokenPanel token={created} onDismiss={() => setCreated(null)} />}

      {error && (
        <p role="alert" dir="auto" className="mb-4 rounded-lg border border-critical/40 px-3 py-2 text-sm text-critical">
          {error}
        </p>
      )}

      {isViewer ? (
        <p className="mb-6 rounded-lg border border-hairline px-3 py-2 text-sm text-ink-secondary">
          Viewer accounts cannot create API tokens.
        </p>
      ) : (
        <form onSubmit={create} className="mb-6 rounded-xl border border-hairline bg-surface p-4">
          <h2 className="text-sm font-semibold">New token</h2>
          <div className="mt-3 grid gap-4 sm:grid-cols-[1fr_10rem]">
            <div>
              <label className="block text-sm font-medium" htmlFor="token-name">
                Name
              </label>
              <input
                id="token-name"
                required
                maxLength={80}
                dir="auto"
                placeholder="laptop claude"
                value={name}
                onChange={(event) => setName(event.target.value)}
                className={inputClass}
              />
            </div>
            <div>
              <label className="block text-sm font-medium" htmlFor="token-days">
                Expires in (days)
              </label>
              <input
                id="token-days"
                type="number"
                min={1}
                max={TOKEN_MAX_DAYS}
                required
                value={days}
                onChange={(event) => setDays(event.target.value)}
                className={inputClass}
              />
            </div>
          </div>

          <fieldset className="mt-4">
            <legend className="text-sm font-medium">Scopes</legend>
            <div className="mt-1.5 grid gap-2 sm:grid-cols-2">
              {Object.entries(scopes).map(([scope, description]) => (
                <label key={scope} className="flex items-start gap-2 rounded-lg border border-hairline px-3 py-2 text-sm">
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={picked.includes(scope)}
                    onChange={() => toggleScope(scope)}
                  />
                  <span>
                    <code dir="ltr" className="font-mono text-xs">{scope}</code>
                    <span className="block text-xs text-ink-muted">{description}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>

          <div className="mt-4 flex items-center justify-end gap-3">
            {picked.length === 0 && <span className="text-xs text-critical">Pick at least one scope.</span>}
            <button
              type="submit"
              disabled={saving || !name.trim() || picked.length === 0}
              className="rounded-lg bg-series1 px-4 py-2 text-sm font-medium text-white transition hover:opacity-90 disabled:opacity-60"
            >
              {saving ? 'Creating…' : 'Create token'}
            </button>
          </div>
        </form>
      )}

      <h2 className="mb-2 text-sm font-semibold">Your tokens</h2>
      {loading ? (
        <p className="text-sm text-ink-muted">Loading tokens…</p>
      ) : tokens.length === 0 ? (
        <p className="text-sm text-ink-muted">No tokens yet.</p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-hairline bg-surface">
          <table className="w-full min-w-[860px] text-sm">
            <thead>
              <tr className="border-b border-hairline text-left">
                {['Name', 'Prefix', 'Scopes', 'Created', 'Expires', 'Last used', 'State', ''].map((column) => (
                  <th key={column} className="px-4 py-2.5 text-xs font-medium uppercase tracking-wide text-ink-secondary">
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {tokens.map((token) => {
                const state = tokenState(token)
                return (
                  <tr key={token.id} className={`border-b border-hairline/60 last:border-0 ${state === 'active' ? '' : 'opacity-60'}`}>
                    <td dir="auto" className="px-4 py-3 font-medium">{token.name}</td>
                    <td className="px-4 py-3">
                      <code dir="ltr" className="font-mono text-xs">{token.prefix}</code>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-1">
                        {token.scopes.map((scope) => (
                          <code key={scope} dir="ltr" className="rounded border border-hairline px-1.5 py-0.5 font-mono text-[11px] text-ink-secondary">
                            {scope}
                          </code>
                        ))}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-xs text-ink-muted">{formatDateTime(token.created_at)}</td>
                    <td className="px-4 py-3 text-xs text-ink-muted">{formatDateTime(token.expires_at)}</td>
                    <td className="px-4 py-3 text-xs text-ink-muted">
                      {token.last_used_at ? formatDateTime(token.last_used_at) : 'Never'}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${STATE_STYLES[state]}`}>
                        {state === 'revoked' ? `Revoked ${formatDateTime(token.revoked_at)}` : state === 'expired' ? 'Expired' : 'Active'}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      {state === 'active' && (
                        <button
                          type="button"
                          onClick={() => revoke(token)}
                          className="rounded-md border border-critical/40 px-2.5 py-1 text-[11px] text-critical transition hover:bg-critical/5"
                        >
                          Revoke
                        </button>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}
