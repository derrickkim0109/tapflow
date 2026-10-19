import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { toast } from 'sonner'
import { TokenSettings } from '@/src/pages/settings/Tokens'
import { withQuery } from './withQuery'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
// The page offers the Agent type to Admins only; these cases are about an Admin's dialog.
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: { id: 1, email: 'a@test.local', displayName: null, avatarUrl: null, role: 'Admin' }, loading: false }) }))

const baseTokens = [
  {
    id: 1,
    name: 'ci-deploy',
    scope: 'builds:write',
    last_used_at: null,
    expires_at: null,
    created_at: '2026-01-01T00:00:00Z',
  },
]

function renderTokens() {
  return render(withQuery(
    <MemoryRouter>
      <TokenSettings />
    </MemoryRouter>),
  )
}

describe('Tokens — toast feedback', () => {
  beforeEach(() => vi.clearAllMocks())
  afterEach(() => vi.unstubAllGlobals())

  it('TC2: 토큰 생성 실패(서버 에러) 시 toast.error 호출', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn()
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve([]) })
        .mockResolvedValueOnce({ ok: false, json: () => Promise.resolve({ error: 'Server error' }) }),
    )
    renderTokens()
    await userEvent.click(await screen.findByRole('button', { name: /new token/i }))
    await userEvent.type(screen.getByLabelText(/name/i), 'my-token')
    await userEvent.click(screen.getByRole('button', { name: /create token/i }))
    // 서버가 사유를 내려주면 그대로 보여준다 (#271 — agent 스코프 403 안내)
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('Server error'),
    )
    // The toast is outside the open dialog and hidden from assistive technology; the dialog says it too.
    expect(screen.getByRole('status')).toHaveTextContent('Server error')
  })

  it('TC2-1: 서버 에러 body가 없으면 기본 메시지로 toast.error 호출', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn()
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve([]) })
        .mockResolvedValueOnce({ ok: false, json: () => Promise.reject(new Error('no body')) }),
    )
    renderTokens()
    await userEvent.click(await screen.findByRole('button', { name: /new token/i }))
    await userEvent.type(screen.getByLabelText(/name/i), 'my-token')
    await userEvent.click(screen.getByRole('button', { name: /create token/i }))
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('Failed to create token'),
    )
  })

  it('TC1: 토큰 생성 성공 시 toast.success 호출', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn()
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve([]) })
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ token: 'abc123' }) })
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve([]) }),
    )
    renderTokens()
    await userEvent.click(await screen.findByRole('button', { name: /new token/i }))
    await userEvent.type(screen.getByLabelText(/name/i), 'my-token')
    await userEvent.click(screen.getByRole('button', { name: /create token/i }))
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith('Token created'),
    )
  })

  it('TC3: 클립보드 복사 성공 시 toast.success 호출', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    vi.stubGlobal(
      'fetch',
      vi.fn()
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve([]) })
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ token: 'abc123' }) })
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve([]) }),
    )
    renderTokens()
    await userEvent.click(await screen.findByRole('button', { name: /new token/i }))
    await userEvent.type(screen.getByLabelText(/name/i), 'my-token')
    await userEvent.click(screen.getByRole('button', { name: /create token/i }))
    await screen.findByDisplayValue('abc123')
    await userEvent.click(screen.getByRole('button', { name: /copy & close/i }))
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith('Token copied to clipboard'),
    )
  })

  it('TC4: 클립보드 복사 실패 시 toast.error 호출', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('denied'))
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    vi.stubGlobal(
      'fetch',
      vi.fn()
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve([]) })
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ token: 'abc123' }) })
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve([]) }),
    )
    renderTokens()
    await userEvent.click(await screen.findByRole('button', { name: /new token/i }))
    await userEvent.type(screen.getByLabelText(/name/i), 'my-token')
    await userEvent.click(screen.getByRole('button', { name: /create token/i }))
    await screen.findByDisplayValue('abc123')
    await userEvent.click(screen.getByRole('button', { name: /copy & close/i }))
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('Failed to copy — copy manually'),
    )
    expect(screen.getByRole('status')).toHaveTextContent(/could not copy the token/i)
    // Back on the field, where the token can be selected and copied by hand.
    expect(screen.getByDisplayValue('abc123')).toHaveFocus()
  })

  it('TC4b: 클립보드 API가 없는 평문 HTTP 페이지에서도 토큰을 선택할 수 있고 실패를 알린다', async () => {
    vi.stubGlobal('navigator', { ...navigator, clipboard: undefined })
    vi.stubGlobal(
      'fetch',
      vi.fn()
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve([]) })
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ token: 'abc123' }) })
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve([]) }),
    )
    renderTokens()
    await userEvent.click(await screen.findByRole('button', { name: /new token/i }))
    await userEvent.type(screen.getByLabelText(/name/i), 'my-token')
    await userEvent.click(screen.getByRole('button', { name: /create token/i }))
    const field = await screen.findByDisplayValue('abc123')
    // Shown once and not copyable by the API here, so it must take focus to be selected by hand.
    await waitFor(() => expect(field).toHaveFocus())
    await userEvent.click(screen.getByRole('button', { name: /copy & close/i }))
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('Failed to copy — copy manually'),
    )
  })

  async function createAgentlessToken() {
    renderTokens()
    await userEvent.click(await screen.findByRole('button', { name: /new token/i }))
    await userEvent.type(screen.getByLabelText(/name/i), 'my-token')
    await userEvent.click(screen.getByRole('button', { name: /create token/i }))
    await screen.findByDisplayValue('abc123')
  }

  function stubCreateFetch() {
    vi.stubGlobal(
      'fetch',
      vi.fn()
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve([]) })
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ token: 'abc123' }) })
        .mockResolvedValue({ ok: true, json: () => Promise.resolve([]) }),
    )
  }

  // The dialog clears on the way in (the trigger's onOpenChange(true)), not on close, so it stays unchanged
  // while it animates out. Removing that reset would reopen on the previous token and its failure text.
  it('TC4c: 복사 실패 후 성공으로 닫았다가 다시 열면 이전 토큰도 실패 문구도 남지 않는다', async () => {
    const writeText = vi.fn().mockRejectedValueOnce(new Error('denied')).mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    stubCreateFetch()
    await createAgentlessToken()

    await userEvent.click(screen.getByRole('button', { name: /copy & close/i }))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/could not copy the token/i))
    await userEvent.click(screen.getByRole('button', { name: /copy & close/i }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())

    await userEvent.click(screen.getByRole('button', { name: /new token/i }))
    expect(await screen.findByLabelText(/name/i)).toBeInTheDocument()
    expect(screen.queryByDisplayValue('abc123')).not.toBeInTheDocument()
    expect(screen.getByRole('status').textContent).toBe('')
  })

  it('TC4d: 같은 복사 실패가 반복돼도 상태 영역이 다시 바뀌어 읽힌다', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('denied'))
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    stubCreateFetch()
    await createAgentlessToken()

    await userEvent.click(screen.getByRole('button', { name: /copy & close/i }))
    const status = screen.getByRole('status')
    await waitFor(() => expect(status).toHaveTextContent(/could not copy the token/i))

    const changes: MutationRecord[] = []
    const observer = new MutationObserver((records) => changes.push(...records))
    observer.observe(status, { childList: true, characterData: true, subtree: true })
    await userEvent.click(screen.getByRole('button', { name: /copy & close/i }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(status).toHaveTextContent(/could not copy the token/i))
    observer.disconnect()

    // Writing identical text changes nothing in the DOM, and a live region speaks only on a change.
    expect(changes.length).toBeGreaterThan(0)
  })

  it('TC5: revoke 성공 시 toast.success 호출', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn()
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(baseTokens) })
        .mockResolvedValueOnce({ ok: true })
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve([]) }),
    )
    renderTokens()
    await screen.findByText('ci-deploy')
    await userEvent.click(screen.getByRole('button', { name: /revoke token/i }))
    await userEvent.click(await screen.findByRole('button', { name: /^revoke$/i }))
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith('Token revoked'),
    )
  })

  it('TC6: revoke 실패(서버 에러) 시 toast.error 호출', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn()
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(baseTokens) })
        .mockResolvedValueOnce({ ok: false }),
    )
    renderTokens()
    await screen.findByText('ci-deploy')
    await userEvent.click(screen.getByRole('button', { name: /revoke token/i }))
    await userEvent.click(await screen.findByRole('button', { name: /^revoke$/i }))
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('Failed to revoke token'),
    )
  })
})
