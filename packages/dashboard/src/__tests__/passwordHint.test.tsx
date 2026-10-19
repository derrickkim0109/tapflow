// #823. No page stated the 8-character rule until a submit had been refused (WCAG 3.3.2 asks for it when
// the input is required, not after). Every form that sets a new password now carries a hint below the
// field as its description, and a refusal replaces it in the same place with the error, which states the
// rule itself — one line and one sentence at a time, never both. The confirm field carries none.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import type { ReactElement } from 'react'
import type { AuthUser } from '@/hooks/useAuth'
import { withQuery } from './withQuery'

vi.mock('next-themes', () => ({ useTheme: () => ({ resolvedTheme: 'light' }) }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
const auth = vi.hoisted(() => ({ user: null as AuthUser | null }))
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: auth.user, loading: false }) }))

import { Setup } from '@/src/pages/Setup'
import { Invite } from '@/src/pages/Invite'
import { ResetPassword } from '@/src/pages/ResetPassword'
import { DefaultSettings } from '@/src/pages/settings/Default'
import { PASSWORD_HINT } from '@/lib/password'

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

beforeEach(() => {
  auth.user = { id: 1, email: 'a@b.c', displayName: 'Duchan', avatarUrl: null, role: 'Viewer' }
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = String(input)
    if (url === '/api/v1/auth/status') return json({ initialized: false, canInitialize: true })
    if (url.includes('/invitations/verify')) return json({ role: 'QA' })
    if (url.includes('/reset-password/verify')) return json({ ok: true })
    return json({}, 404)
  })
})
afterEach(() => vi.restoreAllMocks())

function renderAt(entry: string, page: ReactElement) {
  const path = entry.split('?')[0]!
  return render(withQuery(
    <MemoryRouter initialEntries={[entry]}>
      <Routes><Route path={path} element={page} /></Routes>
    </MemoryRouter>,
  ))
}

const PAGES = [
  { name: 'Setup', entry: '/setup', page: <Setup />, field: /^password$/i, confirm: /confirm password/i, submit: /create admin account/i },
  { name: 'Invite', entry: '/invite?token=abc', page: <Invite />, field: /^password$/i, confirm: /confirm password/i, submit: /create account/i },
  { name: 'ResetPassword', entry: '/reset-password?token=abc', page: <ResetPassword />, field: /^new password$/i, confirm: /confirm password/i, submit: /set new password/i },
  { name: 'Default settings', entry: '/settings', page: <DefaultSettings />, field: /^new password$/i, confirm: /confirm new password/i, submit: /change password/i },
]

/** The elements an input's description names, in order. */
const describedBy = (el: HTMLElement) =>
  (el.getAttribute('aria-describedby') ?? '').split(' ').filter(Boolean).map((id) => document.getElementById(id))

describe.each(PAGES)('$name', ({ entry, page, field, confirm, submit }) => {
  it('states the rule before anything is submitted, as the field\'s description', async () => {
    renderAt(entry, page)
    const input = await screen.findByLabelText(field)
    const described = describedBy(input)
    expect(described).toHaveLength(1)
    expect(described[0]).toHaveTextContent(PASSWORD_HINT)
    // Not `toBeVisible`: jsdom loads no Tailwind, so that passes for a hint only a screen reader gets —
    // which is the WCAG 3.3.2 failure again for everyone who can see the form.
    expect(described[0]).not.toHaveClass('sr-only')
  })

  it('replaces the hint with the error on a refusal, and the error still states the rule', async () => {
    renderAt(entry, page)
    const input = await screen.findByLabelText(field)
    await userEvent.type(input, 'short')
    await userEvent.click(screen.getByRole('button', { name: submit }))

    await waitFor(() => expect(input).toHaveAttribute('aria-invalid', 'true'))
    const described = describedBy(input)
    expect(described).toHaveLength(1)
    expect(described[0]).toHaveTextContent('Password must be at least 8 characters')
    expect(screen.queryByText(PASSWORD_HINT)).toBeNull()
  })

  it('brings the hint back once the error is fixed', async () => {
    renderAt(entry, page)
    const input = await screen.findByLabelText(field)
    await userEvent.type(input, 'short')
    await userEvent.click(screen.getByRole('button', { name: submit }))
    await waitFor(() => expect(input).toHaveAttribute('aria-invalid', 'true'))

    await userEvent.type(input, '-now-long-enough')
    await waitFor(() => expect(input).toHaveAttribute('aria-invalid', 'false'))
    expect(describedBy(input)[0]).toHaveTextContent(PASSWORD_HINT)
  })

  it('gives the confirm field no hint of its own', async () => {
    renderAt(entry, page)
    const input = await screen.findByLabelText(confirm)
    expect(input).not.toHaveAttribute('aria-describedby')
    expect(screen.getAllByText(PASSWORD_HINT)).toHaveLength(1)
  })
})
