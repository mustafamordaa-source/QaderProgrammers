import { useState } from 'react'

/**
 * Frame for every chart: title, optional subtitle, and a table view of the same
 * numbers. The table is the accessibility fallback — identity and value are
 * always readable without relying on colour.
 */
export default function ChartCard({ title, subtitle, table, children, className = '' }) {
  const [showTable, setShowTable] = useState(false)

  return (
    <figure className={`rounded-xl border border-hairline bg-surface p-4 ${className}`}>
      <figcaption className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">{title}</h3>
          {subtitle && <p className="mt-0.5 text-xs text-ink-muted">{subtitle}</p>}
        </div>
        {table && (
          <button
            type="button"
            onClick={() => setShowTable((current) => !current)}
            aria-expanded={showTable}
            className="shrink-0 rounded-md border border-hairline px-2 py-1 text-[11px] text-ink-secondary transition hover:text-ink"
          >
            {showTable ? 'Chart' : 'Table'}
          </button>
        )}
      </figcaption>

      {showTable && table ? (
        <div className="max-h-64 overflow-y-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-hairline text-left">
                {table.columns.map((column) => (
                  <th key={column} className="py-1.5 pr-3 text-xs font-medium text-ink-secondary">
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {table.rows.map((row, index) => (
                <tr key={index} className="border-b border-hairline/60 last:border-0">
                  {row.map((cell, cellIndex) => (
                    <td
                      key={cellIndex}
                      className={`py-1.5 pr-3 ${cellIndex > 0 ? 'tabular' : ''}`}
                    >
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
              {table.rows.length === 0 && (
                <tr>
                  <td colSpan={table.columns.length} className="py-3 text-sm text-ink-muted">
                    No data in this range.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      ) : (
        children
      )}
    </figure>
  )
}
