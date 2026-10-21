// The comment composer's own failures: a post that throws, a post the relay refuses, where focus goes after a
// post, and an image pick that is rejected or repeated.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'
import { withQuery } from './withQuery'
import { CommentPanel } from '@/components/CommentPanel'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

type Post = (body: FormData) => Promise<{ ok: boolean }>
let post: Post
const posted: FormData[] = []

beforeEach(() => {
  posted.length = 0
  post = async () => ({ ok: true })
  vi.mocked(toast.error).mockClear()
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/v1/comments' && init?.method === 'POST') {
      posted.push(init.body as FormData)
      const res = await post(init.body as FormData)
      return { ...res, json: async () => ({}) }
    }
    if (url.startsWith('/api/v1/comments')) return { ok: true, json: async () => [] }
    return { ok: true, json: async () => ({}) }
  }))
})
afterEach(() => vi.unstubAllGlobals())

const field = () => screen.getByRole('textbox', { name: 'Comment' })
const postButton = () => screen.getByRole('button', { name: 'Post comment' })
const fileInput = () => document.querySelector('input[type="file"]') as HTMLInputElement
const png = (name = 'shot.png') => new File(['x'], name, { type: 'image/png' })

async function setup() {
  const user = userEvent.setup({ applyAccept: false })
  render(withQuery(<CommentPanel buildId={3} />))
  await screen.findByText('No comments yet.')
  return user
}

describe('CommentPanel — posting', () => {
  it('keeps the text and lets Post be pressed again when the post throws', async () => {
    post = async () => { throw new TypeError('Failed to fetch') }
    const user = await setup()
    await user.type(field(), 'a note')
    await user.click(postButton())
    await waitFor(() => expect(postButton()).toHaveAttribute('aria-disabled', 'false'))
    expect(postButton()).toBeEnabled()
    expect(field()).toHaveValue('a note')
    expect(toast.error).toHaveBeenCalled()
  })

  it('says so when the relay refuses the post', async () => {
    post = async () => ({ ok: false })
    const user = await setup()
    await user.type(field(), 'a note')
    await user.click(postButton())
    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    expect(field()).toHaveValue('a note')
  })

  it('stays focusable while the post is on its way, so focus is not dropped', async () => {
    let finish: (v: { ok: boolean }) => void = () => {}
    post = () => new Promise((r) => { finish = r })
    const user = await setup()
    await user.type(field(), 'a note')
    postButton().focus()
    await user.keyboard('{Enter}')
    expect(postButton()).toHaveAttribute('aria-disabled', 'true')
    expect(postButton()).not.toBeDisabled()
    await user.keyboard('{Enter}')
    expect(posted).toHaveLength(1)
    finish({ ok: true })
    await waitFor(() => expect(field()).toHaveValue(''))
  })

  it('puts focus back in the field after a post, since Post is then disabled', async () => {
    const user = await setup()
    await user.type(field(), 'a note')
    postButton().focus()
    await user.keyboard('{Enter}')
    await waitFor(() => expect(field()).toHaveFocus())
    expect(postButton()).toBeDisabled()
  })

  it('leaves focus where it went if it left the composer during the post', async () => {
    let finish: (v: { ok: boolean }) => void = () => {}
    post = () => new Promise((r) => { finish = r })
    const user = await setup()
    const elsewhere = document.createElement('button')
    document.body.appendChild(elsewhere)
    await user.type(field(), 'a note')
    await user.click(postButton())
    elsewhere.focus()
    finish({ ok: true })
    await waitFor(() => expect(field()).toHaveValue(''))
    expect(elsewhere).toHaveFocus()
    elsewhere.remove()
  })
})

describe('CommentPanel — picking an image', () => {
  it('drops the earlier image when a later pick is rejected', async () => {
    const user = await setup()
    await user.upload(fileInput(), png())
    expect(screen.getByText('shot.png')).toBeInTheDocument()
    await user.upload(fileInput(), new File(['x'], 'clip.gif', { type: 'image/gif' }))
    expect(screen.getByRole('alert')).toHaveTextContent('Only png, jpg, webp allowed')
    expect(screen.queryByText('shot.png')).toBeNull()
    expect(postButton()).toBeDisabled()
  })

  it('clears a file error once a comment is posted', async () => {
    const user = await setup()
    await user.upload(fileInput(), new File(['x'], 'clip.gif', { type: 'image/gif' }))
    await user.type(field(), 'a note')
    await user.click(postButton())
    await waitFor(() => expect(field()).toHaveValue(''))
    expect(screen.queryByRole('alert')).toBeNull()
    expect(posted[0].get('attachment')).toBeNull()
  })

  it('takes the same image again after it was posted', async () => {
    const user = await setup()
    await user.upload(fileInput(), png())
    expect(fileInput().value).toBe('')
    await user.click(postButton())
    await waitFor(() => expect(screen.queryByText('shot.png')).toBeNull())
    await user.upload(fileInput(), png())
    expect(screen.getByText('shot.png')).toBeInTheDocument()
  })
})
