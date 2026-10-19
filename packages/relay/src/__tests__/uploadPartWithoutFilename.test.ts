import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'http'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { RelayServer } from '../RelayServer'
import { initDb, getDb, closeDb } from '../db'
import { makePasswordHash } from '../api/auth'
import { signJwt } from '../middleware/auth'

// busboy treats a part with no `filename` as a file when its content type is `application/octet-stream`, and hands
// the 'file' handler `filename: undefined` (@types/busboy says so since 1.5.5). The upload handler read it as a
// string, so `buildFileKind(undefined)` threw inside busboy's event and the upload was answered 500, not refused.

function postPart(port: number, cookie: string): Promise<{ status: number; body: { error?: string } }> {
  const boundary = 'tapflow-no-filename'
  const body = Buffer.from([
    `--${boundary}`,
    'Content-Disposition: form-data; name="file"',
    'Content-Type: application/octet-stream',
    '',
    'not a build',
    `--${boundary}--`,
    '',
  ].join('\r\n'))
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, path: '/api/v1/builds', method: 'POST', timeout: 5000,
        headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': body.length, Cookie: cookie } },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => resolve({ status: res.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString() || '{}') as { error?: string } }))
      },
    )
    req.on('timeout', () => req.destroy(new Error('no answer within 5s')))
    req.on('error', reject)
    req.end(body)
  })
}

describe('POST /api/v1/builds — a file part with no filename', () => {
  let server: RelayServer
  let port: number
  let tmpDir: string
  let uploadsDir: string
  let cookie: string

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-no-filename-'))
    uploadsDir = path.join(tmpDir, 'uploads')
    fs.mkdirSync(uploadsDir)
    initDb(path.join(tmpDir, 'test.db'))
    getDb().prepare('INSERT INTO users (email, display_name, role, password_hash) VALUES (?, ?, ?, ?)')
      .run('admin@example.com', 'Admin', 'Admin', makePasswordHash('password123'))
    cookie = `tapflow_token=${signJwt({ userId: 1, email: 'admin@example.com', role: 'Admin' })}`
    server = new RelayServer({ port: 0, uploadsDir })
    await server.start()
    port = (server.address() as { port: number }).port
  })

  afterAll(async () => {
    await server.stop()
    closeDb()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('is refused as an unsupported file, and nothing is saved', async () => {
    const r = await postPart(port, cookie)
    expect(r.status).toBe(400)
    expect(r.body.error).toBe('Only .app.zip / .tar.gz (iOS) or .apk (Android) files allowed')
    expect(fs.readdirSync(uploadsDir)).toEqual([])
  })
})
