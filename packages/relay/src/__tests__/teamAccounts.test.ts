import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import http from 'http'
import os from 'os'
import path from 'path'
import Database from 'better-sqlite3'
import { RelayServer } from '../RelayServer'
import { initDb, closeDb, getDb } from '../db'
import { signJwt } from '../middleware/auth'
import { createAdminAccount, makePasswordHash } from '../lib/adminAccount'
import { normalizeEmail } from '../lib/email'
import { config } from '../lib/config'

// An invitation creates an account and never changes one; addresses are compared normalized; an Admin
// gets a reset link to hand over; and any password change ends the sessions issued before it.
//
// Mutations, each caught here:
// - the `isMemberEmail` check removed from invite → "inviting a member" cases; from accept → the accept case
// - the normalized exact lookup dropped from login, or tried before the exact one → "when one of a pair is already normalized"
// - the collision guard dropped from migration 014 → the migration case (the relay fails to boot)
// - earlier tokens not spent in `issuePasswordReset` → "only the newest link works"
// - `sessionCookie` removed from change-password → "keeps this browser signed in"
// - the token DELETE removed from `handleDoReset` → "a reset revokes every personal access token"
// - the `pwv` comparison removed from `getAuth` → the three "password change" cases
// The socket half (`revalidatePrincipal`, `onAuthChanged` on reset and change) is in authRevalidation.test.ts.

const mail = vi.hoisted(() => ({ result: true }))
vi.mock('../lib/mailer.js', () => ({ sendMail: vi.fn(async () => mail.result) }))
const { sendMail } = await import('../lib/mailer.js')

interface Res { status: number; body: Record<string, unknown>; setCookie: string | undefined }

function request(port: number, method: string, pathname: string, payload?: unknown, cookie?: string): Promise<Res> {
  const data = payload === undefined ? undefined : JSON.stringify(payload)
  const headers: Record<string, string> = {}
  if (data !== undefined) headers['Content-Type'] = 'application/json'
  if (cookie) headers.cookie = cookie
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method, headers }, (res) => {
      let text = ''
      res.on('data', (c) => { text += c })
      res.on('end', () => resolve({
        status: res.statusCode ?? 0,
        body: text ? JSON.parse(text) as Record<string, unknown> : {},
        setCookie: res.headers['set-cookie']?.[0]?.split(';')[0],
      }))
    })
    req.on('error', reject)
    req.end(data)
  })
}

function acceptInvite(port: number, token: string): Promise<Res> {
  const boundary = 'team-accounts'
  const body = Buffer.from(
    [['token', token], ['password', 'password123']]
      .map(([k, v]) => `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`).join('') + `--${boundary}--\r\n`,
  )
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, path: '/api/v1/invitations/accept', method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': body.length },
    }, (res) => {
      let text = ''
      res.on('data', (c) => { text += c })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(text || '{}') as Record<string, unknown>, setCookie: res.headers['set-cookie']?.[0] }))
    })
    req.on('error', reject)
    req.end(body)
  })
}

describe('normalizeEmail', () => {
  it('trims spaces and lowercases ASCII only — the same function as SQLite lower(trim())', () => {
    expect(normalizeEmail('  Alice@Example.COM ')).toBe('alice@example.com')
    // Wider than SQLite would make the migration and the lookup disagree about these.
    expect(normalizeEmail('Élise@x.com')).toBe('Élise@x.com')
    expect(normalizeEmail('\talice@x.com')).toBe('\talice@x.com')
    const db = new Database(':memory:')
    for (const raw of ['  Alice@Example.COM ', 'Élise@X.com', '\tBob@x.com']) {
      const { v } = db.prepare('SELECT lower(trim(?)) AS v').get(raw) as { v: string }
      expect(normalizeEmail(raw)).toBe(v)
    }
    db.close()
  })
})

