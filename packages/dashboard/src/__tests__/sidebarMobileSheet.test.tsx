import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom'
import { AppSidebar } from '@/components/AppSidebar'
import { SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar'
import { withQuery } from './withQuery'

// Below 768px the sidebar is a modal sheet. Following a link in it changes the page behind the sheet, so the
// sheet has to close itself, or the page just opened stays covered. Each closing case is paired with the same
// sheet staying open until the click (contributing/test-and-guard-coverage.md rule 2).

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ user: { id: 1, email: 'a@test.local', displayName: 'Ann', avatarUrl: null, role: 'Admin' }, loading: false }),
}))
vi.mock('next-themes', () => ({ useTheme: () => ({ resolvedTheme: 'light' }) }))

function stubPhone() {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: true, media: query, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
  }))
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({}) })))
}

// Stands in for the phone's back gesture: a path change that no link in the sheet made.
function BackButton() {
  const navigate = useNavigate()
  return <button type="button" onClick={() => navigate('/mac-resources')}>Elsewhere</button>
}

async function openSheet() {
  stubPhone()
  const user = userEvent.setup()
  render(withQuery(
    <MemoryRouter initialEntries={['/app-center']}>
      <SidebarProvider>
        <AppSidebar />
        <SidebarTrigger />
        <Routes><Route path="*" element={<BackButton />} /></Routes>
      </SidebarProvider>
    </MemoryRouter>,
  ))
  await user.click(screen.getByRole('button', { name: /toggle sidebar/i }))
  expect(await screen.findByRole('dialog', { hidden: true })).toBeInTheDocument()
  return user
}

describe('the mobile sidebar sheet', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('stays open until something in it is chosen', async () => {
    await openSheet()
    await new Promise((r) => setTimeout(r, 0))
    expect(screen.getByRole('dialog', { hidden: true })).toBeInTheDocument()
  })

  it.each(['Mac Resources', 'Team', 'Docs'])('closes when the %s row is followed', async (name) => {
    const user = await openSheet()
    await user.click(screen.getByRole('link', { name }))
    await waitFor(() => expect(screen.queryByRole('dialog', { hidden: true })).not.toBeInTheDocument())
  })

  it('stays open while the account menu opens, and closes when its Settings item is chosen', async () => {
    const user = await openSheet()
    await user.click(screen.getByRole('button', { name: /ann/i }))
    const item = await screen.findByRole('menuitem', { name: 'Settings' })
    expect(screen.getByRole('dialog', { hidden: true })).toBeInTheDocument()
    await user.click(item)
    await waitFor(() => expect(screen.queryByRole('dialog', { hidden: true })).not.toBeInTheDocument())
  })

  it('closes when the path changes without a link in it, as the back gesture does', async () => {
    await openSheet()
    // The button sits behind the modal sheet, so it is pressed the way history would be: not by a pointer.
    screen.getByRole('button', { name: 'Elsewhere', hidden: true }).click()
    await waitFor(() => expect(screen.queryByRole('dialog', { hidden: true })).not.toBeInTheDocument())
  })

  it('closes when the team logo is followed', async () => {
    const user = await openSheet()
    await user.click(screen.getByRole('link', { name: /tapflow/i }))
    await waitFor(() => expect(screen.queryByRole('dialog', { hidden: true })).not.toBeInTheDocument())
  })
})
