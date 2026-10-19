import { describe, it, expect, vi } from 'vitest'
import { VideoLane, MAX_QUEUED_BYTES } from '../../lib/videoLane.js'

// The video lane sends each flow's video beside the run record (A4). What it must never do is touch the record:
// these pin how it answers each kind of refusal, and that nothing is dropped unless its own upload failed.

type Answer = (url: string, init: RequestInit) => Response | Promise<Response>

const okAnswer: Answer = (url) => (url.endsWith('/open') ? Response.json({ ok: true, nextSeq: 0 }, { status: 201 }) : Response.json({ ok: true }))

function lane(answer: Answer = okAnswer, runId: string | null = 'run-1', chunkTimeoutMs?: number) {
  const warn = vi.fn()
  const calls: { path: string; body: unknown; headers: Record<string, string> }[] = []
  const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(url))
    const raw = init?.body
    calls.push({
      path: u.pathname,
      body: typeof raw === 'string' ? JSON.parse(raw) : raw ? Buffer.from(raw as Uint8Array).toString() : raw,
      headers: init?.headers as Record<string, string>,
    })
    return answer(String(url), init ?? {})
  })
  const l = new VideoLane('http://relay.test', 'tflw_pat_x', Promise.resolve(runId), {
    fetch: fetchMock as typeof fetch, warn, ...(chunkTimeoutMs ? { chunkTimeoutMs } : {}),
  })
  return { l, warn, calls, paths: () => calls.map((c) => c.path.replace('/api/v1/runs/run-1/flows/', '')) }
}

const META = { formatVersion: 1, codec: 'h264' as const, clockBase: 1, flowStartMs: 0 }
const chunk = (seq: number, keyframe = seq === 0, data = `c${seq}`) => ({ seq, startMs: seq * 2000, keyframe, data: Buffer.from(data) })
const hang: Answer = (_u, init) => new Promise((_r, rej) => init.signal?.addEventListener('abort', () => rej(init.signal!.reason as Error)))

