import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import fs from 'fs'
import http from 'http'
import os from 'os'
import path from 'path'
import WebSocket from 'ws'
import { RelayServer } from '../RelayServer'
import { initDb, getDb, closeDb } from '../db'
import { makePasswordHash } from '../api/auth'
import { signJwt } from '../middleware/auth'

// An upload that ends early ends that request and nothing else. The upload handlers listened on the
// multipart parser but not on each file's stream, and a stream with no `'error'` listener throws.

interface UploadRoute { method: 'POST' | 'PATCH'; path: string; field: string; filename: string; mimeType: string; signedIn: boolean }

// One row per handler that reads a file part. Each file passes its handler's type check, so the stream is
// written rather than drained.
const ROUTES: UploadRoute[] = [
  { method: 'POST', path: '/api/v1/invitations/accept', field: 'avatar', filename: 'a.png', mimeType: 'image/png', signedIn: false },
  { method: 'PATCH', path: '/api/v1/profile', field: 'avatar', filename: 'a.png', mimeType: 'image/png', signedIn: true },
  { method: 'PATCH', path: '/api/v1/settings', field: 'logo', filename: 'a.png', mimeType: 'image/png', signedIn: true },
  { method: 'POST', path: '/api/v1/comments', field: 'attachment', filename: 'a.png', mimeType: 'image/png', signedIn: true },
  { method: 'POST', path: '/api/v1/builds', field: 'file', filename: 'a.apk', mimeType: 'application/vnd.android.package-archive', signedIn: true },
  { method: 'POST', path: '/api/v1/recordings/upload', field: 'file', filename: 'a.webm', mimeType: 'video/webm', signedIn: true },
]

/** Sends the upload to `route`; resolves once the request is over. */
function sendTruncatedUpload(port: number, route: UploadRoute, cookie: string): Promise<void> {
  const boundary = '----tapflowtruncated'
  // A file part that is opened and never closed: no closing boundary follows the bytes.
  const body = Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="${route.field}"; filename="${route.filename}"\r\n` +
    `Content-Type: ${route.mimeType}\r\n\r\n` +
    'partial-bytes',
  )
  return new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1', port, path: route.path, method: route.method,
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        ...(route.signedIn ? { Cookie: cookie } : {}),
      },
    }, (res) => { res.resume(); res.on('end', () => resolve()) })
    // The relay may reply before reading the rest, or drop the socket; either way the request is over.
    req.on('error', () => resolve())
    req.on('close', () => resolve())
    req.end(body)
  })
}

function connects(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`)
    ws.on('open', () => { ws.close(); resolve(true) })
    ws.on('error', () => resolve(false))
  })
}

describe('RelayServer — an upload that ends early', () => {
  let tmpDir: string
  let cookie: string
  let server: RelayServer | null = null
  const uncaught: unknown[] = []
  const onUncaught = (err: unknown) => { uncaught.push(err) }

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-multipart-'))
    initDb(path.join(tmpDir, 'test.db'))
    // An Admin passes every role check on these routes, so each request reaches its file part.
    getDb().prepare('INSERT INTO users (email, display_name, role, password_hash) VALUES (?, ?, ?, ?)')
      .run('admin@example.com', 'Admin', 'Admin', makePasswordHash('password123'))
    cookie = `tapflow_token=${signJwt({ userId: 1, email: 'admin@example.com', role: 'Admin' })}`
    process.on('uncaughtException', onUncaught)
  })
  afterAll(() => {
    process.off('uncaughtException', onUncaught)
    closeDb()
    fs.rmSync(tmpDir, { recursive: true })
  })
  afterEach(async () => { await server?.stop(); server = null; uncaught.length = 0 })

  it.each(ROUTES)('$method $path survives an upload that ends inside a file part, and keeps serving', async (route) => {
    server = new RelayServer({ port: 0, uploadsDir: path.join(tmpDir, 'uploads') })
    await server.start()
    const port = (server.address() as { port: number }).port

    await sendTruncatedUpload(port, route, cookie)
    await new Promise((r) => setTimeout(r, 50))

    expect(uncaught, 'the error escaped the file stream').toEqual([])
    expect(await connects(port), 'the relay stopped serving').toBe(true)
  })
})
