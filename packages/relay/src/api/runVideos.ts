import http from 'http'
import fs from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'
import { getDb } from '../db.js'
import { requireViewAuth } from '../middleware/auth.js'
import { json, readBodyLimited } from '../router.js'
import { unlinkSafe } from '../lib/uploads.js'
import { findRun, finishedWithin, ownRun, settleOrphanedRuns, type RunHolders, type RunRow } from './runs.js'

// A flow's video (A4): the flow runner uploads the stream it already receives, in chunks, while the flow runs.
//
// **The relay never reads a chunk.** It reads the open call's JSON and nothing else; chunks are bytes it writes at a
// committed offset and serves back by range. That is the line the "no screen data" rule now draws (relay
// AGENTS.md): what a runner uploads to its own run is kept under a policy, and a stream the relay forwards is not.

/** Seconds after `finish` the runner may still send the last flow's tail and end call. */
export const VIDEO_GRACE_SECONDS = 120
const MAX_META_BYTES = 16 * 1024
/** A chunk is ~2 s or ~2 MB of frames; this leaves room for a larger screen than any measured. */
const MAX_CHUNK_BYTES = 8 * 1024 * 1024
/** ~1.5 min of continuous motion at the measured 8–9 Mbit/s; a flow-like minute is ~25 MB. */
const MAX_VIDEO_BYTES = 100 * 1024 * 1024
/** Free space the relay keeps for itself whatever the cap says: a full disk takes SQLite, sign-in and uploads down. */
const MIN_FREE_BYTES = 1024 * 1024 * 1024
const MIN_FREE_FRACTION = 0.1
/**
 * The highest chunk number taken. The index lists every missing number up to the last one, synchronously, so an
 * unbounded seq or `lastSeq` would let one request hang the relay. ~5.5 h of 2 s chunks, far past any flow.
 */
const MAX_SEQ = 10_000

const END_REASONS = new Set(['done', 'cancelled', 'size-limit', 'storage-full', 'runner-lost', 'truncated'])

export function runVideosDirFor(uploadsDir: string): string {
  return path.join(uploadsDir, '../run-videos')
}

interface VideoRow {
  run_seq: number
  idx: number
  file: string
  meta_json: string
  bytes: number
  reserved_bytes: number
  next_seq: number
  ended_at: string | null
  end_reason: string | null
  end_last_seq: number | null
  evicted_at: string | null
  created_at: string
}

function findVideo(runSeq: number, idx: number): VideoRow | undefined {
  return getDb().prepare('SELECT * FROM flow_run_videos WHERE run_seq = ? AND idx = ?').get(runSeq, idx) as VideoRow | undefined
}

/**
 * **Ended is decided here, not only by the end call**, because that call can be lost with the runner: an explicit
 * end, or the run finished and the grace has passed, or the relay closed the run because its runner went away.
 */
export function videoEnded(video: Pick<VideoRow, 'ended_at'>, run: Pick<RunRow, 'status' | 'finished_by' | 'finished_at'>): boolean {
  if (video.ended_at !== null) return true
  if (run.status === 'running') return false
  if (run.finished_by === 'relay') return true
  return !finishedWithin(run, VIDEO_GRACE_SECONDS)
}

function flowIndex(run: RunRow, raw: string): number | null {
  const idx = Number(raw)
  return /^\d+$/.test(raw) && Number.isSafeInteger(idx) && idx < run.flows_total ? idx : null
}

// ── writes (the run's creator, until the video has ended) ────────────────────

/** Chunk writes of one video run one at a time: two writes at one committed offset would interleave. */
const writing = new Map<string, Promise<void>>()

function serialised<T>(key: string, op: () => Promise<T>): Promise<T> {
  const prev = writing.get(key) ?? Promise.resolve()
  const next = prev.then(op, op)
  const tail = next.then(() => undefined, () => undefined)
  writing.set(key, tail)
  void tail.then(() => { if (writing.get(key) === tail) writing.delete(key) })
  return next
}

