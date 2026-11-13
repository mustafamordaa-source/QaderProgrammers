import { useRef, useState } from 'react'

// Pieces shared by the Settings page (your tokens) and the People page (bot
// tokens).

export function tokenState(token) {
  if (token.revoked_at) return 'revoked'
  const stamp = /[Zz]|[+-]\d{2}:?\d{2}$/.test(token.expires_at) ? token.expires_at : `${token.expires_at}Z`
  return new Date(stamp).getTime() <= Date.now() ? 'expired' : 'active'
}

export const TOKEN_STATE_STYLES = {
  active: 'border-good/40 text-good',
  expired: 'border-hairline text-ink-muted',
  revoked: 'border-critical/40 text-critical',
}

export function NewTokenPanel({ token, onDismiss, who = 'your agent' }) {
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
      <h2 className="text-sm font-semibold">Copy the new token now</h2>
      <p className="mt-1 text-sm text-ink-secondary">
        This is the only time TaskFlow shows it. The server keeps a hash, so nobody can show it
        again. Store it where {who} reads secrets, never in a repo, a task or a comment.
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