describe('team accounts', () => {
  let tmpDir: string
  let server: RelayServer
  let port: number
  const savedRelayUrl = config.relay.url
  const admin = () => `tapflow_token=${signJwt({ userId: 1, email: 'admin@test.local', role: 'Admin' })}`

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-team-accounts-'))
    initDb(path.join(tmpDir, 'test.db'))
  })
  afterAll(() => {
    closeDb()
    fs.rmSync(tmpDir, { recursive: true })
    config.relay.url = savedRelayUrl
  })
  beforeEach(async () => {
    const db = getDb()
    db.prepare('DELETE FROM invitations').run()
    db.prepare('DELETE FROM personal_access_tokens').run()
    db.prepare('DELETE FROM users').run()
    db.prepare("INSERT INTO users (id, email, display_name, role, password_hash) VALUES (1, 'admin@test.local', 'Admin', 'Admin', ?)").run(makePasswordHash('admin-password'))
    db.prepare("INSERT INTO users (id, email, display_name, role, password_hash) VALUES (2, 'alice@test.local', 'Alice', 'QA', ?)").run(makePasswordHash('alice-password'))
    vi.mocked(sendMail).mockClear()
    mail.result = true
    config.relay.url = 'https://relay.example.com'
    server = new RelayServer({ port: 0 })
    await server.start()
    port = (server.address() as { port: number }).port
  })
  afterEach(async () => { await server.stop() })

  describe('inviting', () => {
    it('refuses an address that is already a member, however it is written, and mails nothing', async () => {
      for (const email of ['alice@test.local', '  ALICE@Test.local ']) {
        const r = await request(port, 'POST', '/api/v1/team/invite', { email, role: 'Admin' }, admin())
        expect(r.status, email).toBe(409)
      }
      expect(getDb().prepare('SELECT COUNT(*) AS n FROM invitations').get()).toEqual({ n: 0 })
      expect(sendMail).not.toHaveBeenCalled()
    })

    it('stores and mails a new address normalized', async () => {
      const r = await request(port, 'POST', '/api/v1/team/invite', { email: ' Bob@Test.local ', role: 'QA' }, admin())
      expect(r.status).toBe(201)
      expect(getDb().prepare('SELECT email FROM invitations').get()).toEqual({ email: 'bob@test.local' })
      expect(vi.mocked(sendMail).mock.calls[0]?.[0]).toBe('bob@test.local')
    })

    it('still creates an invitation with no address', async () => {
      expect((await request(port, 'POST', '/api/v1/team/invite', { role: 'QA' }, admin())).status).toBe(201)
    })

    it('an invitation whose address joined since is refused on accept, and changes nothing', async () => {
      const r = await request(port, 'POST', '/api/v1/team/invite', { email: 'carol@test.local', role: 'Admin' }, admin())
      getDb().prepare("INSERT INTO users (email, display_name, role, password_hash) VALUES ('Carol@test.local', 'Carol', 'Viewer', 'h')").run()
      const accepted = await acceptInvite(port, r.body.token as string)
      expect(accepted.status).toBe(409)
      expect(accepted.setCookie).toBeUndefined()
      expect(getDb().prepare("SELECT role, password_hash FROM users WHERE email = 'Carol@test.local'").get()).toEqual({ role: 'Viewer', password_hash: 'h' })
      expect(getDb().prepare('SELECT used_at FROM invitations').get()).toEqual({ used_at: null })
    })
  })

  describe('signing in', () => {
    it('signs in whatever the case or surrounding spaces of the address', async () => {
      const r = await request(port, 'POST', '/api/v1/auth/login', { email: ' ALICE@test.local', password: 'alice-password' })
      expect(r.status).toBe(200)
    })

    it('a pair that differs only in case signs in by the exact address, and neither by an ambiguous one', async () => {
      const db = getDb()
      db.prepare("UPDATE users SET email = 'Dup@test.local' WHERE id = 2").run()
      db.prepare("INSERT INTO users (id, email, display_name, role, password_hash) VALUES (3, 'DUP@test.local', 'D', 'QA', ?)").run(makePasswordHash('dup-password'))
      expect((await request(port, 'POST', '/api/v1/auth/login', { email: 'DUP@test.local', password: 'dup-password' })).status).toBe(200)
      expect((await request(port, 'POST', '/api/v1/auth/login', { email: 'Dup@test.local', password: 'alice-password' })).status).toBe(200)
      expect((await request(port, 'POST', '/api/v1/auth/login', { email: 'dup@test.local', password: 'dup-password' })).status).toBe(401)
    })

    it('when one of a pair is already normalized, any spelling of it signs in to that one', async () => {
      getDb().prepare("INSERT INTO users (id, email, display_name, role, password_hash) VALUES (3, 'Alice@test.local', 'A', 'QA', 'h')").run()
      expect((await request(port, 'POST', '/api/v1/auth/login', { email: 'ALICE@test.local', password: 'alice-password' })).status).toBe(200)
      // The other row's own exact address still reaches that row, not its normalized sibling.
      getDb().prepare('UPDATE users SET password_hash = ? WHERE id = 3').run(makePasswordHash('other-password'))
      expect((await request(port, 'POST', '/api/v1/auth/login', { email: 'Alice@test.local', password: 'other-password' })).status).toBe(200)
    })

    it('names, at start, the accounts that differ only in case', async () => {
      getDb().prepare("INSERT INTO users (id, email, display_name, role, password_hash) VALUES (3, 'Alice@test.local', 'A', 'QA', 'h')").run()
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const second = new RelayServer({ port: 0 })
      try {
        await second.start()
        expect(warn.mock.calls.flat().join(' ')).toMatch(/Accounts (2,3|3,2) differ only in letter case or spaces \(alice@test\.local\)/)
      } finally {
        warn.mockRestore()
        await second.stop()
      }
    })

    it('both first-admin paths store the same address (#715)', () => {
      getDb().prepare('DELETE FROM users').run()
      expect(createAdminAccount('  Owner@Test.local ', 'owner-password')).toBe('ok')
      expect(getDb().prepare('SELECT email FROM users').get()).toEqual({ email: 'owner@test.local' })
    })
  })

  describe('reset links', () => {
    it('returns the link and its token to the Admin, and mails it when mail works', async () => {
      const r = await request(port, 'POST', '/api/v1/team/members/2/send-reset', undefined, admin())
      expect(r.status).toBe(200)
      expect(r.body.emailSent).toBe(true)
      expect(r.body.resetUrl).toBe(`https://relay.example.com/reset-password?token=${r.body.token as string}`)
      expect(vi.mocked(sendMail).mock.calls[0]?.[2]).toContain(r.body.resetUrl as string)
    })

    it('without mail the link still works', async () => {
      mail.result = false
      const r = await request(port, 'POST', '/api/v1/team/members/2/send-reset', undefined, admin())
      expect(r.body.emailSent).toBe(false)
      expect((await request(port, 'POST', '/api/v1/auth/reset-password', { token: r.body.token, password: 'fresh-password' })).status).toBe(200)
      expect((await request(port, 'POST', '/api/v1/auth/login', { email: 'alice@test.local', password: 'fresh-password' })).status).toBe(200)
    })

    it('with only a loopback address the URL is null and the token is still returned', async () => {
      config.relay.url = null
      const r = await request(port, 'POST', '/api/v1/team/members/2/send-reset', undefined, admin())
      expect(r.body.resetUrl).toBeNull()
      expect(typeof r.body.token).toBe('string')
    })

    it('does not report mail as sent to the placeholder address of a member invited without one', async () => {
      getDb().prepare("UPDATE users SET email = 'user_ab12cd34@tapflow.local' WHERE id = 2").run()
      const r = await request(port, 'POST', '/api/v1/team/members/2/send-reset', undefined, admin())
      expect(r.body.emailSent).toBe(false)
      expect(sendMail).not.toHaveBeenCalled()
    })

    it('only the newest link works', async () => {
      const first = await request(port, 'POST', '/api/v1/team/members/2/send-reset', undefined, admin())
      const second = await request(port, 'POST', '/api/v1/team/members/2/send-reset', undefined, admin())
      expect((await request(port, 'POST', '/api/v1/auth/reset-password', { token: first.body.token, password: 'fresh-password' })).status).toBe(410)
      expect((await request(port, 'POST', '/api/v1/auth/reset-password', { token: second.body.token, password: 'fresh-password' })).status).toBe(200)
    })

    it('is Admin-only', async () => {
      const qa = `tapflow_token=${signJwt({ userId: 2, email: 'alice@test.local', role: 'QA' })}`
      expect((await request(port, 'POST', '/api/v1/team/members/1/send-reset', undefined, qa)).status).toBe(403)
    })
  })

  describe('a password change ends the sessions issued before it', () => {
    it('a reset signs the member out everywhere', async () => {
      const before = `tapflow_token=${signJwt({ userId: 2, email: 'alice@test.local', role: 'QA' })}`
      expect((await request(port, 'GET', '/api/v1/auth/me', undefined, before)).status).toBe(200)
      const r = await request(port, 'POST', '/api/v1/team/members/2/send-reset', undefined, admin())
      await request(port, 'POST', '/api/v1/auth/reset-password', { token: r.body.token, password: 'fresh-password' })
      expect((await request(port, 'GET', '/api/v1/auth/me', undefined, before)).status).toBe(401)
      const login = await request(port, 'POST', '/api/v1/auth/login', { email: 'alice@test.local', password: 'fresh-password' })
      expect((await request(port, 'GET', '/api/v1/auth/me', undefined, login.setCookie)).status).toBe(200)
    })

    it('a reset revokes every personal access token of the member, and no one else\'s', async () => {
      const seed = getDb().prepare("INSERT INTO personal_access_tokens (user_id, name, token_hash, scope) VALUES (?, 't', ?, ?)")
      seed.run(2, 'h-api', 'view,builds:write')
      seed.run(2, 'h-agent', 'agent')
      seed.run(1, 'h-admin', 'agent')
      const r = await request(port, 'POST', '/api/v1/team/members/2/send-reset', undefined, admin())
      await request(port, 'POST', '/api/v1/auth/reset-password', { token: r.body.token, password: 'fresh-password' })
      expect(getDb().prepare('SELECT user_id, token_hash FROM personal_access_tokens').all()).toEqual([{ user_id: 1, token_hash: 'h-admin' }])
    })

    // Mutation: the second `requireAuth` in `handleCreateToken` removed → the token is created (201).
    it('a token request that holds its body back across a reset is refused, and creates nothing', async () => {
      const before = `tapflow_token=${signJwt({ userId: 2, email: 'alice@test.local', role: 'QA' })}`
      const payload = JSON.stringify({ name: 'late', scope: 'view,builds:write' })
      const reply = new Promise<number>((resolve, reject) => {
        const req = http.request({
          host: '127.0.0.1', port, path: '/api/v1/tokens', method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), cookie: before },
        }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode ?? 0)) })
        req.on('error', reject)
        req.write(payload.slice(0, 5))
        void (async () => {
          const r = await request(port, 'POST', '/api/v1/team/members/2/send-reset', undefined, admin())
          await request(port, 'POST', '/api/v1/auth/reset-password', { token: r.body.token, password: 'fresh-password' })
          req.end(payload.slice(5))
        })()
      })
      expect(await reply).toBe(401)
      expect(getDb().prepare('SELECT COUNT(*) AS n FROM personal_access_tokens WHERE user_id = 2').get()).toEqual({ n: 0 })
    })

    it('a self-service change keeps the member\'s personal access tokens', async () => {
      getDb().prepare("INSERT INTO personal_access_tokens (user_id, name, token_hash, scope) VALUES (2, 't', 'h-ci', 'view,builds:write')").run()
      const here = (await request(port, 'POST', '/api/v1/auth/login', { email: 'alice@test.local', password: 'alice-password' })).setCookie!
      expect((await request(port, 'POST', '/api/v1/auth/change-password', { currentPassword: 'alice-password', newPassword: 'fresh-password' }, here)).status).toBe(200)
      expect(getDb().prepare('SELECT COUNT(*) AS n FROM personal_access_tokens WHERE user_id = 2').get()).toEqual({ n: 1 })
    })

    it('a self-service change keeps this browser signed in and signs out the others', async () => {
      const here = (await request(port, 'POST', '/api/v1/auth/login', { email: 'alice@test.local', password: 'alice-password' })).setCookie!
      const elsewhere = `tapflow_token=${signJwt({ userId: 2, email: 'alice@test.local', role: 'QA' })}`
      const r = await request(port, 'POST', '/api/v1/auth/change-password', { currentPassword: 'alice-password', newPassword: 'fresh-password' }, here)
      expect(r.status).toBe(200)
      expect((await request(port, 'GET', '/api/v1/auth/me', undefined, r.setCookie)).status).toBe(200)
      expect((await request(port, 'GET', '/api/v1/auth/me', undefined, here)).status).toBe(401)
      expect((await request(port, 'GET', '/api/v1/auth/me', undefined, elsewhere)).status).toBe(401)
    })

    it('a cookie from before sessions carried a password version is refused (everyone signs in once after upgrading)', async () => {
      const jwt = (await import('jsonwebtoken')).default
      const { getJwtSecret } = await import('../lib/config')
      const legacy = jwt.sign({ userId: 2, email: 'alice@test.local', role: 'QA' }, getJwtSecret(), { expiresIn: '7d' })
      expect((await request(port, 'GET', '/api/v1/auth/me', undefined, `tapflow_token=${legacy}`)).status).toBe(401)
    })
  })
})