export async function handleOpenVideo(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  params: Record<string, string>,
  videosDir: string,
): Promise<void> {
  const run = ownRun(req, res, params.id, VIDEO_GRACE_SECONDS)
  if (!run) return
  const idx = flowIndex(run, params.idx)
  if (idx === null) return json(res, 404, { error: 'No such flow in this run' })
  const buf = await readBodyLimited(req, MAX_META_BYTES)
  if (buf === null) return json(res, 413, { error: 'Video metadata too large' })
  let meta: unknown
  try { meta = JSON.parse(buf.toString('utf-8')) } catch { meta = null }
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) {
    return json(res, 400, { error: 'Video metadata must be a JSON object' })
  }
  if ((meta as { formatVersion?: unknown }).formatVersion !== 1) {
    return json(res, 400, { error: 'Unsupported video format version' })
  }

  const db = getDb()
  // The row and its empty file in one synchronous transaction: nothing can delete the run between them, the orphan
  // sweep never sees a file without a row, and a file that cannot be created (a full disk, a permission) rolls the
  // row back — left behind, a retried open would answer 200 for a video every chunk then finds gone.
  const existing = findVideo(run.seq, idx)
  if (existing) {
    // An open retried after a timeout. The same video carries on; one that has ended is not reopened.
    if (existing.ended_at !== null || existing.evicted_at !== null) return json(res, 409, { error: 'Video already ended' })
    return json(res, 200, { ok: true, nextSeq: existing.next_seq })
  }
  fs.mkdirSync(videosDir, { recursive: true })
  const file = `${randomUUID()}.tfv`
  db.transaction(() => {
    db.prepare('INSERT INTO flow_run_videos (run_seq, idx, file, meta_json) VALUES (?, ?, ?, ?)')
      .run(run.seq, idx, file, JSON.stringify(meta))
    fs.writeFileSync(path.join(videosDir, file), '', { flag: 'wx' })
  })()
  json(res, 201, { ok: true, nextSeq: 0 })
}

/** The disk the videos live on: free bytes and the floor the relay keeps for itself. */
export interface DiskRoom { free: number; floor: number }

export function diskRoomFor(dir: string): DiskRoom {
  try {
    const st = fs.statfsSync(dir)
    const total = st.blocks * st.bsize
    return { free: st.bavail * st.bsize, floor: Math.max(MIN_FREE_BYTES, Math.floor(total * MIN_FREE_FRACTION)) }
  } catch {
    // A filesystem that cannot be asked is not reported as full; the cap still holds.
    return { free: Number.MAX_SAFE_INTEGER, floor: 0 }
  }
}

export function videoUsageBytes(): number {
  const { used, reserved } = videoUsage()
  return used + reserved
}

/** Committed bytes and bytes reserved by writes in flight, over the videos still kept. */
function videoUsage(): { used: number; reserved: number } {
  return getDb().prepare(`
    SELECT COALESCE(SUM(bytes), 0) AS used, COALESCE(SUM(reserved_bytes), 0) AS reserved FROM flow_run_videos WHERE evicted_at IS NULL
  `).get() as { used: number; reserved: number }
}

/**
 * A reservation lives only as long as the write holding it, and no write survives a restart: a crash between reserve
 * and release would otherwise count those bytes against the cap forever. Called once at start, before any write.
 */
export function releaseStaleVideoReservations(): void {
  getDb().prepare('UPDATE flow_run_videos SET reserved_bytes = 0 WHERE reserved_bytes != 0').run()
}

export function videoSettings(): { passRetentionDays: number; storageCapBytes: number } {
  const row = getDb().prepare('SELECT video_pass_retention_days, video_storage_cap_mb FROM team_settings WHERE id = 1')
    .get() as { video_pass_retention_days: number; video_storage_cap_mb: number } | undefined
  return {
    passRetentionDays: row?.video_pass_retention_days ?? 3,
    storageCapBytes: (row?.video_storage_cap_mb ?? 20480) * 1024 * 1024,
  }
}

/**
 * How far `len` more bytes would go past the cap and past the disk's floor; zero or less is room. Both count: the
 * cap is the operator's setting, the floor is what the disk can actually give. Reserved bytes count against the
 * floor too: they are not on disk yet, so free space does not show them, and two writers to different videos would
 * otherwise both see the same free space. Between a write landing and its release the same bytes count twice, once
 * in free space and once reserved: at most a chunk per writer, and on the side of keeping the floor.
 */
export function shortfall(
  usage: { used: number; reserved: number }, len: number, capBytes: number, room: DiskRoom,
): { overCap: number; overDisk: number } {
  return { overCap: usage.used + usage.reserved + len - capBytes, overDisk: usage.reserved + len - (room.free - room.floor) }
}

