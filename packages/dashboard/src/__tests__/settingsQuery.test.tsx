// What moving the settings pages, the sidebar and the recordings list to TanStack Query changed
// (#845): failures that used to read as "none", one query shared by two screens, and a sign-out that
// leaves nothing of the last person behind.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactElement } from 'react'
import { SidebarProvider } from '@/components/ui/sidebar'
import type { ApiToken, Recording, TeamMember } from '@/lib/types'

vi.mock('next-themes', () => ({ useTheme: () => ({ resolvedTheme: 'light' }) }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ user: { id: 1, email: 'a@b.c', displayName: 'Duchan', avatarUrl: null, role: 'Admin' }, loading: false }),
}))

import { TokenSettings } from '@/src/pages/settings/Tokens'
import { TeamSettings } from '@/src/pages/settings/Team'
import { DefaultSettings } from '@/src/pages/settings/Default'
import { AppSidebar } from '@/components/AppSidebar'
import { RecordingsList } from '@/components/RecordingsList'

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>
let route: Handler = () => json({}, 404)

beforeEach(() => {
  route = () => json({}, 404)
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => route(String(input), init))
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false, media: query, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
  }))
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

function renderWith(ui: ReactElement, client = new QueryClient({ defaultOptions: { queries: { retry: 0 } } })) {
  return { client, ...render(<QueryClientProvider client={client}><MemoryRouter>{ui}</MemoryRouter></QueryClientProvider>) }
}

const token: ApiToken = { id: 3, name: 'ci', scope: 'view', last_used_at: null, expires_at: null, created_at: '2026-09-01T00:00:00Z' }
const member: TeamMember = { id: 4, email: 'qa@example.com', display_name: 'QA', role: 'QA', joined_at: '2026-09-01T00:00:00Z' }

describe('a list that could not be loaded says so', () => {
  it('Tokens shows the failure and a way to try again, not "No tokens yet."', async () => {
    route = (url) => (url === '/api/v1/tokens' ? json({ error: 'boom' }, 500) : json({}, 404))
    renderWith(<TokenSettings />)
    expect(await screen.findByText("Couldn't load tokens.")).toBeInTheDocument()
    expect(screen.queryByText('No tokens yet.')).toBeNull()
  })

  it('Tokens says it is loading, not that there are none, while the list is on its way', () => {
    route = () => new Promise(() => {})
    renderWith(<TokenSettings />)
    expect(screen.getByText('Loading…')).toBeInTheDocument()
    expect(screen.queryByText('No tokens yet.')).toBeNull()
  })

  it('a retry that works lands focus on the list it brought back, not on the page', async () => {
    let fail = true
    route = (url) => (url === '/api/v1/tokens' ? (fail ? json({ error: 'boom' }, 500) : json([token])) : json({}, 404))
    renderWith(<TokenSettings />)
    const retry = await screen.findByRole('button', { name: 'Try again' })
    fail = false
    await userEvent.click(retry)
    expect(await screen.findByText('ci')).toBeInTheDocument()
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Revoke token' })))
  })

  it('Team shows the failure instead of an empty table with "Members (0)"', async () => {
    route = (url) => (url === '/api/v1/team/members' ? json({ error: 'boom' }, 500) : json({}, 404))
    renderWith(<TeamSettings />)
    expect(await screen.findByText("Couldn't load team members.")).toBeInTheDocument()
    expect(screen.queryByText('Members (0)')).toBeNull()
  })

  it('Team still counts its members once they arrive', async () => {
    route = (url) => (url === '/api/v1/team/members' ? json([member]) : json({}, 404))
    renderWith(<TeamSettings />)
    expect(await screen.findByText('Members (1)')).toBeInTheDocument()
  })

  it('Recordings says it could not load them, rather than that there are none', async () => {
    route = () => json({ error: 'boom' }, 500)
    renderWith(<RecordingsList buildId={7} />)
    expect(await screen.findByText("Couldn't load recordings.")).toBeInTheDocument()
    expect(screen.queryByText('No recordings yet.')).toBeNull()
  })
})

