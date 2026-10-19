// What the sidebar and the recordings list show from the relay, pinned before they move from effects
// to TanStack Query (#845). Each case holds on both sides of the move.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { withQuery } from './withQuery'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { SidebarProvider } from '@/components/ui/sidebar'
import type { Recording } from '@/lib/types'

vi.mock('next-themes', () => ({ useTheme: () => ({ resolvedTheme: 'light' }) }))
vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ user: { id: 1, email: 'a@b.c', displayName: null, avatarUrl: null, role: 'Admin' }, loading: false }),
}))

import { AppSidebar } from '@/components/AppSidebar'
import { RecordingsList } from '@/components/RecordingsList'

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
let fetchMock: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  fetchMock = vi.spyOn(globalThis, 'fetch')
  // The sidebar asks whether it is on a phone; jsdom has no matchMedia.
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false, media: query, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
  }))
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers() })

function renderSidebar() {
  return render(withQuery(
    <MemoryRouter><SidebarProvider><AppSidebar /></SidebarProvider></MemoryRouter>,
  ))
}

describe('AppSidebar', () => {
  it('shows the workspace name and logo the relay has', async () => {
    fetchMock.mockResolvedValue(json({ team_name: 'QA Team', logo_url: '/logos/team.png' }))
    renderSidebar()
    expect(await screen.findByText('QA Team')).toBeInTheDocument()
    expect(screen.getByAltText('tapflow').getAttribute('src')).toBe('/logos/team.png')
  })

  it('falls back to tapflow and its own logo when the settings cannot be read', async () => {
    fetchMock.mockResolvedValue(json({ error: 'nope' }, 500))
    renderSidebar()
    await act(async () => { await new Promise((r) => setTimeout(r, 20)) })
    expect(screen.getByText('tapflow')).toBeInTheDocument()
    expect(screen.getByAltText('tapflow').getAttribute('src')).toBe('/logo.svg')
  })
})

const recording = (id: number): Recording => ({
  id, url: `/r/${id}.mp4`, sessionId: null, fileSize: 2 * 1024 * 1024, mime: 'video/mp4',
  createdAt: '2026-09-24T01:00:00Z', expiresAt: new Date(Date.now() + 3 * 86_400_000).toISOString(),
})

describe('RecordingsList', () => {
  it('lists the build\'s recordings', async () => {
    fetchMock.mockResolvedValue(json([recording(1), recording(2)]))
    render(withQuery(<RecordingsList buildId={7} />))
    expect(await screen.findAllByText(/2\.0 MB/)).toHaveLength(2)
    expect(String(fetchMock.mock.calls[0]![0])).toBe('/api/v1/recordings?buildId=7')
  })

  it('says there are none when the build has none', async () => {
    fetchMock.mockResolvedValue(json([]))
    render(withQuery(<RecordingsList buildId={7} />))
    expect(await screen.findByText('No recordings yet.')).toBeInTheDocument()
  })

  it('says it is loading only once the load has been slow for a moment', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false })
    fetchMock.mockReturnValue(new Promise(() => {}))
    render(withQuery(<RecordingsList buildId={7} />))
    await act(async () => { await vi.advanceTimersByTimeAsync(200) })
    expect(screen.queryByText('Loading recordings…')).toBeNull()
    await act(async () => { await vi.advanceTimersByTimeAsync(100) })
    expect(screen.getByText('Loading recordings…')).toBeInTheDocument()
  })

  it('waits the moment again for the next build, not only the first', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false })
    fetchMock.mockReturnValue(new Promise(() => {}))
    const client = new QueryClient({ defaultOptions: { queries: { retry: 0, gcTime: 0 } } })
    const view = render(<QueryClientProvider client={client}><RecordingsList buildId={7} /></QueryClientProvider>)
    await act(async () => { await vi.advanceTimersByTimeAsync(300) })
    expect(screen.getByText('Loading recordings…')).toBeInTheDocument()
    view.rerender(<QueryClientProvider client={client}><RecordingsList buildId={8} /></QueryClientProvider>)
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(screen.queryByText('Loading recordings…')).toBeNull()
    await act(async () => { await vi.advanceTimersByTimeAsync(300) })
    expect(screen.getByText('Loading recordings…')).toBeInTheDocument()
  })
})