/**
 * Make room for `len` bytes, in the caller's transaction: evict ended videos of finished runs — passed flows
 * first, oldest first, then the rest — until both the cap and the disk floor allow it. Never a video still being
 * written. Returns the files to unlink once the transaction commits, or null when nothing more can go.
 */
function makeRoom(len: number, videosDir: string, room: DiskRoom, keep: { runSeq: number; idx: number }): string[] | null {
  const db = getDb()
  let { overCap, overDisk } = shortfall(videoUsage(), len, videoSettings().storageCapBytes, room)
  if (overCap <= 0 && overDisk <= 0) return []

  const candidates = db.prepare(`
    SELECT v.run_seq, v.idx, v.file, v.bytes, v.ended_at, r.status, r.finished_by, r.finished_at
      FROM flow_run_videos v
      JOIN flow_runs r ON r.seq = v.run_seq
      LEFT JOIN flow_run_flows f ON f.run_seq = v.run_seq AND f.idx = v.idx
     WHERE v.evicted_at IS NULL AND r.status != 'running'
     ORDER BY CASE WHEN f.status = 'passed' THEN 0 ELSE 1 END, v.created_at, v.run_seq, v.idx
  `).all() as (Pick<VideoRow, 'run_seq' | 'idx' | 'file' | 'bytes' | 'ended_at'> & Pick<RunRow, 'status' | 'finished_by' | 'finished_at'>)[]
  const evict = db.prepare(`UPDATE flow_run_videos SET evicted_at = datetime('now') WHERE run_seq = ? AND idx = ?`)
  const files: string[] = []
  for (const c of candidates) {
    if (overCap <= 0 && overDisk <= 0) break
    if (c.run_seq === keep.runSeq && c.idx === keep.idx) continue
    if (writing.has(`${c.run_seq}:${c.idx}`) || !videoEnded(c, c)) continue
    evict.run(c.run_seq, c.idx)
    files.push(path.join(videosDir, c.file))
    overCap -= c.bytes
    overDisk -= c.bytes
  }
  return overCap <= 0 && overDisk <= 0 ? files : null
}

