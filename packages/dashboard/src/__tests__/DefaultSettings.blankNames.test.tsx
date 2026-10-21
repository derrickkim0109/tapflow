// A nickname of only spaces used to pass `min(1)` and be saved, leaving the person with a blank name and a
// blank avatar circle; a team name of only spaces showed blank in the sidebar. The forms refuse both now, with
// the message an empty value already gets.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { AuthUser } from '@/hooks/useAuth'

vi.mock('next-themes', () => ({ useTheme: () => ({ resolvedTheme: 'light' }) }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
const user: AuthUser = { id: 1, email: 'a@b.c', displayName: 'Duchan', avatarUrl: null, role: 'Admin' }
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user, loading: false }) }))

import { DefaultSettings } from '@/src/pages/settings/Default'

let fetchMock: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = String(input)
    if (url === '/api/v1/settings') return new Response(JSON.stringify({ team_name: 'QA Team', logo_url: null }))
    if (url === '/api/v1/apps') return new Response(JSON.stringify({ items: [] }))
    if (url === '/api/v1/profile') return new Response('{}')
    return new Response('{}', { status: 404 })
  })
})
afterEach(() => vi.restoreAllMocks())

async function save(label: string, initial: string, value: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: 0, gcTime: 0 } } })
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter><DefaultSettings /></MemoryRouter>
    </QueryClientProvider>,
  )
  const field = screen.getByLabelText(label) as HTMLInputElement
  await waitFor(() => expect(field.value).toBe(initial))
  fireEvent.change(field, { target: { value } })
  fireEvent.click(within(field.closest('form')!).getByRole('button', { name: 'Save changes' }))
}

const patches = (url: string) => (fetchMock.mock.calls as [RequestInfo | URL, RequestInit | undefined][])
  .filter(([u, init]) => String(u) === url && init?.method === 'PATCH')

describe.each([
  { label: 'Nickname', initial: 'Duchan', url: '/api/v1/profile', field: 'display_name', error: 'Display name is required' },
  { label: 'Team name', initial: 'QA Team', url: '/api/v1/settings', field: 'team_name', error: 'Team name is required' },
])('Default settings — $label', ({ label, initial, url, field, error }) => {
  it('refuses a value of only spaces and sends nothing', async () => {
    await save(label, initial, '   ')
    expect(await screen.findByText(error)).toBeInTheDocument()
    expect(patches(url)).toHaveLength(0)
  })

  it('sends the value without its surrounding spaces', async () => {
    await save(label, initial, '  Jo  ')
    await waitFor(() => expect(patches(url)).toHaveLength(1))
    expect((patches(url)[0][1]!.body as FormData).get(field)).toBe('Jo')
    // The field shows what was saved, not what was typed.
    await waitFor(() => expect((screen.getByLabelText(label) as HTMLInputElement).value).toBe('Jo'))
  })

  it('keeps an edit made while the save was in flight', async () => {
    let answer!: (r: Response) => void
    const pending = new Promise<Response>((resolve) => { answer = resolve })
    const answerGets = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => (init?.method === 'PATCH' ? pending : answerGets(input, init)))
    await save(label, initial, '  Jo  ')
    await waitFor(() => expect(patches(url)).toHaveLength(1))
    const input = screen.getByLabelText(label) as HTMLInputElement
    // The field is trimmed when the save starts, not when it answers.
    expect(input.value).toBe('Jo')
    // A space added to start a second word trims to what was sent, and must survive the answer too.
    fireEvent.change(input, { target: { value: 'Jo ' } })
    answer(new Response('{}'))
    await waitFor(() => expect(patches(url)).toHaveLength(1))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(input.value).toBe('Jo ')
  })
})
