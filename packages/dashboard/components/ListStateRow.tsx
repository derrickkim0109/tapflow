import { TableCell, TableRow } from '@/components/ui/table'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import type { ListView } from '@/lib/list-view'
import { SKELETON_DELAY_MS, useShownAfter } from '@/hooks/useShownAfter'

interface Props {
  view: ListView
  colSpan: number
  /** What the table lists, for the failure line: "Couldn't load tokens." */
  noun: string
  emptyText: string
  onRetry: () => void
}

/**
 * The single row a table shows instead of its rows. A failure is its own sentence with a way to try
 * again, not the empty text — "the relay did not answer" and "you have none" are different facts.
 *
 * No "Trying…" state: a retry puts the query back to pending, so the view becomes `loading` and this
 * row the skeleton in the same commit. Focus the retry took is put back by `useFocusAfterSwap` on
 * the table body.
 */
export function ListStateRow({ view, colSpan, noun, emptyText, onRetry }: Props) {
  const showSkeleton = useShownAfter(view === 'loading', SKELETON_DELAY_MS)
  if (view === 'list') return null
  if (view === 'loading') return <SkeletonRows colSpan={colSpan} shown={showSkeleton} />
  return (
    <TableRow className="hover:bg-transparent">
      <TableCell colSpan={colSpan} className="h-20 text-center text-muted-foreground">
        {view === 'empty' ? emptyText : `Couldn't load ${noun}.`}
        {view === 'error' && (
          <Button variant="outline" size="sm" className="ml-3" onClick={onRetry}>
            Try again
          </Button>
        )}
      </TableCell>
    </TableRow>
  )
}

const SKELETON_ROWS = 3
const BAR_WIDTHS = ['w-28', 'w-40', 'w-16', 'w-20']

/**
 * Rows shaped like the ones on their way, in place of a "Loading…" line. **The words stay, for a
 * screen reader only**: the bars say nothing to one, and this text is what it read before.
 *
 * Nothing visible for the first `SKELETON_DELAY_MS` — a relay on the LAN usually answers sooner, and
 * bars that appear and vanish within a frame read as a flicker. Until then the one row keeps the
 * height the loading line had, so an answer of "none" does not grow the table. The last column holds
 * row actions in every table using this (an icon button in Tokens, two text buttons in Team), all
 * `h-7`, so its bar is that height and a skeleton row is as tall as a real one.
 */
function SkeletonRows({ colSpan, shown }: { colSpan: number; shown: boolean }) {
  return (
    <>
      {Array.from({ length: shown ? SKELETON_ROWS : 1 }, (_, row) => (
        <TableRow key={row} className="hover:bg-transparent">
          {Array.from({ length: colSpan }, (_, col) => (
            <TableCell key={col} className={shown ? undefined : 'h-20'}>
              {row === 0 && col === 0 && <span className="sr-only">Loading…</span>}
              {shown && (
                <Skeleton
                  aria-hidden
                  className={col === colSpan - 1 ? 'h-7 w-7' : `h-4 ${BAR_WIDTHS[col % BAR_WIDTHS.length]}`}
                />
              )}
            </TableCell>
          ))}
        </TableRow>
      ))}
    </>
  )
}
