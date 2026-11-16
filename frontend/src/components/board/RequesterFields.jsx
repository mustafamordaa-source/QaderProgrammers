import { REQUESTERS, REQUESTER_LABELS } from '../../lib/constants'

/**
 * Who asked for the task, for leads: a select plus an optional name and date.
 * `value` is { requested_by, requested_by_name, requested_at } as form strings
 * ("" when empty); `onChange(field, value)` sets one of them.
 */
export default function RequesterFields({ idPrefix, value, onChange, inputClass, className = '' }) {
  return (
    <div className={`grid gap-4 sm:grid-cols-3 ${className}`}>
      <div>
        <label className="block text-sm font-medium" htmlFor={`${idPrefix}-requested-by`}>
          Requested by
        </label>
        <select
          id={`${idPrefix}-requested-by`}
          value={value.requested_by}
          onChange={(event) => onChange('requested_by', event.target.value)}
          className={inputClass}
        >
          <option value="">Not set</option>
          {REQUESTERS.map((requester) => (
            <option key={requester} value={requester}>
              {REQUESTER_LABELS[requester]}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label className="block text-sm font-medium" htmlFor={`${idPrefix}-requested-name`}>
          Name <span className="font-normal text-ink-muted">(optional)</span>
        </label>
        <input
          id={`${idPrefix}-requested-name`}
          maxLength={80}
          dir="auto"
          placeholder="Who asked"
          value={value.requested_by_name}
          onChange={(event) => onChange('requested_by_name', event.target.value)}
          className={inputClass}
        />
      </div>
      <div>
        <label className="block text-sm font-medium" htmlFor={`${idPrefix}-requested-at`}>
          Asked on <span className="font-normal text-ink-muted">(optional)</span>
        </label>
        <input
          id={`${idPrefix}-requested-at`}
          type="date"
          value={value.requested_at}
          onChange={(event) => onChange('requested_at', event.target.value)}
          className={inputClass}
        />
      </div>
    </div>
  )
}
