import { useCallback, useEffect, useState } from 'react'
import { api } from '../../api/client'

function Stat({ label, children, tone = '' }) {
  return (
    <div className="rounded-lg border border-hairline px-3 py-2">
      <dt className="text-xs text-ink-muted">{label}</dt>
      <dd className={`tabular mt-0.5 text-sm font-medium ${tone}`}>{children}</dd>
    </div>
  )
}

/** Admins: is email on, is the sender thread alive, and how the queue looks. */
export default function EmailSenderStatus() {
  const [status, setStatus] = useState(null)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setStatus(await api.emailSenderStatus())
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

  return (
    <section aria-labelledby="sender-heading" className="mb-6 rounded-xl border border-hairline bg-surface p-4">
      <div className="flex items-center justify-between gap-3">
        <h2 id="sender-heading" className="text-sm font-semibold">
          Email sender <span className="font-normal text-ink-muted">(admins)</span>
        </h2>
        <button
          type="button"
          onClick={load}
          disabled={loading}
          className="text-xs text-ink-secondary underline-offset-2 hover:text-ink hover:underline disabled:opacity-60"
        >
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      {error && <p role="alert" dir="auto" className="mt-2 text-sm text-critical">{error}</p>}

      {status && (
        <>
          <dl className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
            <Stat label="Email" tone={status.email_enabled ? 'text-good' : 'text-warning'}>
              {status.email_enabled ? 'On' : 'Not set up'}
            </Stat>
            <Stat label="Sender" tone={status.sender_running ? 'text-good' : status.email_enabled ? 'text-critical' : ''}>
              {status.sender_running ? 'Running' : 'Stopped'}
            </Stat>
            <Stat label="Pending">{status.pending}</Stat>
            <Stat label="Failed" tone={status.failed > 0 ? 'text-critical' : ''}>{status.failed}</Stat>
            <Stat label="Sent in 24 h">
              {status.sent_last_24h} <span className="font-normal text-ink-muted">of {status.daily_cap}</span>
            </Stat>
            <Stat label="SMTP host">
              <span dir="ltr" className="break-all font-mono text-xs">{status.smtp_host ?? '—'}</span>
            </Stat>
          </dl>
          <p className="mt-2 text-xs text-ink-muted">
            From: <span dir="ltr" className="font-mono">{status.from ?? '—'}</span>
          </p>
          {status.last_error && (
            <p className="mt-2 rounded-lg border border-critical/40 px-3 py-2 text-xs text-critical">
              Last error: <span dir="auto" className="break-words">{status.last_error}</span>
            </p>
          )}
        </>
      )}
    </section>
  )
}
