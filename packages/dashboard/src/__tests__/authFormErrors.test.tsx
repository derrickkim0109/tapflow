// #822. A refused sign-in, reset or password change has one way to say so — `setError('root', …)` into a
// `role="alert"` region — and no toast behind it. Deleting that line from Login, ResetPassword or Default
// left the whole suite green: the button flipped back from "Signing in…" to "Sign in" and said nothing.
// Invite is not here: `authPages.test.tsx` holds its refusals and its network failure, by role as well.
//
// Asserted **by role**, because what matters is that the message was announced, not that it was
// rendered: a region that lost its role would still show the text and tell a screen reader nothing.
// Inside `waitFor`, not `findByRole`: the region is mounted empty on purpose (`FieldError`), so a find
// resolves at once on the empty alert and the text is then checked exactly once.
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

import { Login } from '@/src/pages/Login'
import { ResetPassword } from '@/src/pages/ResetPassword'
import { DefaultSettings } from '@/src/pages/settings/Default'

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

/** Answers the page's own loads, and `submit` for the one request the form sends. */
function relay(submitPath: string, submit: () => Promise<Response>) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = String(input)
    if (url === submitPath) return submit()
    if (url === '/api/v1/auth/status') return json({ initialized: true })
    if (url.startsWith('/api/v1/auth/reset-password/verify')) return json({ ok: true })
    return json({}, 404)
  })
}

function renderAt(entry: string, page: ReactElement) {
  const path = entry.split('?')[0]!
  return render(withQuery(
    <MemoryRouter initialEntries={[entry]}>
      <Routes><Route path={path} element={page} /></Routes>
    </MemoryRouter>,
  ))
}

beforeEach(() => { auth.user = null })
afterEach(() => vi.restoreAllMocks())

describe('Login', () => {
  async function signIn() {
    renderAt('/login', <Login />)
    await userEvent.type(await screen.findByLabelText('Email'), 'someone@example.com')
    await userEvent.type(screen.getByLabelText('Password'), 'password123')
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }))
  }

  it('announces a refused sign-in', async () => {
    relay('/api/v1/auth/login', async () => json({ error: 'Invalid credentials' }, 401))
    await signIn()
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Invalid email or password'))
  })

  it('announces a sign-in that could not reach the relay', async () => {
    relay('/api/v1/auth/login', () => Promise.reject(new TypeError('network down')))
    await signIn()
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Network error. Please try again.'))
  })
})

describe('ResetPassword', () => {
  async function reset() {
    renderAt('/reset-password?token=abc', <ResetPassword />)
    await userEvent.type(await screen.findByLabelText('New password'), 'password123')
    await userEvent.type(screen.getByLabelText('Confirm password'), 'password123')
    await userEvent.click(screen.getByRole('button', { name: 'Set new password' }))
  }

  it('announces the reason the relay refused the reset', async () => {
    relay('/api/v1/auth/reset-password', async () => json({ error: 'Reset link already used' }, 410))
    await reset()
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Reset link already used'))
  })

  it('announces a reset that could not reach the relay', async () => {
    relay('/api/v1/auth/reset-password', () => Promise.reject(new TypeError('network down')))
    await reset()
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Network error. Please try again.'))
  })
})

describe('Default settings — password', () => {
  async function change() {
    auth.user = { id: 1, email: 'a@b.c', displayName: 'Duchan', avatarUrl: null, role: 'Viewer' }
    renderAt('/settings', <DefaultSettings />)
    await userEvent.type(screen.getByLabelText('Current password'), 'old-password')
    await userEvent.type(screen.getByLabelText('New password'), 'password123')
    await userEvent.type(screen.getByLabelText('Confirm new password'), 'password123')
    await userEvent.click(screen.getByRole('button', { name: 'Change password' }))
  }

  it('announces the reason the relay refused the change', async () => {
    relay('/api/v1/auth/change-password', async () => json({ error: 'Current password is incorrect' }, 401))
    await change()
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Current password is incorrect'))
  })

  it('announces a change that could not reach the relay', async () => {
    relay('/api/v1/auth/change-password', () => Promise.reject(new TypeError('network down')))
    await change()
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Network error'))
  })
})
