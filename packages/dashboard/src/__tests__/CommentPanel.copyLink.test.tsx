import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'
import { CommentPanel } from '@/components/CommentPanel'
import { resetTeammateBasesForTests } from '@/lib/publicLink'
import type { Comment } from '@/lib/types'
import { withQuery } from './withQuery'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const comment: Comment = {
  id: 7,
  author: 'QA',
  authorAvatarUrl: null,
  body: 'Button overlaps the header',
  created_at: '2026-09-13 10:00:00',
  attachments: [],
}

const configured = { lanHost: null, port: 4000, publicBaseUrl: 'http://192.168.219.113:4000', agentRelayUrl: null }
const dom = (globalThis as unknown as { jsdom: { reconfigure(options: { url: string }): void } }).jsdom

function stubFetch(host: object, hold?: Promise<void>) {
  const fetchMock = vi.fn(async (url: string) => {
    if (url.includes('/api/v1/relay/host')) {
      if (hold) await hold
      return { ok: true, json: async () => host }
    }
    if (url.includes('/api/v1/comments')) return { ok: true, json: async () => [comment] }
    return { ok: true, json: async () => [] }
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

const relayHostCalls = (fetchMock: Mock) =>
  fetchMock.mock.calls.filter(([url]) => String(url).includes('/api/v1/relay/host')).length

describe('CommentPanel — copying a link to a comment', () => {
  const original = window.location.href
  let writeText: Mock<(text: string) => Promise<void>>

  beforeEach(() => {
    vi.clearAllMocks()
    resetTeammateBasesForTests()
    dom.reconfigure({ url: 'http://localhost:3000/app-center/build?id=3' })
    writeText = vi.fn(async (_text: string) => {})
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    // Radix ScrollArea measures its content once comments render; jsdom has no ResizeObserver.
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  })

  afterEach(() => {
    dom.reconfigure({ url: original })
    vi.unstubAllGlobals()
  })

  it('copies the teammate base with this page path and the comment anchor', async () => {
    stubFetch(configured)
    render(withQuery(<CommentPanel buildId={3} />))

    await userEvent.click(await screen.findByRole('button', { name: /copy link to comment/i }))

    await waitFor(() => expect(writeText).toHaveBeenCalledWith('http://192.168.219.113:4000/app-center/build?id=3#comment-7'))
    expect(toast.success).toHaveBeenCalledWith('Link copied')
  })

  it('starts the lookup when it mounts, before anyone clicks', async () => {
    const fetchMock = stubFetch(configured)
    expect(relayHostCalls(fetchMock)).toBe(0)

    render(withQuery(<CommentPanel buildId={3} />))
    await screen.findByText('Button overlaps the header')

    expect(relayHostCalls(fetchMock)).toBe(1)
  })

  it('waits for a slow lookup instead of copying the browser address', async () => {
    let release!: () => void
    const hold = new Promise<void>((resolve) => { release = resolve })
    stubFetch(configured, hold)
    render(withQuery(<CommentPanel buildId={3} />))

    await userEvent.click(await screen.findByRole('button', { name: /copy link to comment/i }))
    expect(writeText).not.toHaveBeenCalled()

    release()
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1))
    expect(writeText.mock.calls[0][0]).toBe('http://192.168.219.113:4000/app-center/build?id=3#comment-7')
  })

  it('reports a page with no clipboard API (plain HTTP) as a failed copy', async () => {
    vi.stubGlobal('navigator', { ...navigator, clipboard: undefined })
    stubFetch(configured)
    render(withQuery(<CommentPanel buildId={3} />))

    await userEvent.click(await screen.findByRole('button', { name: /copy link to comment/i }))

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Could not copy link'))
  })

  it('reports a write the browser refused, and does not claim it', async () => {
    writeText.mockRejectedValue(new Error('denied'))
    stubFetch(configured)
    render(withQuery(<CommentPanel buildId={3} />))

    await userEvent.click(await screen.findByRole('button', { name: /copy link to comment/i }))

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Could not copy link'))
    expect(toast.success).not.toHaveBeenCalled()
  })
})
