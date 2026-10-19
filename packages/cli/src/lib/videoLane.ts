import { fetchWithToken, fixedToken, tokenRefusal, type TokenSource, type VideoChunk, type VideoEndReason, type VideoMeta, type VideoSink } from '@tapflowio/flow-runner'

/**
 * Sends each flow's video to the relay (`/api/v1/runs/:id/flows/:idx/video`), beside the run record (A4).
 *
 * **Its own lane, never the record's.** A refused or slow video call must not stop reports, screenshots or
 * `finish`, so this has its own queue and its own way of stopping; it shares only the run's id and the end-of-run
 * budget, which `finish` gets first.
 *
 * - **Nothing is dropped ahead of time.** A chunk becomes a gap only when its own upload failed. With a healthy relay
 *   no frame is lost; a lane holding more than `MAX_QUEUED_BYTES` unsent stops video for the run instead of
 *   growing without bound.
 * - **After a gap, upload resumes at a decodable keyframe** — the chunks between could not be decoded anyway.
 * - **A failed flow's last chunk is retried once**: it holds the moment of the failure. Failing again, the video's
 *   end says `truncated`. Not sent early: the relay reads a seq below the one it expects as a duplicate.
 * - Per response: a timeout or a 5xx is a gap; `size-limit` ends that video; `storage-full` and anything that says
 *   the relay will not take video (401, 403, 404, an older relay's HTML) stop the lane for the run.
 * - Warnings are a line each, at most: one when video stops, one the first time a video has a gap.
 */

export interface VideoLaneDeps {
  fetch: typeof fetch
  warn: (line: string) => void
  callTimeoutMs?: number
  chunkTimeoutMs?: number
}

const CALL_TIMEOUT_MS = 5_000
/** A 2 MB chunk on a 3 Mbit/s CI uplink takes ~5 s on its own. */
const CHUNK_TIMEOUT_MS = 15_000
export const MAX_QUEUED_BYTES = 128 * 1024 * 1024

class LaneStop extends Error {}

type Item =
  | { kind: 'open'; v: VideoState; meta: VideoMeta }
  | { kind: 'chunk'; v: VideoState; chunk: VideoChunk }
  | { kind: 'end'; v: VideoState; lastSeq: number; reason: VideoEndReason }

interface VideoState {
  idx: number
  /** Set by the caller once the flow's outcome is known, before the video ends. */
  failed: boolean
  /** The relay will take no more of this video (ended, evicted, never opened). */
  closed: boolean
  /** A chunk was lost; skip until a decodable keyframe. */
  awaitingKeyframe: boolean
  /** The newest chunk handed to the lane, so a failure can tell whether it held the flow's last moment. */
  newestSeq: number
  ended: boolean
  tailLost: boolean
}

export class VideoLane {
  private readonly items: Item[] = []
  private queuedBytes = 0
  private running: Promise<void> | null = null
  private stopped = false
  private gapWarned = false
  private readonly gaveUp = new AbortController()
  private readonly callTimeoutMs: number
  private readonly chunkTimeoutMs: number

  private readonly tokens: TokenSource

  constructor(
    private readonly httpBase: string,
    token: string | TokenSource,
    /** Resolves to the run's id once the record has it, or null if the run was never created. */
    private readonly runId: Promise<string | null>,
    private readonly deps: VideoLaneDeps,
  ) {
    this.tokens = typeof token === 'string' ? fixedToken(token, httpBase) : token
    this.callTimeoutMs = deps.callTimeoutMs ?? CALL_TIMEOUT_MS
    this.chunkTimeoutMs = deps.chunkTimeoutMs ?? CHUNK_TIMEOUT_MS
  }

  /** The sink for one flow's video. Set `failed` before the video ends. */
  video(idx: number): VideoSink & { failed: boolean } {
    const v: VideoState = { idx, failed: false, closed: false, awaitingKeyframe: false, newestSeq: -1, ended: false, tailLost: false }
    const push = (item: Item) => this.push(item)
    return {
      get failed() { return v.failed },
      set failed(f: boolean) { v.failed = f },
      open: (meta) => push({ kind: 'open', v, meta }),
      chunk: (chunk) => {
        v.newestSeq = chunk.seq
        push({ kind: 'chunk', v, chunk })
      },
      end: (lastSeq, reason) => push({ kind: 'end', v, lastSeq, reason }),
    }
  }

  /** Waits for what is queued, at most `capMs`. What is left then is lost, and said once. */
  async drain(capMs: number): Promise<void> {
    if (!this.running || this.stopped) return
    let timer: NodeJS.Timeout | undefined
    const cap = new Promise<'cap'>((resolve) => { timer = setTimeout(() => resolve('cap'), Math.max(0, capMs)) })
    const done = await Promise.race([this.running.then(() => 'done' as const), cap])
    clearTimeout(timer)
    if (done === 'cap') {
      this.stop(`video incomplete: the relay did not take it within ${Math.round(capMs / 1000)}s`)
      this.gaveUp.abort()
    }
  }

