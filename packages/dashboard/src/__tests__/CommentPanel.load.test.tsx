// What the comment panel shows from the relay — pinned before it moves from an effect to TanStack
// Query (#845, found by the lint review after the move), and what the move changes.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { withQuery } from './withQuery'
import { CommentPanel } from '@/components/CommentPanel'
import type { Comment } from '@/lib/types'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const comment = (id: number, body: string): Comment => ({
  id, author: 'QA', authorAvatarUrl: null, body, created_at: '2026-09-24 01:00:00', attachments: [],
})

let rows: Comment[] = []
let failList = false
beforeEach(() => {
  rows = [comment(1, 'first note')]
  failList = false
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes('/api/v1/relay/host')) return { ok: true, json: async () => ({}) }
    if (url === '/api/v1/comments' && init?.method === 'POST') {
      rows = [...rows, comment(2, String((init.body as FormData).get('body')))]
      return { ok: true, json: async () => ({}) }
    }
    if (url.startsWith('/api/v1/comments')) {
      return failList ? { ok: false, json: async () => ({ error: 'boom' }) } : { ok: true, json: async () => rows }
    }
    return { ok: true, json: async () => ({}) }
  }))
})
afterEach(() => vi.unstubAllGlobals())

describe('CommentPanel — what it loads', () => {
  it('lists the build\'s comments', async () => {
    render(withQuery(<CommentPanel buildId={3} />))
    expect(await screen.findByText('first note')).toBeInTheDocument()
  })

  it('shows a posted comment once it is saved', async () => {
    render(withQuery(<CommentPanel buildId={3} />))
    await screen.findByText('first note')
    await userEvent.type(screen.getByRole('textbox'), 'second note')
    await userEvent.click(screen.getByRole('button', { name: /send|post|submit/i }))
    expect(await screen.findByText('second note')).toBeInTheDocument()
  })
})

describe('CommentPanel — after the move to Query', () => {
  it('says it is loading, not that there are none, while the list is on its way', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})))
    render(withQuery(<CommentPanel buildId={3} />))
    expect(screen.getByText('Loading comments…')).toBeInTheDocument()
    expect(screen.queryByText('No comments yet.')).toBeNull()
  })

  it('says the comments could not be loaded, rather than that there are none', async () => {
    failList = true
    render(withQuery(<CommentPanel buildId={3} />))
    expect(await screen.findByText("Couldn't load comments.")).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByText('No comments yet.')).toBeNull())
  })
})
