import { useCallback, useEffect, useState } from 'react'
import Modal from '../Modal'
import { api } from '../../api/client'
import { BOT_SCOPES, TOKEN_MAX_DAYS } from '../../lib/constants'
import { formatDateTime } from '../../lib/format'
import { NewTokenPanel, TOKEN_STATE_STYLES, tokenState } from '../TokenParts'

const inputClass =
  'mt-1.5 w-full rounded-lg border border-hairline bg-surface-raised px-3 py-2 text-sm outline-none focus:border-series1'

/** Admins list, issue and revoke a bot's tokens. Bot scopes are limited to
 *  the three the server allows. */
export default function BotTokensModal({ bot, onClose }) {
  const [tokens, setTokens] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [created, setCreated] = useState(null)
  const [name, setName] = useState('')
  const [days, setDays] = useState(30)
  const [picked, setPicked] = useState(Object.keys(BOT_SCOPES))
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    try {
      setTokens(await api.botTokens(bot.id))
      setError(null)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [bot.id])

  useEffect(() => {
    load()
  }, [load])

  function toggleScope(scope) {
    setPicked((current) =>
      current.includes(scope) ? current.filter((s) => s !== scope) : [...current, scope],
    )
  }

  async function issue(event) {
    event.preventDefault()
    setError(null)
    setSaving(true)
    try {
      const result = await api.issueBotToken(bot.id, {
        name: name.trim(),
        scopes: Object.keys(BOT_SCOPES).filter((s) => picked.includes(s)),
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
    if (!window.confirm(`Revoke "${token.name}"? The bot stops working with it at once.`)) return
    setError(null)
    try {
      const updated = await api.revokeToken(token.id)
      setTokens((current) => current.map((t) => (t.id === updated.id ? updated : t)))
    } catch (err) {
      setError(err.message)
    }
  }

  return (
    <Modal title={`Tokens for ${bot.name}`} onClose={onClose} wide>
      {created && (
        <NewTokenPanel token={created} who="the bot" onDismiss={() => setCreated(null)} />
      )}

      {error && (
        <p role="alert" dir="auto" className="mb-4 rounded-lg border border-critical/40 px-3 py-2 text-sm text-critical">
          {error}
        </p>
      )}

      <form onSubmit={issue} className="rounded-xl border border-hairline p-4">
        <h3 className="text-sm font-semibold">Issue a token</h3>
        <div className="mt-3 grid gap-4 sm:grid-cols-[1fr_10rem]">
          <div>
            <label className="block text-sm font-medium" htmlFor="bot-token-name">
              Name
            </label>
            <input
              id="bot-token-name"
              required
              maxLength={80}
              dir="auto"
              placeholder="server scanner"
              value={name}
              onChange={(event) => setName(event.target.value)}
              className={inputClass}
            />
          </div>
          <div>
            <label className="block text-sm font-medium" htmlFor="bot-token-days">
              Expires in (days)
            </label>
            <input
              id="bot-token-days"
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
          <div className="mt-1.5 grid gap-2 sm:grid-cols-3">
            {Object.entries(BOT_SCOPES).map(([scope, description]) => (
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
            {saving ? 'Issuing…' : 'Issue token'}
          </button>
        </div>
      </form>

      <h3 className="mb-2 mt-5 text-sm font-semibold">Issued tokens</h3>
      {loading ? (
        <p className="text-sm text-ink-muted">Loading tokens…</p>
      ) : tokens.length === 0 ? (
        <p className="text-sm text-ink-muted">This bot has no tokens yet.</p>
      ) : (
        <ul className="divide-y divide-hairline rounded-lg border border-hairline">
          {tokens.map((token) => {
            const state = tokenState(token)
            return (
              <li key={token.id} className={`flex flex-wrap items-center gap-2 px-3 py-2.5 text-sm ${state === 'active' ? '' : 'opacity-60'}`}>
                <span dir="auto" className="font-medium">{token.name}</span>
                <code dir="ltr" className="font-mono text-xs text-ink-secondary">{token.prefix}</code>
                <span className="flex flex-wrap gap-1">
                  {token.scopes.map((scope) => (
                    <code key={scope} dir="ltr" className="rounded border border-hairline px-1.5 py-0.5 font-mono text-[11px] text-ink-secondary">
                      {scope}
                    </code>
                  ))}
                </span>
                <span className="text-xs text-ink-muted">
                  Expires {formatDateTime(token.expires_at)} · Last used{' '}
                  {token.last_used_at ? formatDateTime(token.last_used_at) : 'never'}
                </span>
                <span className={`ms-auto rounded-full border px-2 py-0.5 text-[11px] font-medium ${TOKEN_STATE_STYLES[state]}`}>
                  {state === 'revoked' ? 'Revoked' : state === 'expired' ? 'Expired' : 'Active'}
                </span>
                {state === 'active' && (
                  <button
                    type="button"
                    onClick={() => revoke(token)}
                    className="rounded-md border border-critical/40 px-2.5 py-1 text-[11px] text-critical transition hover:bg-critical/5"
                  >
                    Revoke
                  </button>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </Modal>
  )
}
