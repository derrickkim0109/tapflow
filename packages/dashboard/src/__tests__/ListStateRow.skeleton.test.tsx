// The table's loading view: skeleton rows in place of a "Loading…" line, drawn only for a load slow
// enough to notice, with the words kept for a screen reader.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import { Table, TableBody } from '@/components/ui/table'
import { ListStateRow } from '@/components/ListStateRow'
import { SKELETON_DELAY_MS } from '@/hooks/useShownAfter'
import type { ListView } from '@/lib/list-view'

const bars = () => document.querySelectorAll('.animate-pulse')

function renderRow(view: ListView) {
  return render(
    <Table>
      <TableBody>
        <ListStateRow view={view} colSpan={5} noun="tokens" emptyText="No tokens yet." onRetry={() => {}} />
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