export async function handleVideoChunk(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  params: Record<string, string>,
  videosDir: string,
  holders: RunHolders,
  diskRoom: (dir: string) => DiskRoom = diskRoomFor,
): Promise<void> {
  const run = ownRun(req, res, params.id, VIDEO_GRACE_SECONDS)
  if (!run) return
  const idx = flowIndex(run, params.idx)
  if (idx === null) return json(res, 404, { error: 'No such flow in this run' })
  if (!/^\d+$/.test(params.seq) || Number(params.seq) > MAX_SEQ) return json(res, 400, { error: `seq must be an integer from 0 to ${MAX_SEQ}` })
  const seq = Number(params.seq)
  const startRaw = String(req.headers['x-start-ms'] ?? '')
  if (!/^\d+$/.test(startRaw) || !Number.isSafeInteger(Number(startRaw))) return json(res, 400, { error: 'X-Start-Ms must be a non-negative integer' })
  const keyframe = req.headers['x-keyframe'] === '1' ? 1 : 0

  const pre = findVideo(run.seq, idx)
  if (!pre) return json(res, 404, { error: 'Open the video before sending chunks' })
  if (pre.evicted_at !== null) return json(res, 410, { error: 'Video no longer kept' })
  if (videoEnded(pre, run)) return json(res, 409, { error: 'Video already ended' })

  const buf = await readBodyLimited(req, MAX_CHUNK_BYTES)
  if (buf === null) return json(res, 413, { error: 'Chunk too large', reason: 'chunk-too-large' })
  if (buf.length === 0) return json(res, 400, { error: 'Empty chunk' })

  const key = `${run.seq}:${idx}`
  const db = getDb()
  await serialised(key, async () => {
    // Read again: the video, its run, or both may have changed while the body arrived or an earlier write ran.
    const video = findVideo(run.seq, idx)
    const current = findRun(params.id)
    if (!video || !current) return json(res, 404, { error: 'Run not found' })
    if (video.evicted_at !== null) return json(res, 410, { error: 'Video no longer kept' })
    // An end call is not serialised with the chunks, so one may have landed while this chunk waited its turn.
    if (videoEnded(video, current)) return json(res, 409, { error: 'Video already ended' })
    // A retry of a chunk already written, or one that arrived after a later chunk: the gap it left stays a gap.
    if (seq < video.next_seq) return json(res, 200, { ok: true, duplicate: true, nextSeq: video.next_seq })
    if (video.bytes + buf.length > MAX_VIDEO_BYTES) {
      db.prepare(`UPDATE flow_run_videos SET ended_at = datetime('now'), end_reason = 'size-limit' WHERE run_seq = ? AND idx = ?`).run(run.seq, idx)
      return json(res, 413, { error: 'Video reached its size limit', reason: 'size-limit' })
    }

    // **Check, evict and reserve in one synchronous transaction** — two videos must not both pass the cap.
    const room = diskRoom(videosDir)
    let offset = 0
    const toUnlink = db.transaction((): string[] | null => {
      settleOrphanedRuns(holders)
      const files = makeRoom(buf.length, videosDir, room, { runSeq: run.seq, idx })
      if (files === null) return null
      const row = findVideo(run.seq, idx)!
      offset = row.bytes
      db.prepare('UPDATE flow_run_videos SET reserved_bytes = reserved_bytes + ? WHERE run_seq = ? AND idx = ?').run(buf.length, run.seq, idx)
      return files
    })()
    if (toUnlink === null) {
      db.prepare(`UPDATE flow_run_videos SET ended_at = datetime('now'), end_reason = 'storage-full' WHERE run_seq = ? AND idx = ? AND ended_at IS NULL`).run(run.seq, idx)
      return json(res, 507, { error: 'Relay storage for videos is full', reason: 'storage-full' })
    }
    for (const f of toUnlink) unlinkSafe(f, 'evicted run video')

    // At the committed length, not appended: a write torn by a crash is overwritten by the next one. `r+` never
    // creates, so a write racing a delete cannot bring back a file no row names.
    const release = db.prepare('UPDATE flow_run_videos SET reserved_bytes = MAX(reserved_bytes - ?, 0) WHERE run_seq = ? AND idx = ?')
    let fh: fs.promises.FileHandle | undefined
    try {
      fh = await fs.promises.open(path.join(videosDir, video.file), 'r+')
      await writeFully(fh, buf, offset)
    } catch (e) {
      release.run(buf.length, run.seq, idx)
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return json(res, 410, { error: 'Video no longer kept' })
      throw e
    } finally {
      await fh?.close()
    }

    db.transaction(() => {
      release.run(buf.length, run.seq, idx)
      // Gone while the bytes were written (its run deleted, its file evicted): nothing to commit.
      if (!findVideo(run.seq, idx) || findVideo(run.seq, idx)!.evicted_at !== null) return
      db.prepare(`INSERT INTO flow_run_video_chunks (run_seq, idx, seq, offset, length, start_ms, keyframe) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(run.seq, idx, seq, offset, buf.length, Number(startRaw), keyframe)
      db.prepare(`UPDATE flow_run_videos SET bytes = ?, next_seq = ?, last_chunk_at = datetime('now') WHERE run_seq = ? AND idx = ?`)
        .run(offset + buf.length, seq + 1, run.seq, idx)
    })()
    json(res, 200, { ok: true, nextSeq: seq + 1 })
  })
}

/**
 * A write may land fewer bytes than asked (a disk filling up mid-write), and the chunk row records the whole length:
 * write the rest, and fail rather than commit a chunk whose tail is not there.
 */
export async function writeFully(fh: Pick<fs.promises.FileHandle, 'write'>, buf: Buffer, offset: number): Promise<void> {
  let done = 0
  while (done < buf.length) {
    const { bytesWritten } = await fh.write(buf, done, buf.length - done, offset + done)
    if (bytesWritten <= 0) throw new Error(`Video chunk write made no progress at ${offset + done}`)
    done += bytesWritten
  }
}

export async function handleEndVideo(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  params: Record<string, string>,
): Promise<void> {
  const run = ownRun(req, res, params.id, VIDEO_GRACE_SECONDS)
  if (!run) return
  const idx = flowIndex(run, params.idx)
  if (idx === null) return json(res, 404, { error: 'No such flow in this run' })
  const buf = await readBodyLimited(req, MAX_META_BYTES)
  if (buf === null) return json(res, 413, { error: 'Body too large' })
  let body: { lastSeq?: unknown; reason?: unknown } = {}
  try { body = JSON.parse(buf.toString('utf-8')) as typeof body } catch { /* answered below */ }
  const lastSeq = body.lastSeq
  if (!(lastSeq === -1 || (typeof lastSeq === 'number' && Number.isInteger(lastSeq) && lastSeq >= 0 && lastSeq <= MAX_SEQ))) {
    return json(res, 400, { error: `lastSeq must be -1 or an integer from 0 to ${MAX_SEQ}` })
  }
  if (typeof body.reason !== 'string' || !END_REASONS.has(body.reason)) return json(res, 400, { error: 'Unknown end reason' })
  const video = findVideo(run.seq, idx)
  if (!video) return json(res, 404, { error: 'No video for this flow' })
  // Idempotent, and the first ending wins: a size-limit or storage-full the relay decided is not overwritten.
  getDb().prepare(`
    UPDATE flow_run_videos SET ended_at = COALESCE(ended_at, datetime('now')), end_reason = COALESCE(end_reason, ?),
           end_last_seq = COALESCE(end_last_seq, ?)
     WHERE run_seq = ? AND idx = ?
  `).run(body.reason, lastSeq, run.seq, idx)
  json(res, 200, { ok: true })
}

// ── reads (anyone who may view) ─────────────────────────────────────────────

function readTarget(req: http.IncomingMessage, res: http.ServerResponse, params: Record<string, string>, holders: RunHolders) {
  if (!requireViewAuth(req, res)) return null
  settleOrphanedRuns(holders)
  const run = findRun(params.id)
  if (!run) { json(res, 404, { error: 'Run not found' }); return null }
  const idx = flowIndex(run, params.idx)
  const video = idx === null ? undefined : findVideo(run.seq, idx)
  if (!video) { json(res, 404, { error: 'No video for this flow' }); return null }
  return { run, video }
}

function endReasonOf(video: VideoRow, run: RunRow, ended: boolean): string | null {
  return video.end_reason ?? (ended && video.ended_at === null ? (run.finished_by === 'relay' ? 'runner-lost' : 'truncated') : null)
}

/** What the run page needs to know about each flow's video before it loads one: whether there is one, and its state. */
export interface VideoSummary {
  ended: boolean
  endReason: string | null
  evicted: boolean
  /** Set when the runner opened the video only to say it could not keep it (`jpeg`, `no-keyframe`). */
  notRecorded: string | null
  bytes: number
}

/** Each flow's video by flow index, for `GET /api/v1/runs/:id`. Passed in by the server so runs.ts needs no import of this file. */
export function videoSummaries(run: RunRow): Map<number, VideoSummary> {
  const rows = getDb().prepare('SELECT * FROM flow_run_videos WHERE run_seq = ?').all(run.seq) as VideoRow[]
  return new Map(rows.map((v) => {
    const ended = videoEnded(v, run)
    let notRecorded: string | null = null
    try {
      const meta = JSON.parse(v.meta_json) as { notRecorded?: unknown }
      if (typeof meta.notRecorded === 'string') notRecorded = meta.notRecorded
    } catch { /* the open call's JSON was validated when stored */ }
    return [v.idx, { ended, endReason: endReasonOf(v, run, ended), evicted: v.evicted_at !== null, notRecorded, bytes: v.bytes }]
  }))
}

/** The player's map of the video: its metadata, where each chunk lies, which seqs never arrived, and its state. */
export function handleVideoIndex(req: http.IncomingMessage, res: http.ServerResponse, params: Record<string, string>, holders: RunHolders): void {
  const t = readTarget(req, res, params, holders)
  if (!t) return
  const { run, video } = t
  const chunks = getDb().prepare(`
    SELECT seq, offset, length, start_ms, keyframe FROM flow_run_video_chunks WHERE run_seq = ? AND idx = ? ORDER BY seq
  `).all(run.seq, video.idx) as { seq: number; offset: number; length: number; start_ms: number; keyframe: number }[]
  const present = new Set(chunks.map((c) => c.seq))
  const last = Math.max(video.next_seq - 1, video.end_last_seq ?? -1)
  const gaps: number[] = []
  for (let s = 0; s <= last; s++) if (!present.has(s)) gaps.push(s)
  const ended = videoEnded(video, run)
  json(res, 200, {
    meta: JSON.parse(video.meta_json) as unknown,
    bytes: video.bytes,
    ended,
    endReason: endReasonOf(video, run, ended),
    evicted: video.evicted_at !== null,
    chunks: chunks.map((c) => ({ seq: c.seq, offset: c.offset, length: c.length, startMs: c.start_ms, keyframe: c.keyframe === 1 })),
    gaps,
  })
}

/** The bytes, by range, never past the committed length: a growing video is read while it is written. */
export function handleVideoData(req: http.IncomingMessage, res: http.ServerResponse, params: Record<string, string>, holders: RunHolders, videosDir: string): void {
  const t = readTarget(req, res, params, holders)
  if (!t) return
  const { run, video } = t
  if (video.evicted_at !== null) return json(res, 410, { error: 'Video no longer kept' })
  const size = video.bytes
  let start = 0
  let end = size - 1
  const range = req.headers.range
  if (range) {
    const m = /^bytes=(\d+)-(\d*)$/.exec(range)
    if (!m || Number(m[1]) >= size) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` })
      return void res.end()
    }
    start = Number(m[1])
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1)
    if (end < start) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` })
      return void res.end()
    }
  }
  const ended = videoEnded(video, run)
  const headers: http.OutgoingHttpHeaders = {
    'Content-Type': 'application/octet-stream',
    'X-Content-Type-Options': 'nosniff',
    'Content-Disposition': 'attachment',
    'Accept-Ranges': 'bytes',
    // A video still being written must not be cached as it was; an ended one is fixed by its committed length.
    'Cache-Control': ended ? 'private, max-age=3600' : 'no-store',
    ...(ended ? { ETag: `"${size}"` } : {}),
  }
  if (size === 0) {
    res.writeHead(200, { ...headers, 'Content-Length': 0 })
    return void res.end()
  }
  const stream = fs.createReadStream(path.join(videosDir, video.file), { start, end })
  stream.once('open', () => {
    res.writeHead(range ? 206 : 200, {
      ...headers,
      'Content-Length': end - start + 1,
      ...(range ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}),
    })
    stream.pipe(res)
  })
  stream.once('error', (e) => {
    if (res.headersSent) return void res.destroy()
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return json(res, 410, { error: 'Video no longer kept' })
    json(res, 500, { error: 'Could not read the video' })
  })
}

// ── retention (the daily purge) ─────────────────────────────────────────────

/**
 * Passed flows' videos past the retention window go; files no live row names (a runner killed mid-open, a crash)
 * are swept; rows whose file is gone (a restored database) are marked evicted, so usage stops counting them.
 */
export function purgeRunVideos(videosDir: string, holders: RunHolders): void {
  settleOrphanedRuns(holders)
  const db = getDb()
  const { passRetentionDays } = videoSettings()
  const expired = db.prepare(`
    SELECT v.run_seq, v.idx, v.file, v.ended_at, r.status, r.finished_by, r.finished_at
      FROM flow_run_videos v
      JOIN flow_runs r ON r.seq = v.run_seq
      JOIN flow_run_flows f ON f.run_seq = v.run_seq AND f.idx = v.idx
     WHERE v.evicted_at IS NULL AND r.status != 'running' AND f.status = 'passed' AND v.created_at < datetime('now', ?)
  `).all(`-${passRetentionDays} days`) as (Pick<VideoRow, 'run_seq' | 'idx' | 'file' | 'ended_at'> & Pick<RunRow, 'status' | 'finished_by' | 'finished_at'>)[]
  const evict = db.prepare(`UPDATE flow_run_videos SET evicted_at = datetime('now') WHERE run_seq = ? AND idx = ?`)
  const files: string[] = []
  db.transaction(() => {
    for (const v of expired) {
      if (writing.has(`${v.run_seq}:${v.idx}`) || !videoEnded(v, v)) continue
      evict.run(v.run_seq, v.idx)
      files.push(v.file)
    }
  })()
  for (const f of files) unlinkSafe(path.join(videosDir, f), 'run video')

  let onDisk: string[] = []
  // No directory is what a restore that left the videos out produces: every live row is then missing its file. Any
  // other failure says nothing about the files, and must not mark every video gone.
  try {
    onDisk = fs.readdirSync(videosDir)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') return
  }
  const live = new Set((db.prepare('SELECT file FROM flow_run_videos WHERE evicted_at IS NULL').all() as { file: string }[]).map((r) => r.file))
  for (const f of onDisk) if (!live.has(f)) unlinkSafe(path.join(videosDir, f), 'orphaned run video')
  const present = new Set(onDisk)
  const missing = db.prepare(`UPDATE flow_run_videos SET evicted_at = datetime('now') WHERE file = ? AND evicted_at IS NULL`)
  for (const f of live) if (!present.has(f)) missing.run(f)
}
