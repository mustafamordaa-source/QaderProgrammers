// Grey placeholder columns while the first load runs, so the board keeps its
// shape instead of flashing blank.
const CARDS_PER_COLUMN = [3, 2, 4, 2, 1, 3]

export default function BoardSkeleton({ columns = 6 }) {
  return (
    <div className="h-full overflow-hidden" aria-busy="true" aria-label="Loading board">
      <span className="sr-only" role="status">
        Loading board…
      </span>
      <div className="flex h-full gap-3 p-1">
        {Array.from({ length: columns }, (_, index) => (
          <div
            key={index}
            aria-hidden="true"
            className="flex h-full w-full shrink-0 flex-col gap-2 rounded-xl border border-hairline bg-surface-raised/50 p-2.5 md:w-[300px]"
          >
            <div className="mb-1 flex items-center gap-2 px-1">
              <div className="h-3 w-20 animate-pulse rounded bg-grid" />
              <div className="h-3 w-6 animate-pulse rounded-full bg-grid" />
            </div>
            {Array.from({ length: CARDS_PER_COLUMN[index % CARDS_PER_COLUMN.length] }, (_, card) => (
              <div key={card} className="rounded-lg border border-hairline bg-surface p-3">
                <div className="h-3.5 w-4/5 animate-pulse rounded bg-grid" />
                <div className="mt-2 h-3.5 w-1/2 animate-pulse rounded bg-grid" />
                <div className="mt-3 flex gap-1.5">
                  <div className="h-4 w-10 animate-pulse rounded-full bg-grid" />
                  <div className="h-4 w-14 animate-pulse rounded-full bg-grid" />
                  <div className="h-4 w-8 animate-pulse rounded-full bg-grid" />
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}
