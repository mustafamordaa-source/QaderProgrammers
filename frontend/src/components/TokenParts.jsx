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
      <SaveCommand />
    </div>
  )
}

const SAVE_COMMANDS = [
  ['Windows', 'Get-Clipboard | python scripts/qhub.py login --token-stdin'],
  ['macOS', 'pbpaste | python3 scripts/qhub.py login --token-stdin'],
  ['Linux', 'xclip -o -selection clipboard | python3 scripts/qhub.py login --token-stdin'],
]

function guessSystem() {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent
  if (/Windows/i.test(ua)) return 'Windows'
  if (/Mac/i.test(ua)) return 'macOS'
  return 'Linux'
}

// After copying the token: one command saves it on the computer for every
// qhub command (and qtask publish). The command holds no secret.
function SaveCommand() {
  const [system, setSystem] = useState(guessSystem)
  const [copied, setCopied] = useState(false)
  const command = SAVE_COMMANDS.find(([name]) => name === system)[1]

  async function copy() {
    try {
      await navigator.clipboard.writeText(command)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // Selecting the text is enough; Ctrl+C still works.
    }
  }

  return (
    <div className="mt-4 border-t border-hairline pt-3">
      <p className="text-sm text-ink-secondary">
        Then save it on your computer once. Copy the token first, then run this from the team repo:
      </p>
      <div className="mt-2 flex flex-wrap gap-1" role="tablist" aria-label="Your system">
        {SAVE_COMMANDS.map(([name]) => (
          <button
            key={name}
            type="button"
            role="tab"
            aria-selected={system === name}
            onClick={() => setSystem(name)}
            className={`rounded-md px-2.5 py-1 text-xs ${
              system === name ? 'bg-series1 text-white' : 'border border-hairline text-ink-secondary hover:text-ink'
            }`}
          >
            {name}
          </button>
        ))}
      </div>
      <div className="mt-2 flex flex-wrap gap-2">
        <code dir="ltr" className="min-w-0 flex-1 break-all rounded-lg border border-hairline bg-surface-raised px-3 py-2 font-mono text-xs">
          {command}
        </code>
        <button
          type="button"
          onClick={copy}
          className="rounded-lg border border-hairline px-3 py-2 text-sm text-ink-secondary transition hover:text-ink"
        >
          {copied ? 'Copied' : 'Copy command'}
        </button>
      </div>
      <p className="mt-2 text-xs text-ink-muted">
        It checks the token and saves it to ~/.qhub (only your user can read it). Every qhub command
        and your agents use it after that. More in the Guide, section 11.
      </p>
    </div>
  )
}