describe('one query, read in two places', () => {
  it('a saved workspace name shows in the sidebar without a reload', async () => {
    let teamName = 'QA Team'
    route = (url, init) => {
      if (url === '/api/v1/settings' && init?.method === 'PATCH') {
        teamName = (init.body as FormData).get('team_name') as string
        return json({ ok: true })
      }
      if (url === '/api/v1/settings') return json({ team_name: teamName, logo_url: null })
      if (url === '/api/v1/apps') return json({ items: [] })
      return json({}, 404)
    }
    renderWith(<SidebarProvider><AppSidebar /><DefaultSettings /></SidebarProvider>)
    const field = await screen.findByDisplayValue('QA Team')
    await userEvent.clear(field)
    await userEvent.type(field, 'Release Crew')
    await userEvent.click(screen.getAllByRole('button', { name: /^save/i })[0]!)
    await waitFor(() => expect(screen.getAllByText('Release Crew').length).toBeGreaterThan(0))
    // The sidebar's own label, not only the input just typed into.
    expect(screen.getAllByText('Release Crew').some((el) => el.tagName === 'SPAN')).toBe(true)
  })

  it('a refetch of the workspace does not overwrite a name being typed', async () => {
    // Someone else renamed it meanwhile, so the refetch really does bring a different value.
    let teamName = 'QA Team'
    route = (url) => (url === '/api/v1/settings' ? json({ team_name: teamName, logo_url: null }) : url === '/api/v1/apps' ? json({ items: [] }) : json({}, 404))
    const { client } = renderWith(<DefaultSettings />)
    const field = await screen.findByDisplayValue('QA Team')
    await userEvent.clear(field)
    await userEvent.type(field, 'Half typ')
    teamName = 'Renamed Elsewhere'
    await act(async () => { await client.invalidateQueries({ queryKey: ['settings'] }) })
    // react-hook-form applies new `values` a beat later; checking before that would pass either way.
    await act(async () => { await new Promise((r) => setTimeout(r, 50)) })
    expect((field as HTMLInputElement).value).toBe('Half typ')
  })

  it('keeps the recordings on screen when a refresh of them fails', async () => {
    let fail = false
    const row: Recording = { id: 1, url: '/r/1.mp4', sessionId: null, fileSize: 1024 * 1024, mime: 'video/mp4', createdAt: '2026-09-24T01:00:00Z', expiresAt: new Date(Date.now() + 86_400_000).toISOString() }
    route = () => (fail ? json({ error: 'boom' }, 500) : json([row]))
    const { client } = renderWith(<RecordingsList buildId={7} />)
    expect(await screen.findByText(/1\.0 MB/)).toBeInTheDocument()
    fail = true
    await act(async () => { await client.refetchQueries({ queryKey: ['recordings'] }) })
    // Past the failure's delivery to React, so "still there" is not "not yet replaced".
    await act(async () => { await new Promise((r) => setTimeout(r, 20)) })
    expect(screen.getByText(/1\.0 MB/)).toBeInTheDocument()
    expect(screen.queryByText("Couldn't load recordings.")).toBeNull()
  })

  it('a finished upload refreshes the recordings list', async () => {
    let rows: Recording[] = []
    route = () => json(rows)
    const { client } = renderWith(<RecordingsList buildId={7} />)
    expect(await screen.findByText('No recordings yet.')).toBeInTheDocument()
    rows = [{ id: 1, url: '/r/1.mp4', sessionId: null, fileSize: 1024 * 1024, mime: 'video/mp4', createdAt: '2026-09-24T01:00:00Z', expiresAt: new Date(Date.now() + 86_400_000).toISOString() }]
    // What QASession does when an upload lands.
    await act(async () => { await client.invalidateQueries({ queryKey: ['recordings'] }) })
    expect(await screen.findByText(/1\.0 MB/)).toBeInTheDocument()
  })
})

describe('signing out', () => {
  it('leaves nothing cached for whoever signs in next', async () => {
    route = (url) => (url === '/api/v1/settings' ? json({ team_name: 'QA Team', logo_url: null }) : url === '/api/v1/auth/logout' ? json({ ok: true }) : json({}, 404))
    // Routed as in the app: signing out leaves the layout, so nothing re-reads what was cleared.
    const client = new QueryClient({ defaultOptions: { queries: { retry: 0 } } })
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/app-center']}>
          <Routes>
            <Route path="/app-center" element={<SidebarProvider><AppSidebar /></SidebarProvider>} />
            <Route path="/login" element={<p>login</p>} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    )
    await screen.findByText('QA Team')
    expect(client.getQueryCache().getAll().length).toBeGreaterThan(0)
    await userEvent.click(screen.getByRole('button', { name: /Duchan/ }))
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Log out' }))
    await waitFor(() => expect(client.getQueryCache().getAll()).toHaveLength(0))
  })
})