describe('VideoLane', () => {
  it('opens, sends each chunk with its start and keyframe, and ends, in order and with the token', async () => {
    const { l, calls, paths, warn } = lane()
    const v = l.video(0)
    v.open(META)
    v.chunk(chunk(0))
    v.chunk(chunk(1))
    v.end(1, 'done')
    await l.drain(1000)
    expect(paths()).toEqual(['0/video/open', '0/video/chunks/0', '0/video/chunks/1', '0/video/end'])
    expect(calls[0]!.body).toEqual(META)
    expect(calls[1]!.headers).toMatchObject({ Authorization: 'Bearer tflw_pat_x', 'X-Start-Ms': '0', 'X-Keyframe': '1' })
    expect(calls[2]!.headers).toMatchObject({ 'X-Start-Ms': '2000', 'X-Keyframe': '0' })
    expect(calls[2]!.body).toBe('c1')
    expect(calls[3]!.body).toEqual({ lastSeq: 1, reason: 'done' })
    expect(warn).not.toHaveBeenCalled()
  })

  it('sends nothing when the run was never created', async () => {
    const { l, calls, warn } = lane(okAnswer, null)
    const v = l.video(0)
    v.open(META)
    v.chunk(chunk(0))
    await l.drain(1000)
    expect(calls).toEqual([])
    expect(warn).not.toHaveBeenCalled()
  })

  it('after a lost chunk, resumes at the next decodable keyframe, and says so once', async () => {
    const { l, paths, warn } = lane((url, init) => (url.endsWith('/chunks/1') || url.endsWith('/chunks/4') ? Response.json({ error: 'boom' }, { status: 500 }) : okAnswer(url, init)))
    const v = l.video(0)
    v.open(META)
    for (const [seq, kf] of [[0, true], [1, false], [2, false], [3, true], [4, false], [5, false], [6, true]] as const) v.chunk(chunk(seq, kf))
    v.end(6, 'done')
    await l.drain(1000)
    expect(paths()).toEqual(['0/video/open', '0/video/chunks/0', '0/video/chunks/1', '0/video/chunks/3', '0/video/chunks/4', '0/video/chunks/6', '0/video/end'])
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]![0]).toContain('video incomplete (flow 1)')
  })

  it('retries a failed flow\'s last chunk once, and ends it as truncated when that fails too', async () => {
    let tries = 0
    const { l, paths, calls } = lane((url, init) => {
      if (url.endsWith('/chunks/1')) { tries++; return Response.json({}, { status: 503 }) }
      return okAnswer(url, init)
    })
    const v = l.video(0)
    v.open(META)
    v.chunk(chunk(0))
    v.failed = true
    v.chunk(chunk(1))
    v.end(1, 'done')
    await l.drain(1000)
    expect(tries).toBe(2)
    expect(paths().filter((p) => p.endsWith('/end'))).toHaveLength(1)
    expect(calls.at(-1)!.body).toEqual({ lastSeq: 1, reason: 'truncated' })
  })

  it('ends a failed flow\'s video as truncated when its last chunk is skipped after an earlier gap', async () => {
    const { l, paths, calls } = lane((url, init) => (url.endsWith('/chunks/1') ? Response.json({}, { status: 500 }) : okAnswer(url, init)))
    const v = l.video(0)
    v.open(META)
    v.chunk(chunk(0))
    v.chunk(chunk(1))
    v.failed = true
    v.chunk(chunk(2, false))
    v.end(2, 'done')
    await l.drain(1000)
    expect(paths()).toEqual(['0/video/open', '0/video/chunks/0', '0/video/chunks/1', '0/video/end'])
    expect(calls.at(-1)!.body).toEqual({ lastSeq: 2, reason: 'truncated' })
  })

  it('does not retry a lost chunk of a passed flow', async () => {
    let tries = 0
    const { l, calls } = lane((url, init) => {
      if (url.endsWith('/chunks/1')) { tries++; return Response.json({}, { status: 503 }) }
      return okAnswer(url, init)
    })
    const v = l.video(0)
    v.open(META)
    v.chunk(chunk(0))
    v.chunk(chunk(1))
    v.end(1, 'done')
    await l.drain(1000)
    expect(tries).toBe(1)
    expect(calls.at(-1)!.body).toEqual({ lastSeq: 1, reason: 'done' })
  })

  it('stops for the run on storage full, with one warning, and sends nothing more', async () => {
    const { l, paths, warn } = lane((url, init) => (url.includes('/chunks/') ? Response.json({ reason: 'storage-full' }, { status: 507 }) : okAnswer(url, init)))
    const a = l.video(0)
    a.open(META)
    a.chunk(chunk(0))
    a.end(0, 'done')
    const b = l.video(1)
    b.open(META)
    await l.drain(1000)
    expect(paths()).toEqual(['0/video/open', '0/video/chunks/0'])
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]![0]).toContain('storage for videos is full')
  })

  it('stops at an older relay that answers the open with its dashboard page', async () => {
    const { l, paths, warn } = lane(() => new Response('<!doctype html>', { status: 200, headers: { 'Content-Type': 'text/html' } }))
    const v = l.video(0)
    v.open(META)
    v.chunk(chunk(0))
    await l.drain(1000)
    expect(paths()).toEqual(['0/video/open'])
    expect(warn.mock.calls[0]![0]).toContain('does not keep run videos yet')
  })

  it.each([
    ['a token the relay refuses', 401, 'did not accept the token'],
    ['a token that may not record', 403, 'may not record runs'],
  ])('stops at %s', async (_name, status, says) => {
    const { l, warn } = lane(() => Response.json({ error: 'no' }, { status }))
    l.video(0).open(META)
    await l.drain(1000)
    expect(warn.mock.calls[0]![0]).toContain(says)
  })

  it.each([
    ['size-limit', 413, { reason: 'size-limit' }],
    ['ended', 409, { error: 'Video already ended' }],
    ['no longer kept', 410, { error: 'gone' }],
  ])('sends no more of a video the relay closed (%s), but carries on with the next flow', async (_n, status, body) => {
    const { l, paths, warn } = lane((url, init) => (url.endsWith('/0/video/chunks/0') ? Response.json(body, { status }) : okAnswer(url, init)))
    const a = l.video(0)
    a.open(META)
    a.chunk(chunk(0))
    a.chunk(chunk(1, true))
    a.end(1, 'done')
    const b = l.video(1)
    b.open(META)
    b.chunk(chunk(0))
    await l.drain(1000)
    expect(paths()).toEqual(['0/video/open', '0/video/chunks/0', '1/video/open', '1/video/chunks/0'])
    expect(warn).not.toHaveBeenCalled()
  })

  it('treats a chunk that times out as a gap, not as the relay being gone', async () => {
    const { l, paths, warn } = lane((url, init) => (url.endsWith('/chunks/0') ? hang(url, init) : okAnswer(url, init)), 'run-1', 20)
    const v = l.video(0)
    v.open(META)
    v.chunk(chunk(0))
    v.chunk(chunk(1, true))
    v.end(1, 'done')
    await l.drain(2000)
    expect(paths()).toEqual(['0/video/open', '0/video/chunks/0', '0/video/chunks/1', '0/video/end'])
    expect(warn.mock.calls.map(([w]) => w)).toEqual([expect.stringContaining('video incomplete')])
  })

  it('gives up at the drain cap, aborting the call in flight, and says so once', async () => {
    const { l, warn } = lane((url, init) => (url.includes('/chunks/') ? hang(url, init) : okAnswer(url, init)))
    const v = l.video(0)
    v.open(META)
    v.chunk(chunk(0))
    v.end(0, 'done')
    const started = Date.now()
    await l.drain(50)
    expect(Date.now() - started).toBeLessThan(1000)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]![0]).toContain('video incomplete')
  })

  it('stops instead of holding more than its memory cap unsent', async () => {
    const { l, warn } = lane(hang, 'run-1', 60_000)
    const v = l.video(0)
    v.open(META)
    const big = Buffer.alloc(16 * 1024 * 1024)
    for (let i = 0; i <= MAX_QUEUED_BYTES / big.length; i++) v.chunk({ seq: i, startMs: 0, keyframe: true, data: big })
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]![0]).toContain('not taking it as fast as it arrives')
    await l.drain(10)
  })
})
