import { POINT_LABELS, POINT_VALUES } from '../../lib/constants'

/**
 * Difficulty picker. A segmented row rather than a dropdown: the whole scale is
 * visible at once, which is what makes a relative estimate possible — you pick
 * by comparing against the other options, not by recalling what "5" means.
 */
export default function PointsPicker({ value, onChange, id = 'points' }) {
  return (
    <fieldset>
      <legend className="text-sm font-medium">Difficulty</legend>
      <div
        id={id}
        role="radiogroup"
        aria-label="Difficulty in points"
        className="mt-1.5 flex flex-wrap gap-1.5"
      >
        {POINT_VALUES.map((points) => {
          const selected = value === points
          return (
            <button
              key={points}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => onChange(points)}
              className={`flex-1 rounded-lg border px-2 py-2 text-center transition ${
                selected
                  ? 'border-series1 bg-series1/5 text-series1'
                  : 'border-hairline text-ink-secondary hover:border-ink-muted hover:text-ink'
              }`}
            >
              <span className="tabular block text-sm font-semibold leading-tight">{points}</span>
              <span className="block text-[10px] leading-tight">{POINT_LABELS[points]}</span>
            </button>
          )
        })}
      </div>
      <p className="mt-1.5 text-xs text-ink-muted">
        How much work this is, not how urgent it is — urgency is the priority field. The
        scale jumps (1, 2, 3, 5, 8, 13) so there is no arguing over a 6 versus a 7.
      </p>
    </fieldset>
  )
}
