import { Skeleton } from '@/components/ui/skeleton'

const RELEASES = 3
const ROWS_IN_OPEN = 2

/**
 * Release headers in the shape `ReleaseAccordion` draws them: chevron, version, build count. The
 * first is drawn open with a couple of build rows, because `useReleaseDisclosure` opens the newest
 * release by default and a skeleton of closed headers would make the list jump when it arrives.
 * Decorative only — the caller keeps the "Loading…" text for a screen reader beside it.
 */
export function ReleaseListSkeleton() {
  return (
    <div className="flex flex-col gap-2" aria-hidden>
      {Array.from({ length: RELEASES }, (_, i) => (
        <div key={i} className="rounded-lg shadow-card-2 overflow-hidden">
          <div className="flex items-center gap-2 px-4 py-3 bg-card">
            <Skeleton className="h-4 w-4 shrink-0" />
            <Skeleton className="h-5 w-16" />
            <Skeleton className="h-3 w-14" />
          </div>
          {i === 0 && (
            <div className="border-t bg-card">
              {Array.from({ length: ROWS_IN_OPEN }, (_, r) => (
                <div key={r} className={['flex items-center gap-3 px-4 py-3', r < ROWS_IN_OPEN - 1 ? 'border-b' : ''].join(' ')}>
                  <div className="flex-1 flex flex-col gap-1.5">
                    <Skeleton className="h-5 w-32" />
                    <Skeleton className="h-4 w-48" />
                  </div>
                  <Skeleton className="h-9 w-32" />
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}
