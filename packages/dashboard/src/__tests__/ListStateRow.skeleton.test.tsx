// The table's loading view: skeleton rows in place of a "Loading…" line, drawn only for a load slow
// enough to notice, with the words kept for a screen reader.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import { Table, TableBody } from '@/components/ui/table'
import { ListStateRow } from '@/components/ListStateRow'
import { SKELETON_DELAY_MS } from '@/hooks/useShownAfter'
import type { ListView } from '@/lib/list-view'

const bars = () => document.querySelectorAll('.animate-pulse')

function renderRow(view: ListView, rowHeight?: number) {
  return render(
    <Table>
      <TableBody>
        <ListStateRow view={view} colSpan={5} noun="tokens" emptyText="No tokens yet." onRetry={() => {}} rowHeight={rowHeight} />
      </TableBody>
    </Table>,
  )
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('ListStateRow loading view', () => {
  it('draws nothing for a load that answers within the delay, but still says it is loading', () => {
    renderRow('loading')
    act(() => { vi.advanceTimersByTime(SKELETON_DELAY_MS - 1) })
    expect(bars()).toHaveLength(0)
    expect(screen.getByText('Loading…')).toHaveClass('sr-only')
  })

  it('draws skeleton rows across every column once the delay has passed', () => {
    renderRow('loading')
    act(() => { vi.advanceTimersByTime(SKELETON_DELAY_MS) })
    expect(screen.getAllByRole('row')).toHaveLength(3)
    expect(bars()).toHaveLength(3 * 5)
    expect(screen.getByText('Loading…')).toBeInTheDocument()
  })

  // jsdom lays nothing out, so these hold what decides the height: the box each bar sits in is the row's height less
  // the cell's 32px of padding, and no bar is taller than that. Measured in Chromium with the dashboard's CSS, a box
  // of 28px gives a 61px row, as a Tokens row is, and 22px gives 55px against a run's 54.5px.
  const boxHeights = () => [...bars()].map((b) => (b.parentElement as HTMLElement).style.height)

  it('makes each skeleton row as tall as a row of 28px controls by default', () => {
    renderRow('loading')
    act(() => { vi.advanceTimersByTime(SKELETON_DELAY_MS) })
    expect(new Set(boxHeights())).toEqual(new Set(['28px']))
    for (const b of bars()) expect(b).toHaveClass('h-4')
  })

  it('takes the height a table gives it, with no bar taller than that', () => {
    renderRow('loading', 54)
    act(() => { vi.advanceTimersByTime(SKELETON_DELAY_MS) })
    expect(new Set(boxHeights())).toEqual(new Set(['22px']))
    for (const b of bars()) expect(b).not.toHaveClass('h-7')
  })

  it('drops the skeleton when the answer arrives', () => {
    const { rerender } = renderRow('loading')
    act(() => { vi.advanceTimersByTime(SKELETON_DELAY_MS) })
    rerender(
      <Table>
        <TableBody>
          <ListStateRow view="empty" colSpan={5} noun="tokens" emptyText="No tokens yet." onRetry={() => {}} />
        </TableBody>
      </Table>,
    )
    expect(bars()).toHaveLength(0)
    expect(screen.queryByText('Loading…')).toBeNull()
    expect(screen.getByText('No tokens yet.')).toBeInTheDocument()
  })
})
