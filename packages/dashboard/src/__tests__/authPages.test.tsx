// What the four auth pages do with the relay's answers, pinned before they move from an effect to
// TanStack Query (#845). Every case here must hold on both sides of that move, so the harness wraps
// each page in a QueryClientProvider even while nothing reads from it.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Navigate, Route, Routes } from 'react-router-dom'
import { QueryClient, QueryClientProvider, focusManager } from '@tanstack/react-query'
import type { ReactElement } from 'react'

vi.mock('next-themes', () => ({ useTheme: () => ({ resolvedTheme: 'light' }) }))

import { Login } from '@/src/pages/Login'
import { Setup } from '@/src/pages/Setup'
import { Invite } from '@/src/pages/Invite'
import { ResetPassword } from '@/src/pages/ResetPassword'
import { useAuth } from '@/hooks/useAuth'

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
/** Past the answer's handling, so "did not redirect" means never, not "not yet". */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20))

function renderAt(entry: string, path: string, page: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: 0, gcTime: 0 } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path={path} element={page} />
          <Route path="/setup" element={path === '/setup' ? page : <div>setup page</div>} />
          <Route path="/login" element={path === '/login' ? page : <div>login page</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

let fetchMock: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  fetchMock = vi.spyOn(globalThis, 'fetch')
})
afterEach(() => vi.restoreAllMocks())

