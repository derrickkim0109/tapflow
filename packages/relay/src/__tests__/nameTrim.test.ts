import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'http'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { RelayServer } from '../RelayServer'
import { initDb, getDb, closeDb } from '../db'
import { makePasswordHash } from '../api/auth'
import { signJwt } from '../middleware/auth'

// A nickname of only spaces used to be stored as it was, and every reader falls back to the email's local
// part on NULL only — so the person showed as a blank name and a blank avatar circle. The team name had the
// same gap and showed blank in the sidebar.

function request(port: number, method: string, urlPath: string, cookie: string, body?: Buffer, boundary?: string): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string | number> = { Cookie: cookie }
    if (body && boundary) { headers['Content-Type'] = `multipart/form-data; boundary=${boundary}`; headers['Content-Length'] = body.length }
    const req = http.request({ hostname: '127.0.0.1', port, path: urlPath, method, headers }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString() || '{}') }))
    })
    req.on('error', reject)
    req.end(body)
  })
}

function fieldBody(boundary: string, name: string, value: string): Buffer {
  return Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n--${boundary}--\r\n`)
}

describe('names are stored trimmed', () => {
  let server: RelayServer
  let port: number
  let tmpDir: string
  let cookie: string

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-profile-name-'))
    initDb(path.join(tmpDir, 'test.db'))
    getDb().prepare('INSERT INTO users (email, display_name, role, password_hash) VALUES (?, ?, ?, ?)')
      .run('jo@example.com', 'Jo', 'Admin', makePasswordHash('password123'))
    cookie = `tapflow_token=${signJwt({ userId: 1, email: 'jo@example.com', role: 'Admin' })}`
    server = new RelayServer({ port: 0, uploadsDir: path.join(tmpDir, 'uploads') })
    await server.start()
    port = (server.address() as { port: number }).port
  })

  afterAll(async () => {
    await server?.stop()
    closeDb()
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  async function save(value: string): Promise<unknown> {
    const r = await request(port, 'PATCH', '/api/v1/profile', cookie, fieldBody('nick', 'display_name', value), 'nick')
    expect(r.status).toBe(200)
    return (await request(port, 'GET', '/api/v1/auth/me', cookie)).body.displayName
  }

  it('a nickname of only spaces falls back to the email local part', async () => {
    expect(await save('   ')).toBe('jo')
  })

  it('surrounding spaces are not kept', async () => {
    expect(await save('  Duchan  ')).toBe('Duchan')
  })

  async function saveTeam(value: string): Promise<unknown> {
    const r = await request(port, 'PATCH', '/api/v1/settings', cookie, fieldBody('team', 'team_name', value), 'team')
    expect(r.status).toBe(200)
    return (await request(port, 'GET', '/api/v1/settings', cookie)).body.team_name
  }

  it('a team name of only spaces leaves the current one', async () => {
    expect(await saveTeam('  QA Team  ')).toBe('QA Team')
    expect(await saveTeam('   ')).toBe('QA Team')
  })
})
