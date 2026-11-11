import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { RelayServer } from '../RelayServer'
import { initDb, getDb, closeDb } from '../db'
import { hashPat } from '../middleware/auth'
import { sweepOrphanArtifacts } from '../maestro/runArtifacts'

// Internal fork: the files a `tapflow maestro` run attaches (every screenshot the Maestro flow took and
// Maestro's log). Only the run that made the record may attach, the bytes must be what the name says, and the
// files go when the run does.

const PAT_CI = 'tflw_pat_maestro_ci'
const PAT_SOMEONE = 'tflw_pat_maestro_someone'
const PAT_VIEW = 'tflw_pat_maestro_view'
const bearer = (pat: string) => ({ Authorization: `Bearer ${pat}` })
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('png body')])

describe('maestro run artifacts', () => {
  let server: RelayServer
  let port: number
  let tmpDir: string
  let uploadsDir: string
  let artifactsDir: string

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-maestro-artifacts-'))
    initDb(path.join(tmpDir, 'test.db'))
    const db = getDb()
    const user = db.prepare('INSERT INTO users (id, email, role, password_hash) VALUES (?, ?, ?, ?)')
    user.run(1, 'admin@example.test', 'Admin', 'x')
    user.run(2, 'ci@example.test', 'Developer', 'x')
    user.run(3, 'someone@example.test', 'Developer', 'x')
    const pat = db.prepare('INSERT INTO personal_access_tokens (user_id, name, token_hash, scope) VALUES (?, ?, ?, ?)')
    pat.run(2, 'ci', hashPat(PAT_CI), 'view,builds:write')
    pat.run(3, 'someone', hashPat(PAT_SOMEONE), 'view,builds:write')
    pat.run(2, 'view', hashPat(PAT_VIEW), 'view')
  })
  afterAll(() => { closeDb(); fs.rmSync(tmpDir, { recursive: true, force: true }) })

  beforeEach(async () => {
    uploadsDir = path.join(fs.mkdtempSync(path.join(tmpDir, 'install-')), 'uploads')
    artifactsDir = path.join(uploadsDir, '../maestro-run-artifacts')
    getDb().exec('DELETE FROM flow_runs')
    server = new RelayServer({ port: 0, uploadsDir })
    await server.start()
    port = (server.address() as { port: number }).port
  })
  afterEach(async () => { await server.stop() })

  async function call(method: string, url: string, headers: Record<string, string> = {}, body?: unknown) {
    const raw = Buffer.isBuffer(body) ? new Uint8Array(body) : body === undefined ? undefined : JSON.stringify(body)
    const res = await fetch(`http://127.0.0.1:${port}${url}`, {
      method, body: raw, headers: { ...(typeof raw === 'string' ? { 'Content-Type': 'application/json' } : {}), ...headers },
    })
    const buf = Buffer.from(await res.arrayBuffer())
    const isJson = res.headers.get('content-type')?.includes('json')
    return { status: res.status, headers: res.headers, buf, body: (isJson ? JSON.parse(buf.toString()) : null) as Record<string, unknown> }
  }

  async function newRun(pat = PAT_CI): Promise<string> {
    const r = await call('POST', '/api/v1/runs', bearer(pat), { client: 'maestro', flows: [{ name: 'c1' }] })
    expect(r.status).toBe(201)
    return r.body.id as string
  }
  const a = (id: string, name = '') => `/api/v1/maestro/runs/${id}/artifacts${name ? `/${name}` : ''}`
  const upload = (id: string, name: string, data: Buffer, pat = PAT_CI) => call('POST', a(id, name), bearer(pat), data)

  it('keeps what the run attached, lists it in the order written and serves it back with its type', async () => {
    const id = await newRun()
    expect((await upload(id, 'c1-01-calculator.png', PNG)).status).toBe(200)
    await new Promise((r) => setTimeout(r, 15))
    expect((await upload(id, 'maestro.log', Buffer.from('Tap on "Send"... COMPLETED\n'))).status).toBe(200)

    const list = await call('GET', a(id), bearer(PAT_VIEW))
    expect(list.status).toBe(200)
    expect(list.body.items).toEqual([
      { name: 'c1-01-calculator.png', kind: 'image', bytes: PNG.length },
      { name: 'maestro.log', kind: 'log', bytes: Buffer.byteLength('Tap on "Send"... COMPLETED\n') },
    ])

    const img = await call('GET', a(id, 'c1-01-calculator.png'), bearer(PAT_VIEW))
    expect(img.status).toBe(200)
    expect(img.headers.get('content-type')).toBe('image/png')
    expect(img.headers.get('x-content-type-options')).toBe('nosniff')
    expect(img.buf.equals(PNG)).toBe(true)
  })

  it('lists nothing for a run that attached nothing', async () => {
    const id = await newRun()
    const list = await call('GET', a(id), bearer(PAT_VIEW))
    expect(list.status).toBe(200)
    expect(list.body.items).toEqual([])
  })

  it('refuses a name that is a path, hidden, or of another type', async () => {
    const id = await newRun()
    for (const name of ['..%2Fescape.png', '.hidden.png', 'page.html', 'shot.gif']) {
      expect((await upload(id, name, PNG)).status, name).toBe(400)
    }
    expect(fs.existsSync(path.join(artifactsDir, id))).toBe(false)
  })

  it('refuses bytes that are not what the name says', async () => {
    const id = await newRun()
    expect((await upload(id, 'fake.png', Buffer.from('<script>alert(1)</script>'))).status).toBe(415)
    expect((await upload(id, 'binary.log', Buffer.from([0x41, 0x00, 0x42]))).status).toBe(415)
  })

  it('lets only the run that made the record attach, and only while it runs', async () => {
    const id = await newRun()
    expect((await upload(id, 'x.png', PNG, PAT_SOMEONE)).status).toBe(403)
    expect((await upload(id, 'x.png', PNG, PAT_VIEW)).status).toBe(403)
    expect((await call('POST', `/api/v1/runs/${id}/finish`, bearer(PAT_CI), { status: 'passed', exitCode: 0 })).status).toBe(200)
    expect((await upload(id, 'late.png', PNG)).status).toBe(409)
  })

  it('answers 404 for a run that does not exist', async () => {
    const missing = '00000000-0000-4000-8000-000000000000'
    expect((await upload(missing, 'x.png', PNG)).status).toBe(404)
    expect((await call('GET', a(missing), bearer(PAT_VIEW))).status).toBe(404)
    expect((await call('GET', a(missing, 'x.png'), bearer(PAT_VIEW))).status).toBe(404)
  })

  it('drops the files of runs that are gone, and only folders named like a run', async () => {
    const gone = await newRun()
    const kept = await newRun()
    expect((await upload(gone, 'old.png', PNG)).status).toBe(200)
    expect((await upload(kept, 'new.png', PNG)).status).toBe(200)
    fs.mkdirSync(path.join(artifactsDir, 'not-a-run'))
    getDb().prepare('DELETE FROM flow_runs WHERE id = ?').run(gone)
    sweepOrphanArtifacts(artifactsDir)
    expect(fs.existsSync(path.join(artifactsDir, gone))).toBe(false)
    expect(fs.existsSync(path.join(artifactsDir, kept, 'new.png'))).toBe(true)
    expect(fs.existsSync(path.join(artifactsDir, 'not-a-run'))).toBe(true)
  })

  it('keeps at most three logs per run, and replaces a file of the same name', async () => {
    const id = await newRun()
    for (const n of ['a.log', 'b.log', 'c.log']) expect((await upload(id, n, Buffer.from('x'))).status).toBe(200)
    expect((await upload(id, 'd.log', Buffer.from('x'))).status).toBe(409)
    expect((await upload(id, 'a.log', Buffer.from('again'))).status).toBe(200)
    expect((await upload(id, 'shot.png', PNG)).status).toBe(200)
  })

  it('refuses what would take a run past 200 MB of files', async () => {
    const id = await newRun()
    const big = Buffer.concat([PNG, Buffer.alloc(4 * 1024 * 1024)])
    // 49 of these fit in 200 MB (each is 4 MB and a few bytes); the 50th would not.
    for (let i = 0; i < 49; i++) expect((await upload(id, `s${i}.png`, big)).status, `s${i}`).toBe(200)
    expect((await upload(id, 's49.png', big)).status).toBe(413)
  })

  it('needs view access to read', async () => {
    const id = await newRun()
    await upload(id, 'x.png', PNG)
    expect((await call('GET', a(id))).status).toBe(401)
    expect((await call('GET', a(id, 'x.png'))).status).toBe(401)
  })
})