describe('Login', () => {
  it('sends a relay nobody has set up to /setup', async () => {
    fetchMock.mockResolvedValue(json({ initialized: false }))
    renderAt('/login', '/login', <Login />)
    expect(await screen.findByText('setup page')).toBeInTheDocument()
  })

  it('stays on the form for an initialised relay', async () => {
    fetchMock.mockResolvedValue(json({ initialized: true }))
    renderAt('/login', '/login', <Login />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/v1/auth/status'))
    await settle()
    expect(screen.getByText('Welcome back')).toBeInTheDocument()
    expect(screen.queryByText('setup page')).toBeNull()
  })

  it('stays on the form when the status check fails', async () => {
    fetchMock.mockRejectedValue(new TypeError('network down'))
    renderAt('/login', '/login', <Login />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    await settle()
    expect(screen.getByLabelText('Email')).toBeInTheDocument()
    expect(screen.queryByText('setup page')).toBeNull()
  })
})

describe('Setup', () => {
  it('sends an initialised relay to /login', async () => {
    fetchMock.mockResolvedValue(json({ initialized: true }))
    renderAt('/setup', '/setup', <Setup />)
    expect(await screen.findByText('login page')).toBeInTheDocument()
  })

  it('stays on the form when the status check fails', async () => {
    fetchMock.mockRejectedValue(new TypeError('network down'))
    renderAt('/setup', '/setup', <Setup />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    await settle()
    expect(screen.getByLabelText(/admin email/i)).toBeInTheDocument()
    expect(screen.queryByText('login page')).toBeNull()
  })

  // #850: a browser the relay will not let initialize used to fill in the whole form and learn that
  // only from the 403 on submit.
  it('shows how to set up on the relay host instead of a form this browser cannot submit', async () => {
    fetchMock.mockResolvedValue(json({ initialized: false, canInitialize: false }))
    renderAt('/setup', '/setup', <Setup />)
    const command = await screen.findByRole('textbox', { name: /only be created on the machine running the relay/i })
    expect(command).toHaveValue('tapflow admin init')
    expect(screen.queryByLabelText(/admin email/i)).toBeNull()
    expect(screen.queryByRole('button', { name: /create admin account/i })).toBeNull()
  })

  it('keeps the form for a relay that does not report canInitialize', async () => {
    // Absent is not a no: only an explicit false hides the form, and auth/init still refuses on its own.
    fetchMock.mockResolvedValue(json({ initialized: false }))
    renderAt('/setup', '/setup', <Setup />)
    expect(await screen.findByLabelText(/admin email/i)).toBeInTheDocument()
    expect(screen.queryByDisplayValue('tapflow admin init')).toBeNull()
  })

  it('shows no form before the relay answers', async () => {
    // Shown first, the form would take typing from a browser that is about to be told it cannot use it.
    fetchMock.mockReturnValue(new Promise<Response>(() => {}))
    renderAt('/setup', '/setup', <Setup />)
    await settle()
    expect(screen.queryByLabelText(/admin email/i)).toBeNull()
  })

  it('keeps the form for a browser that may initialize', async () => {
    fetchMock.mockResolvedValue(json({ initialized: false, canInitialize: true }))
    renderAt('/setup', '/setup', <Setup />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    await settle()
    expect(screen.getByLabelText(/admin email/i)).toBeInTheDocument()
    expect(screen.queryByText(/tapflow admin init/)).toBeNull()
    expect(screen.queryByDisplayValue('tapflow admin init')).toBeNull()
  })
})

describe('Invite', () => {
  it('says the link is invalid when it carries no token, without asking the relay', async () => {
    renderAt('/invite', '/invite', <Invite />)
    expect(await screen.findByText('Invitation expired')).toBeInTheDocument()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('shows the form, with the role, for a token the relay accepts', async () => {
    fetchMock.mockResolvedValue(json({ role: 'member' }))
    renderAt('/invite?token=abc', '/invite', <Invite />)
    expect(await screen.findByText('Set up your account')).toBeInTheDocument()
    expect(screen.getByText('member')).toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/invitations/verify?token=abc')
  })

  it('says the link is invalid when the relay refuses the token', async () => {
    fetchMock.mockResolvedValue(json({ error: 'expired' }, 410))
    renderAt('/invite?token=abc', '/invite', <Invite />)
    expect(await screen.findByText('Invitation expired')).toBeInTheDocument()
  })

  it('says the link is invalid when the check cannot reach the relay', async () => {
    fetchMock.mockRejectedValue(new TypeError('network down'))
    renderAt('/invite?token=abc', '/invite', <Invite />)
    expect(await screen.findByText('Invitation expired')).toBeInTheDocument()
  })

  async function submitInvite(accept: Response) {
    fetchMock.mockImplementation((url: RequestInfo | URL) => Promise.resolve(
      String(url).includes('/verify') ? json({ role: 'QA' }) : accept,
    ))
    renderAt('/invite?token=abc', '/invite', <Invite />)
    await screen.findByText('Set up your account')
    await userEvent.type(screen.getByLabelText(/^password$/i), 'password123')
    await userEvent.type(screen.getByLabelText(/confirm password/i), 'password123')
    await userEvent.click(screen.getByRole('button', { name: /create account/i }))
  }

  it('an address that already has an account is told so, with the way to sign in', async () => {
    await submitInvite(json({ error: 'This email already has an account. Sign in instead.' }, 409))
    // By role as well as text: the message has to be announced, not only shown (#822).
    expect(await screen.findByText(/already has an account/i)).toHaveAttribute('role', 'alert')
    expect(screen.getByRole('link', { name: /go to sign in/i })).toHaveAttribute('href', '/login')
  })

  it('any other refusal shows the reason the relay gave', async () => {
    await submitInvite(json({ error: 'Invitation expired or not found' }, 410))
    expect(await screen.findByText('Invitation expired or not found')).toHaveAttribute('role', 'alert')
    expect(screen.queryByRole('link', { name: /go to sign in/i })).not.toBeInTheDocument()
  })

  it('a submit that cannot reach the relay says so', async () => {
    fetchMock.mockImplementation((url: RequestInfo | URL) => (
      String(url).includes('/verify') ? Promise.resolve(json({ role: 'QA' })) : Promise.reject(new TypeError('network down'))
    ))
    renderAt('/invite?token=abc', '/invite', <Invite />)
    await screen.findByText('Set up your account')
    await userEvent.type(screen.getByLabelText(/^password$/i), 'password123')
    await userEvent.type(screen.getByLabelText(/confirm password/i), 'password123')
    await userEvent.click(screen.getByRole('button', { name: /create account/i }))
    expect(await screen.findByText('Network error. Please try again.')).toHaveAttribute('role', 'alert')
  })
})

describe('ResetPassword', () => {
  it('says the link is invalid when it carries no token, without asking the relay', async () => {
    renderAt('/reset-password', '/reset-password', <ResetPassword />)
    expect(await screen.findByText('Link expired')).toBeInTheDocument()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('shows the form for a token the relay accepts', async () => {
    fetchMock.mockResolvedValue(json({ ok: true }))
    renderAt('/reset-password?token=abc', '/reset-password', <ResetPassword />)
    expect(await screen.findByText('Reset password')).toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/auth/reset-password/verify?token=abc')
  })

  it('says the link is invalid when the relay refuses the token', async () => {
    fetchMock.mockResolvedValue(json({ error: 'expired' }, 410))
    renderAt('/reset-password?token=abc', '/reset-password', <ResetPassword />)
    expect(await screen.findByText('Link expired')).toBeInTheDocument()
  })

  it('says the link is invalid when the check cannot reach the relay', async () => {
    fetchMock.mockRejectedValue(new TypeError('network down'))
    renderAt('/reset-password?token=abc', '/reset-password', <ResetPassword />)
    expect(await screen.findByText('Link expired')).toBeInTheDocument()
  })
})

// ── What the move to Query changed (#845) ─────────────────────────────────────────────────────────

describe('after the move to Query', () => {
  it('shows an invite without a token as invalid on its first render, not after a blank one', () => {
    renderAt('/invite', '/invite', <Invite />)
    expect(screen.getByText('Invitation expired')).toBeInTheDocument()
  })

  it('shows a reset link without a token as invalid on its first render', () => {
    renderAt('/reset-password', '/reset-password', <ResetPassword />)
    expect(screen.getByText('Link expired')).toBeInTheDocument()
  })

  it('does not check the invitation again when the window regains focus', async () => {
    // Refetched on focus, a token accepted in another tab would take this form away mid-way.
    fetchMock.mockResolvedValue(json({ role: 'member' }))
    renderAt('/invite?token=abc', '/invite', <Invite />)
    await screen.findByText('Set up your account')
    await act(async () => { focusManager.setFocused(false); focusManager.setFocused(true) })
    await settle()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    focusManager.setFocused(undefined)
  })

  it('does not send a freshly created admin from Login back to Setup', async () => {
    // Both pages read one cached status. Setup must record that it is now initialised, or Login
    // reads the stale "not yet" and bounces the new admin straight back.
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      if (String(input) === '/api/v1/auth/status') return json({ initialized: false })
      if (String(input) === '/api/v1/auth/init') return json({ ok: true })
      return json({}, 404)
    })
    const client = new QueryClient({ defaultOptions: { queries: { retry: 0 } } })
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/setup']}>
          <Routes>
            <Route path="/setup" element={<Setup />} />
            <Route path="/login" element={<Login />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    )
    await userEvent.type(await screen.findByLabelText(/admin email/i), 'admin@example.com')
    await userEvent.type(screen.getByLabelText(/^password$/i), 'password123')
    await userEvent.type(screen.getByLabelText(/confirm password/i), 'password123')
    await userEvent.click(screen.getByRole('button', { name: /create/i }))

    expect(await screen.findByText('Welcome back')).toBeInTheDocument()
    await settle()
    expect(screen.getByText('Welcome back')).toBeInTheDocument()
    expect(screen.queryByLabelText(/admin email/i)).toBeNull()
  })

  it('asks for the signed-in user once however many places read it', async () => {
    fetchMock.mockResolvedValue(json({ id: 1, email: 'a@b.c', displayName: null, avatarUrl: null, role: 'Admin' }))
    function Reader({ label }: { label: string }) {
      const { user } = useAuth()
      return <p>{label}:{user?.role ?? '…'}</p>
    }
    const client = new QueryClient({ defaultOptions: { queries: { retry: 0 } } })
    render(
      <QueryClientProvider client={client}>
        <Reader label="layout" /><Reader label="sidebar" /><Reader label="settings" />
      </QueryClientProvider>,
    )
    expect(await screen.findByText('settings:Admin')).toBeInTheDocument()
    expect(fetchMock.mock.calls.filter((c: unknown[]) => String(c[0]).endsWith('/api/v1/auth/me'))).toHaveLength(1)
  })
})

describe('signing in after the session ran out', () => {
  it('lands on the dashboard, not back on Login, when the cached user said "nobody"', async () => {
    // The layout redirects when `useAuth` has no user. Once that answer is cached, a successful
    // sign-in must not be judged by it.
    let signedIn = false
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/v1/auth/status') return json({ initialized: true })
      if (url.endsWith('/api/v1/auth/login')) { signedIn = true; return json({ ok: true }) }
      if (url.endsWith('/api/v1/auth/me')) {
        return signedIn ? json({ id: 1, email: 'a@b.c', displayName: null, avatarUrl: null, role: 'Admin' }) : json({ error: 'no session' }, 401)
      }
      return json({}, 404)
    })
    // As DashboardLayout does: one render with no user is enough to bounce.
    function Guarded() {
      const { user, loading } = useAuth()
      if (loading) return null
      return user ? <p>dashboard for {user.role}</p> : <><p>redirected to login</p><Navigate to="/login" replace /></>
    }
    const client = new QueryClient({ defaultOptions: { queries: { retry: 0 } } })
    const { unmount } = render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/app-center']}>
          <Routes>
            <Route path="/app-center" element={<Guarded />} />
            <Route path="/login" element={<p>login</p>} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    )
    await screen.findByText('login')
    unmount()

    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/login']}>
          <Routes>
            <Route path="/login" element={<Login />} />
            <Route path="/app-center" element={<Guarded />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    )
    await userEvent.type(await screen.findByLabelText('Email'), 'admin@example.com')
    await userEvent.type(screen.getByLabelText('Password'), 'password123')
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }))

    expect(await screen.findByText('dashboard for Admin')).toBeInTheDocument()
    expect(screen.queryByText('redirected to login')).toBeNull()
  })
})