  private push(item: Item): void {
    if (this.stopped) return
    if (item.kind === 'chunk') {
      if (this.queuedBytes + item.chunk.data.length > MAX_QUEUED_BYTES) {
        this.stop('video stopped: the relay is not taking it as fast as it arrives')
        return
      }
      this.queuedBytes += item.chunk.data.length
    }
    this.items.push(item)
    this.running ??= this.pump().finally(() => { this.running = null })
  }

  private async pump(): Promise<void> {
    const id = await this.runId
    if (id === null) {
      // The record already said the run was not recorded; there is nothing to attach a video to.
      this.stopped = true
      this.items.length = 0
      return
    }
    for (let item = this.items.shift(); item && !this.stopped; item = this.items.shift()) {
      if (item.kind === 'chunk') this.queuedBytes -= item.chunk.data.length
      try {
        await this.send(id, item)
      } catch (e) {
        if (this.stopped) return
        this.stop(e instanceof LaneStop ? e.message : `video stopped: could not reach the relay (${(e as Error).message})`)
      }
    }
  }

  private async send(id: string, item: Item): Promise<void> {
    const { v } = item
    const base = `/api/v1/runs/${encodeURIComponent(id)}/flows/${v.idx}/video`
    if (item.kind === 'open') {
      const res = await this.post(`${base}/open`, JSON.stringify(item.meta), 'application/json', {}, this.callTimeoutMs)
      if (res.status === 409) { v.closed = true; return }
      if (!res.ok) throw new LaneStop(await refusal(res, this.tokens))
      // An older relay answers an unknown `/api/` POST with the dashboard's index.html and a 200.
      const body = await res.json().catch(() => null) as { ok?: unknown } | null
      if (body?.ok !== true) throw new LaneStop('video not recorded: this relay does not keep run videos yet (update it to keep them)')
      return
    }
    if (item.kind === 'end') {
      v.ended = true
      if (v.closed) return
      const reason = v.tailLost && item.reason === 'done' ? 'truncated' : item.reason
      const res = await this.post(`${base}/end`, JSON.stringify({ lastSeq: item.lastSeq, reason }), 'application/json', {}, this.callTimeoutMs)
      if (!res.ok && res.status !== 404 && res.status !== 409) throw new LaneStop(await refusal(res, this.tokens))
      return
    }
    const { chunk } = item
    if (v.closed) return
    const isTail = (): boolean => v.failed && chunk.seq === v.newestSeq
    if (v.awaitingKeyframe) {
      // Skipped after a gap, and when it is a failed flow's last chunk, the failure's moment is what is missing.
      if (!chunk.keyframe) {
        if (isTail()) v.tailLost = true
        return
      }
      v.awaitingKeyframe = false
    }
    for (let attempt = 0; ; attempt++) {
      let res: Response | null = null
      try {
        res = await this.post(`${base}/chunks/${chunk.seq}`, chunk.data, 'application/octet-stream', {
          'X-Start-Ms': String(chunk.startMs),
          'X-Keyframe': chunk.keyframe ? '1' : '0',
        }, this.chunkTimeoutMs)
      } catch (e) {
        if (this.gaveUp.signal.aborted) throw e
        res = null
      }
      if (res?.ok) return
      if (res && (res.status === 409 || res.status === 410 || res.status === 404)) { v.closed = true; return }
      if (res?.status === 413) {
        const body = await res.json().catch(() => null) as { reason?: unknown } | null
        if (body?.reason === 'size-limit') { v.closed = true; return }
      }
      if (res?.status === 507) throw new LaneStop('video stopped: the relay\'s storage for videos is full')
      if (res && (res.status === 401 || res.status === 403)) throw new LaneStop(await refusal(res, this.tokens))
      // A timeout, a 5xx, a chunk too large: this chunk is a gap. The one holding a failure's moment gets one more try.
      if (attempt === 0 && isTail()) continue
      if (isTail()) v.tailLost = true
      v.awaitingKeyframe = true
      if (!this.gapWarned) {
        this.gapWarned = true
        this.deps.warn(`video incomplete (flow ${v.idx + 1}): a part did not reach the relay; the rest is still sent`)
      }
      return
    }
  }

  private stop(line: string): void {
    if (this.stopped) return
    this.stopped = true
    this.items.length = 0
    this.queuedBytes = 0
    this.deps.warn(line)
  }

  private async post(path: string, body: string | Buffer, contentType: string, headers: Record<string, string>, timeoutMs: number): Promise<Response> {
    return fetchWithToken(this.tokens, new URL(path, this.httpBase).toString(), {
      method: 'POST',
      headers: { 'Content-Type': contentType, ...headers },
      body: typeof body === 'string' ? body : new Uint8Array(body),
      signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), this.gaveUp.signal]),
    }, this.deps.fetch)
  }
}

async function refusal(res: Response, tokens: TokenSource): Promise<string> {
  const detail = await res.json().then((b: { error?: unknown }) => (typeof b.error === 'string' ? b.error : ''), () => '')
  if (res.status === 401) return `video not recorded: ${tokenRefusal(tokens)}`
  if (res.status === 403) return `video not recorded: the token may not record runs${detail ? ` (${detail})` : ''}`
  return `video stopped: the relay answered ${res.status}${detail ? ` (${detail})` : ''}`
}
