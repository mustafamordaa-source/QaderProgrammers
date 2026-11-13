import { useEffect, useState } from 'react'
import { api } from '../../api/client'
import { NOTIFY_KIND_PREF_LABELS } from '../../lib/constants'

const inputClass =
  'mt-1.5 w-full rounded-lg border border-hairline bg-surface-raised px-3 py-2 text-sm outline-none focus:border-series1'

function fromPrefs(prefs) {
  return {
    email: prefs.email_notifications,
    kinds: prefs.notify_kinds ?? [],
    address: prefs.notify_address ?? '',
  }
}

function sameForm(a, b) {
  return (
    a.email === b.email &&
    a.address.trim().toLowerCase() === b.address.trim().toLowerCase() &&
    a.kinds.length === b.kinds.length &&
    a.kinds.every((k) => b.kinds.includes(k))
  )
}

/** Your email settings: on or off, which kinds, which address, and a test email. */
export default function NotificationSettings() {
  const [prefs, setPrefs] = useState(null)
  const [form, setForm] = useState(null)
  const [error, setError] = useState(null)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState(null)

  useEffect(() => {
    let cancelled = false
    api
      .notificationPreferences()
      .then((result) => {
        if (cancelled) return
        setPrefs(result)
        setForm(fromPrefs(result))
      })
      .catch((err) => {
        if (!cancelled) setError(err.message)
      })
    return () => {
      cancelled = true
    }
  }, [])

  function update(patch) {
    setSaved(false)
    setForm((current) => ({ ...current, ...patch }))
  }

  function toggleKind(kind) {
    update({
      kinds: form.kinds.includes(kind) ? form.kinds.filter((k) => k !== kind) : [...form.kinds, kind],
    })
  }

  async function save(event) {
    event.preventDefault()
    setError(null)
    setSaving(true)
    try {
      const result = await api.updateNotificationPreferences({
        email_notifications: form.email,
        // Keep kinds this person cannot pick (lead-only) out of the request.
        notify_kinds: form.kinds.filter((k) => prefs.available_kinds.includes(k)),
        notify_address: form.address.trim(),
      })
      setPrefs(result)
      setForm(fromPrefs(result))
      setSaved(true)
    } catch (err) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  async function sendTest() {
    setTestResult(null)
    setTesting(true)
    try {
      const result = await api.sendTestEmail()
      setTestResult({ ok: true, text: `Test email sent to ${result.sent_to}. Check that inbox (and spam).` })
    } catch (err) {
      // 409: email off on the server; 429: rate limited; 502: SMTP refused.
      const fallback =
        err.status === 429
          ? 'Too many test emails. Try again shortly.'
          : err.status === 409
            ? 'Email is not set up on the server yet.'
            : 'The test email failed.'
      setTestResult({ ok: false, text: err.message || fallback })
    } finally {
      setTesting(false)
    }
  }

  const card = 'mb-6 rounded-xl border border-hairline bg-surface p-4'

  if (!form) {
    return (
      <section className={card} aria-labelledby="notify-heading">
        <h2 id="notify-heading" className="text-sm font-semibold">Notifications</h2>
        {error ? (
          <p role="alert" dir="auto" className="mt-2 text-sm text-critical">{error}</p>
        ) : (
          <p className="mt-2 text-sm text-ink-muted">Loading…</p>
        )}
      </section>
    )
  }

  const dirty = !sameForm(form, fromPrefs(prefs))
  const serverEmail = prefs.email_enabled_on_server
  const sendsTo = prefs.notify_address || prefs.login_email

  return (
    <form onSubmit={save} className={card} aria-labelledby="notify-heading">
      <h2 id="notify-heading" className="text-sm font-semibold">Notifications</h2>
      <p className="mt-0.5 text-sm text-ink-secondary">
        The bell and the Inbox show every notification. Email is extra: pick what reaches your inbox.
      </p>

      {!serverEmail && (
        <p className="mt-3 rounded-lg border border-warning/50 px-3 py-2 text-sm text-warning">
          Email is not set up on the server yet, so nothing goes out by email. You still get every
          notification in the app, and the choices you save here apply once an admin sets email up.
        </p>
      )}

      <label className="mt-4 flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          className="mt-1"
          checked={form.email}
          onChange={(event) => update({ email: event.target.checked })}
        />
        <span>
          <span className="font-medium">Email me notifications</span>
          <span className="block text-xs text-ink-muted">
            The hub batches them, so a busy hour arrives as one email.
          </span>
        </span>
      </label>

      <fieldset className="mt-4" disabled={!form.email}>
        <legend className={`text-sm font-medium ${form.email ? '' : 'text-ink-muted'}`}>Email me when</legend>
        <div className="mt-1.5 grid gap-2 sm:grid-cols-2">
          {prefs.available_kinds.map((kind) => (
            <label
              key={kind}
              className={`flex items-center gap-2 rounded-lg border border-hairline px-3 py-2 text-sm ${
                form.email ? '' : 'opacity-60'
              }`}
            >
              <input type="checkbox" checked={form.kinds.includes(kind)} onChange={() => toggleKind(kind)} />
              {NOTIFY_KIND_PREF_LABELS[kind] ?? kind}
            </label>
          ))}
        </div>
      </fieldset>

      <div className="mt-4 max-w-md">
        <label className="block text-sm font-medium" htmlFor="notify-address">
          Send to a different address
        </label>
        <input
          id="notify-address"
          type="email"
          dir="ltr"
          maxLength={254}
          placeholder={prefs.login_email ?? 'you@example.com'}
          value={form.address}
          onChange={(event) => update({ address: event.target.value })}
          className={inputClass}
        />
        <p className="mt-1 text-xs text-ink-muted">
          Leave it empty to use your login email{prefs.login_email ? ` (${prefs.login_email})` : ''}.
        </p>
      </div>

      {error && (
        <p role="alert" dir="auto" className="mt-3 text-sm text-critical">{error}</p>
      )}

      <div className="mt-4 flex flex-wrap items-center justify-end gap-3">
        {saved && !dirty && (
          <span role="status" className="text-xs text-good">Saved.</span>
        )}
        <button
          type="button"
          onClick={sendTest}
          disabled={testing || !serverEmail}
          title={serverEmail ? `Sends to ${sendsTo}` : 'Email is not set up on the server yet'}
          className="rounded-lg border border-hairline px-4 py-2 text-sm text-ink-secondary transition hover:text-ink disabled:opacity-60"
        >
          {testing ? 'Sending…' : 'Send test email'}
        </button>
        <button
          type="submit"
          disabled={saving || !dirty}
          className="rounded-lg bg-series1 px-4 py-2 text-sm font-medium text-white transition hover:opacity-90 disabled:opacity-60"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>

      {serverEmail && dirty && (
        <p className="mt-2 text-end text-xs text-ink-muted">The test email goes to the saved address. Save first.</p>
      )}
      {testResult && (
        <p
          role={testResult.ok ? 'status' : 'alert'}
          dir="auto"
          className={`mt-2 text-end text-sm ${testResult.ok ? 'text-good' : 'text-critical'}`}
        >
          {testResult.text}
        </p>
      )}
    </form>
  )
}