describe('migration 014', () => {
  it('normalizes stored addresses and leaves a colliding group untouched instead of failing to boot', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-mig-014-'))
    const file = path.join(tmp, 'test.db')
    try {
      // Every migration before 014, then rows as an older relay could have stored them.
      const db = new Database(file)
      db.exec("CREATE TABLE _migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, run_at TEXT NOT NULL DEFAULT (datetime('now')))")
      const dir = path.join(import.meta.dirname, '..', 'migrations')
      for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.sql') && n < '014').sort()) {
        db.exec(fs.readFileSync(path.join(dir, f), 'utf-8'))
        db.prepare('INSERT INTO _migrations (name) VALUES (?)').run(f)
      }
      const add = db.prepare("INSERT INTO users (id, email, role, password_hash) VALUES (?, ?, 'QA', 'h')")
      add.run(1, ' Solo@X.com')
      add.run(2, 'Pair@x.com')
      add.run(3, 'PAIR@x.com')
      add.run(4, 'kept@x.com')
      add.run(5, 'Kept@x.com')
      db.prepare("INSERT INTO invitations (token, email, role, expires_at) VALUES ('t', ' New@X.com', 'QA', '2099-01-01')").run()
      db.close()

      initDb(file)
      const emails = getDb().prepare('SELECT id, email FROM users ORDER BY id').all()
      expect(emails).toEqual([
        { id: 1, email: 'solo@x.com' },
        { id: 2, email: 'Pair@x.com' },
        { id: 3, email: 'PAIR@x.com' },
        { id: 4, email: 'kept@x.com' },
        { id: 5, email: 'Kept@x.com' },
      ])
      expect(getDb().prepare('SELECT email FROM invitations').get()).toEqual({ email: 'new@x.com' })
    } finally {
      closeDb()
      fs.rmSync(tmp, { recursive: true })
    }
    // Every migration on a file database: 6 s on the Windows runner, past the 5 s default.
  }, 30_000)
})
