import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { AppSidebar } from '@/components/AppSidebar'
import { SidebarProvider } from '@/components/ui/sidebar'
import { withQuery } from './withQuery'

// Flow Runs is listed once a run exists, and stays listed on a run page and when the relay cannot say.
// "Not listed" is also what a sidebar reports before its query has answered, so every absence below first
// waits for the runs request to be made and answered, and is paired with a case where the same answer lists it
// (contributing/test-and-guard-coverage.md rule 2).

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ user: { id: 1, email: 'a@test.local', displayName: null, avatarUrl: null, role: 'Admin' }, loading: false }),
}))
vi.mock('next-themes', () => ({ useTheme: () => ({ resolvedTheme: 'light' }) }))

type RunsAnswer = { items: unknown[] } | 'fail'

function stub(runs: RunsAnswer) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false, media: query, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
  }))
  let answered = false
  const fetchMock = vi.fn((url: string) => {
    if (url.startsWith('/api/v1/runs')) {
      answered = true
      if (runs === 'fail') return Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) })
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ ...runs, nextCursor: null, prevCursor: null }) })
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) })
  })
  vi.stubGlobal('fetch', fetchMock)
  return { fetchMock, answered: () => answered }
}

function renderAt(path: string) {
  render(withQuery(<MemoryRouter initialEntries={[path]}><SidebarProvider><AppSidebar /></SidebarProvider></MemoryRouter>))
}

/** Lets the query's answer reach the render before an absence is asserted. */
async function settle(answered: () => boolean) {
  await waitFor(() => expect(answered()).toBe(true))
  await new Promise((r) => setTimeout(r, 0))
  await screen.findByRole('link', { name: /app center/i })
}

describe('the sidebar lists Flow Runs once a run exists', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('is not listed while the relay has no run', async () => {
    const { fetchMock, answered } = stub({ items: [] })
    renderAt('/app-center')
    await settle(answered)
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/runs?limit=1', expect.anything())
    expect(screen.queryByRole('link', { name: /flow runs/i })).not.toBeInTheDocument()
  })

  it('is listed once one run exists', async () => {
    stub({ items: [{ id: 'r1' }] })
    renderAt('/app-center')
    expect(await screen.findByRole('link', { name: /flow runs/i })).toHaveAttribute('href', '/automation/runs')
  })

  it('is listed on a run page even with no run, so the page reached from a printed link has its place', async () => {
    const { answered } = stub({ items: [] })
    renderAt('/automation/runs/r1')
    await settle(answered)
    expect(screen.getByRole('link', { name: /flow runs/i })).toBeInTheDocument()
  })

  it('is listed when the relay cannot say, since a failure is not "no runs"', async () => {
    stub('fail')
    renderAt('/app-center')
    expect(await screen.findByRole('link', { name: /flow runs/i })).toBeInTheDocument()
  })
})
