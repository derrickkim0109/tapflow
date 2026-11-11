// files attached to a run record by `tapflow maestro` — the
// screenshots a Maestro flow took and Maestro's log. A run record has room for one screenshot per flow; a Maestro
// flow takes several, and its log is the only account of what Maestro did.
//
// **No table** (no migration for a fork extension). A run's files live in a folder named by its id, and the folder
// goes when the run does: folders of runs that no longer exist are removed on an upload and every hour, which covers
// every way a run is deleted (with its build, by its own expiry) without a hook in the code that deletes them.
import http from 'http'
import fs from 'fs'
import path from 'path'
import { getDb } from '../db.js'
import { requireViewAuth } from '../middleware/auth.js'
import { json, readBodyLimited, type Router } from '../router.js'
import { findRun, ownRun } from '../api/runs.js'

const MAX_IMAGE_BYTES = 5 * 1024 * 1024
const MAX_LOG_BYTES = 10 * 1024 * 1024
const MAX_FILES = 100
/** All of one run's files together — a token that may write runs must not be able to fill the disk through one. */
const MAX_RUN_BYTES = 200 * 1024 * 1024
/** Logs per run: a Maestro run attaches one. */
const MAX_LOGS = 3
/** How often folders of deleted runs are looked for, on uploads and on the timer. */
const SWEEP_EVERY_MS = 60 * 60 * 1000

/** Plain names only: no path, nothing hidden. The CLI folds Maestro's names into this. */
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/
const KINDS: Record<string, { mime: string; kind: 'image' | 'log'; max: number }> = {
  '.png': { mime: 'image/png', kind: 'image', max: MAX_IMAGE_BYTES },
  '.jpg': { mime: 'image/jpeg', kind: 'image', max: MAX_IMAGE_BYTES },
  '.jpeg': { mime: 'image/jpeg', kind: 'image', max: MAX_IMAGE_BYTES },
  '.log': { mime: 'text/plain; charset=utf-8', kind: 'log', max: MAX_LOG_BYTES },
  '.txt': { mime: 'text/plain; charset=utf-8', kind: 'log', max: MAX_LOG_BYTES },
}
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff])

/** Beside `run-screenshots/`, under the same data directory. */
export function maestroRunArtifactsDirFor(runScreenshotsDir: string): string {
  return path.join(runScreenshotsDir, '../maestro-run-artifacts')
}

function kindOf(name: string): (typeof KINDS)[string] | null {
  if (!NAME.test(name)) return null
  return KINDS[path.extname(name).toLowerCase()] ?? null
}

/** What the bytes are must match what the name says: the file is served back to browsers by that name. */
function bytesMatch(kind: (typeof KINDS)[string], name: string, buf: Buffer): boolean {
  if (kind.kind === 'log') return !buf.includes(0)
  return path.extname(name).toLowerCase() === '.png'
    ? buf.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)
    : buf.subarray(0, JPEG_MAGIC.length).equals(JPEG_MAGIC)
}

/** Remove the folders of runs that are gone. Run ids are UUIDs, so a folder name that is not one is left alone. */
const lastSweep = new Map<string, number>()
function sweepNow(dir: string, now = Date.now()): void {
  if (now - (lastSweep.get(dir) ?? 0) < SWEEP_EVERY_MS) return
  lastSweep.set(dir, now)
  sweepOrphanArtifacts(dir)
}

export function sweepOrphanArtifacts(dir: string): void {
  let entries: string[]
  try { entries = fs.readdirSync(dir) } catch { return }
  const exists = getDb().prepare('SELECT 1 FROM flow_runs WHERE id = ?')
  for (const id of entries) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) continue
    if (!exists.get(id)) fs.rmSync(path.join(dir, id), { recursive: true, force: true })
  }
}

