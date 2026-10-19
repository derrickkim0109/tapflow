import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import net from 'net'
import { RelayServer } from '../RelayServer'
import { initDb, closeDb } from '../db'

// `serveStatic` joined the raw request target onto `publicDir` and read whatever that named, so an
// unauthenticated `GET /../../etc/passwd` returned the file — the JWT secret (`jwt-secret` in the data
// directory, `.env`, or `/proc/self/environ`) and the database beside it were enough to forge any member's
// session. `serveUpload` had the containment check since #173; this handler never got it.
//
// **Sent over a raw socket, not `http.get`.** Most clients collapse `/../` before sending, which would test
// the client. The request line has to reach the relay byte-for-byte, as it does from `curl --path-as-is`
// or through a raw-TCP tunnel.
function rawGet(port: number, target: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      const extra = Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join('')
      socket.write(`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1\r\n${extra}Connection: close\r\n\r\n`)
    })
    const chunks: Buffer[] = []
    socket.on('data', (c) => chunks.push(c))
    socket.on('end', () => {
      const raw = Buffer.concat(chunks).toString()
      const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(raw)?.[1] ?? 0)
      const split = raw.indexOf('\r\n\r\n')
      const head = raw.slice(0, split)
      let body = raw.slice(split + 4)
      // A piped file goes out chunked; strip the framing so the body compares as the file's bytes.
      if (/\r\ntransfer-encoding: chunked/i.test(head)) {
        let out = ''
        for (let at = 0; ;) {
          const eol = body.indexOf('\r\n', at)
          const size = parseInt(body.slice(at, eol), 16)
          if (!size) break
          out += body.slice(eol + 2, eol + 2 + size)
          at = eol + 2 + size + 2
        }
        body = out
      }
      resolve({ status, body })
    })
    socket.on('error', reject)
  })
}

const SECRET = 'OUTSIDE_PUBLIC_DIR'

describe('serveStatic stays inside publicDir', () => {
  let server: RelayServer
  let port: number
  let root: string
  let dbDir: string

  beforeAll(() => {
    dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-relay-contain-db-'))
    initDb(path.join(dbDir, 'test.db'))
  })

  afterAll(() => {
    closeDb()
    fs.rmSync(dbDir, { recursive: true })
  })

  beforeEach(async () => {
    // root/public is served; everything else under root stands in for the relay's data and the host.
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-relay-contain-'))
    const pub = path.join(root, 'public')
    fs.mkdirSync(path.join(pub, 'assets'), { recursive: true })
    fs.writeFileSync(path.join(pub, 'index.html'), 'INDEX_HTML')
    fs.writeFileSync(path.join(pub, 'assets', 'app.js'), 'APP_JS')
    fs.writeFileSync(path.join(root, 'secret.txt'), SECRET)
    fs.writeFileSync(path.join(root, 'secret.txt.br'), SECRET)
    fs.mkdirSync(path.join(root, 'outside'))
    fs.writeFileSync(path.join(root, 'outside', 'index.html'), SECRET)
    // A sibling whose name starts with the served directory's: a prefix check without a separator
    // accepts it.
    fs.mkdirSync(path.join(root, 'public-evil'))
    fs.writeFileSync(path.join(root, 'public-evil', 'secret.txt'), SECRET)
    server = new RelayServer({ port: 0, publicDir: pub })
    await server.start()
    port = (server.address() as { port: number }).port
  })

  afterEach(async () => {
    await server.stop()
    fs.rmSync(root, { recursive: true })
  })

  it.each([
    ['a file above publicDir', '/../secret.txt'],
    ['a climb that starts inside a real directory', '/assets/../../secret.txt'],
    ['a directory above publicDir', '/../outside/'],
    ['a sibling directory sharing publicDir as a prefix', '/../public-evil/secret.txt'],
    ['a query string after the climb', '/../secret.txt?x=1'],
  ])('refuses %s', async (_label, target) => {
    const res = await rawGet(port, target)
    expect(res.status).toBe(404)
    expect(res.body).not.toContain(SECRET)
  })

  it('does not serve a precompressed sibling above publicDir', async () => {
    // The `.br` and `.gz` candidates are derived from the joined path, so they need the same check.
    const res = await rawGet(port, '/../secret.txt', { 'Accept-Encoding': 'br' })
    expect(res.status).toBe(404)
    expect(res.body).not.toContain(SECRET)
  })

  it.each([
    // A separator only on Windows, where `path.join` treats it as one — `test-relay-windows` runs this.
    ['a backslash climb', '/..\\secret.txt'],
    // Not decoded by Node or by `path.join`; held so a later decode cannot open it.
    ['a percent-encoded climb', '/%2e%2e/secret.txt'],
  ])('does not leak through %s', async (_label, target) => {
    const res = await rawGet(port, target)
    expect(res.body).not.toContain(SECRET)
  })

  it('still serves what is inside, and still falls back to the SPA', async () => {
    // The anchor for every refusal above: the handler answers, so a 404 there is the guard and not a
    // server that serves nothing.
    expect(await rawGet(port, '/assets/app.js')).toMatchObject({ status: 200, body: 'APP_JS' })
    expect(await rawGet(port, '/')).toMatchObject({ status: 200, body: 'INDEX_HTML' })
    expect(await rawGet(port, '/app-center/build?id=1')).toMatchObject({ status: 200, body: 'INDEX_HTML' })
    // A climb that comes back inside is inside.
    expect(await rawGet(port, '/assets/../assets/app.js')).toMatchObject({ status: 200, body: 'APP_JS' })
  })
})