describe('a signed-in session through a bad refetch', () => {
  // `/auth/me` refetches on window focus. The layout renders nothing while loading and redirects on
  // "nobody", so what a failed refetch means decides whether a streaming QA session survives a blip.
  function Guarded() {
    const { user, loading } = useAuth()
    if (loading) return <p>blank</p>
    return user ? <p>dashboard for {user.role}</p> : <p>redirected to login</p>
  }
  const signedIn = () => json({ id: 1, email: 'a@b.c', displayName: null, avatarUrl: null, role: 'Admin' })

  it.each([
    ['a dropped connection', () => Promise.reject(new TypeError('Failed to fetch'))],
    ['a 502 from the relay', () => Promise.resolve(json({ error: 'bad gateway' }, 502))],
  ])('keeps the dashboard up through %s', async (_, fail) => {
    fetchMock.mockImplementation(async () => signedIn())
    const client = new QueryClient({ defaultOptions: { queries: { retry: 0 } } })
    render(<QueryClientProvider client={client}><Guarded /></QueryClientProvider>)
    await screen.findByText('dashboard for Admin')

    fetchMock.mockImplementation(fail as () => Promise<Response>)
    await act(async () => { await client.refetchQueries({ queryKey: ['auth', 'me'] }) })
    await settle()
    expect(screen.getByText('dashboard for Admin')).toBeInTheDocument()
  })

  it('still sends a session the relay has ended to sign in', async () => {
    // The twin of the case above: only a 401 means "nobody".
    fetchMock.mockImplementation(async () => signedIn())
    const client = new QueryClient({ defaultOptions: { queries: { retry: 0 } } })
    render(<QueryClientProvider client={client}><Guarded /></QueryClientProvider>)
    await screen.findByText('dashboard for Admin')
    fetchMock.mockImplementation(async () => json({ error: 'expired' }, 401))
    await act(async () => { await client.refetchQueries({ queryKey: ['auth', 'me'] }) })
    expect(await screen.findByText('redirected to login')).toBeInTheDocument()
  })
})

describe('signing in on a browser someone else used', () => {
  it('does not keep what was cached for them', async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/v1/auth/status') return json({ initialized: true })
      if (url.endsWith('/api/v1/auth/login')) return json({ ok: true })
      return json({}, 404)
    })
    const client = new QueryClient({ defaultOptions: { queries: { retry: 0 } } })
    client.setQueryData(['tokens'], [{ id: 1, name: 'previous user token' }])
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/login']}>
          <Routes>
            <Route path="/login" element={<Login />} />
            <Route path="/app-center" element={<p>app center</p>} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    )
    await userEvent.type(await screen.findByLabelText('Email'), 'admin@example.com')
    await userEvent.type(screen.getByLabelText('Password'), 'password123')
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    await screen.findByText('app center')
    expect(client.getQueryData(['tokens'])).toBeUndefined()
  })
})