export async function handleUploadRunArtifact(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  params: Record<string, string>,
  dir: string,
): Promise<void> {
  const run = ownRun(req, res, params.id)
  if (!run) return
  const name = params.name
  const kind = kindOf(name)
  if (!kind) return json(res, 400, { error: 'Name must be letters, digits, ".", "_" or "-" ending in .png, .jpg, .jpeg, .log or .txt' })
  const buf = await readBodyLimited(req, kind.max)
  if (buf === null) return json(res, 413, { error: `Larger than ${kind.max} bytes` })
  if (!bytesMatch(kind, name, buf)) return json(res, 415, { error: `Content is not ${kind.kind === 'log' ? 'text' : path.extname(name).slice(1).toUpperCase()}` })

  sweepNow(dir)
  const runDir = path.join(dir, run.id)
  fs.mkdirSync(runDir, { recursive: true })
  const existing = fs.readdirSync(runDir).filter((n) => n !== name)
  if (existing.length >= MAX_FILES) return json(res, 409, { error: `A run keeps at most ${MAX_FILES} files` })
  if (kind.kind === 'log' && existing.filter((n) => kindOf(n)?.kind === 'log').length >= MAX_LOGS) {
    return json(res, 409, { error: `A run keeps at most ${MAX_LOGS} logs` })
  }
  const used = existing.reduce((n, f) => { try { return n + fs.statSync(path.join(runDir, f)).size } catch { return n } }, 0)
  if (used + buf.length > MAX_RUN_BYTES) return json(res, 413, { error: `A run keeps at most ${MAX_RUN_BYTES} bytes of files` })
  await fs.promises.writeFile(path.join(runDir, name), buf)
  // The run may have been deleted while the body arrived; its folder must not outlive it.
  if (!findRun(run.id)) {
    fs.rmSync(runDir, { recursive: true, force: true })
    return json(res, 404, { error: 'Run not found' })
  }
  json(res, 200, { ok: true })
}

export function handleListRunArtifacts(req: http.IncomingMessage, res: http.ServerResponse, params: Record<string, string>, dir: string): void {
  if (!requireViewAuth(req, res)) return
  if (!findRun(params.id)) return json(res, 404, { error: 'Run not found' })
  let names: string[] = []
  try { names = fs.readdirSync(path.join(dir, params.id)) } catch { /* nothing attached */ }
  const items = names
    .filter((n) => kindOf(n))
    .map((n) => {
      const stat = fs.statSync(path.join(dir, params.id, n))
      return { name: n, kind: kindOf(n)!.kind, bytes: stat.size, mtimeMs: stat.mtimeMs }
    })
    // In the order they were written, which is the order the flow took them.
    .sort((a, b) => a.mtimeMs - b.mtimeMs)
    .map(({ name, kind, bytes }) => ({ name, kind, bytes }))
  json(res, 200, { items })
}

export function handleGetRunArtifact(req: http.IncomingMessage, res: http.ServerResponse, params: Record<string, string>, dir: string): void {
  if (!requireViewAuth(req, res)) return
  const kind = kindOf(params.name)
  if (!kind || !findRun(params.id)) return json(res, 404, { error: 'Not found' })
  let data: Buffer
  try {
    data = fs.readFileSync(path.join(dir, params.id, params.name))
  } catch {
    return json(res, 404, { error: 'Not found' })
  }
  res.writeHead(200, {
    'Content-Type': kind.mime,
    'Content-Length': data.length,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'private, max-age=3600',
  })
  res.end(data)
}

/** The routes, registered from one line in `RelayServer.ts` after the run routes. */
export function registerMaestroRunArtifacts(router: Router, runScreenshotsDir: string): void {
  const dir = maestroRunArtifactsDirFor(runScreenshotsDir)
  // Runs deleted while nobody attaches anything still lose their files within the hour.
  setInterval(() => { try { sweepOrphanArtifacts(dir) } catch { /* database closed: the relay is stopping */ } }, SWEEP_EVERY_MS).unref()
  router.get('/api/v1/maestro/runs/:id/artifacts', (req, res, params) => handleListRunArtifacts(req, res, params, dir))
  router.post('/api/v1/maestro/runs/:id/artifacts/:name', (req, res, params) => handleUploadRunArtifact(req, res, params, dir))
  router.get('/api/v1/maestro/runs/:id/artifacts/:name', (req, res, params) => handleGetRunArtifact(req, res, params, dir))
}
