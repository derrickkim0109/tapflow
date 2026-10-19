import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import http from 'http'
import net from 'net'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { initDb, getDb, closeDb } from '../db'
import { validateWebhookUrl, isBlockedAddress } from '../lib/webhookUrl'
import { createSafeFetch, type LookupFn } from '../lib/webhookTransport'
import { deliverWebhooks, type WebhookPayload } from '../lib/webhooks'
import { config, resolveWebhooksConfig } from '../lib/config'

// Delivery tests need a receiver the relay may reach, but the only address a test can listen on is
// loopback — the very thing the policy blocks. So a "permitted" name is pointed at 127.0.0.1 through an
// injected lookup, and the policy is told to let 127.0.0.1 through for that test only. Tests that
// assert blocking use the real policy.

function receiver(handler?: http.RequestListener): { server: http.Server; hits: string[]; headers: http.IncomingHttpHeaders[] } {
  const hits: string[] = []
  const headers: http.IncomingHttpHeaders[] = []
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      hits.push(Buffer.concat(chunks).toString())
      headers.push(req.headers)
      if (handler) handler(req, res)
      else { res.writeHead(200); res.end('ok') }
    })
  })
  return { server, hits, headers }
}

function listen(server: net.Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port)))
}

const close = (s: net.Server) => new Promise<void>((r) => s.close(() => r()))

const LOOPBACK: LookupFn = async () => [{ address: '127.0.0.1', family: 4 }]
const permitLoopback = (ip: string) => ip !== '127.0.0.1' && isBlockedAddress(ip)

const init = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"a":1}' }
const signal = () => AbortSignal.timeout(2000)

describe('isBlockedAddress / validateWebhookUrl — the boundary', () => {
  it('rejects loopback-resolving names and literal forms the string check missed', () => {
    for (const url of [
      'http://foo.localhost/x',
      'http://a.b.localhost:7777/x',
      'http://LOCALHOST./x',
      'http://foo.localhost./x',
      'http://[::]/x',
      'http://[fe80::1]/x',
      'http://0.1.2.3/x',
      'http://[::ffff:169.254.169.254]/x',
      'http://[fd00:ec2::254]/x',
      'http://2130706433/x',
      'http://[::127.0.0.1]/x',
      'http://[64:ff9b::a9fe:a9fe]/x',
      'http://[2002:7f00:1::]/x',
      'http://user:pass@hooks.example.com/x',
      'http://token@hooks.example.com/x',
    ]) {
      expect(validateWebhookUrl(url), url).toBeTruthy()
    }
  })

  it('still allows private LAN, ULA, Docker names and public hosts', () => {
    for (const url of [
      'http://10.0.0.5/x',
      'http://172.16.3.4/x',
      'http://192.168.1.10/x',
      'http://[fd12::1]/x',
      'http://ci.internal:8080/x',
      'http://host.docker.internal/x',
      'https://hooks.slack.com/services/xxx',
    ]) {
      expect(validateWebhookUrl(url), url).toBeNull()
    }
  })

  it('classifies addresses, including IPv4-mapped forms', () => {
    expect(isBlockedAddress('127.0.0.1')).toBe(true)
    expect(isBlockedAddress('::ffff:7f00:1')).toBe(true)
    expect(isBlockedAddress('::ffff:169.254.169.254')).toBe(true)
    expect(isBlockedAddress('::1')).toBe(true)
    expect(isBlockedAddress('10.0.0.1')).toBe(false)
    expect(isBlockedAddress('fd12::1')).toBe(false)
    expect(isBlockedAddress('93.184.216.34')).toBe(false)
  })

  it('catches loopback and metadata carried inside other IPv6 spellings, and only those', () => {
    for (const ip of ['::127.0.0.1', '::ffff:0:7f00:1', '64:ff9b::7f00:1', '64:ff9b::a9fe:a9fe', '2002:7f00:1::', '2002:a9fe:a9fe::1', '::ffff:0:a9fe:a9fe']) {
      expect(isBlockedAddress(ip), ip).toBe(true)
    }
    // The same prefixes carrying a public or LAN address are ordinary destinations.
    for (const ip of ['64:ff9b::5db8:d822', '2002:5db8:d822::1', '64:ff9b::a00:5']) {
      expect(isBlockedAddress(ip), ip).toBe(false)
    }
  })

  it('config.json entries under .localhost are dropped', () => {
    const out = resolveWebhooksConfig([{ url: 'http://foo.localhost/x' }, { url: 'https://ok/x' }], {})
    expect(out.map((w) => w.url)).toEqual(['https://ok/x'])
  })
})

describe('createSafeFetch', () => {
  it('delivers to a permitted host, body intact, with the headers fetch used to send', async () => {
    const { server, hits, headers } = receiver()
    const port = await listen(server)
    try {
      const f = createSafeFetch({ lookup: LOOPBACK, isBlocked: permitLoopback })
      const res = await f(`http://ci.example.test:${port}/hook`, { ...init, signal: signal() })
      expect(res.ok).toBe(true)
      expect(await res.text()).toBe('ok')
      expect(hits).toEqual(['{"a":1}'])
      expect(headers[0]['user-agent']).toBe('tapflow-webhook')
      expect(headers[0]['content-type']).toBe('application/json')
      expect(headers[0].host).toBe(`ci.example.test:${port}`)
    } finally { await close(server) }
  })

  it('refuses a name that resolves to loopback, and the receiver sees nothing', async () => {
    const { server, hits } = receiver()
    const port = await listen(server)
    try {
      const f = createSafeFetch({ lookup: LOOPBACK })
      await expect(f(`http://ci.example.test:${port}/hook`, { ...init, signal: signal() })).rejects.toThrow(/loopback or metadata/)
      expect(hits).toEqual([])
    } finally { await close(server) }
  })

  it('drops blocked answers and connects only to a permitted one (a `.local` name with an fe80:: answer)', async () => {
    // Both answers need a listener, or a transport that skipped the filter would fail over to the permitted
    // one anyway and pass. Here 127.0.0.1 plays the blocked answer and ::1 the permitted one; the blocked
    // answer comes first, which is the one happy eyeballs tries first.
    const blockedSide = receiver()
    const permittedSide = receiver()
    const port = await listen(blockedSide.server)
    await new Promise<void>((r) => permittedSide.server.listen(port, '::1', () => r()))
    try {
      const f = createSafeFetch({
        lookup: async () => [{ address: '127.0.0.1', family: 4 }, { address: '::1', family: 6 }],
        isBlocked: (ip) => ip === '127.0.0.1' || (ip !== '::1' && isBlockedAddress(ip)),
      })
      const res = await f(`http://ci-mac.local:${port}/`, { ...init, signal: signal() })
      expect(res.ok).toBe(true)
      expect(permittedSide.hits).toHaveLength(1)
      expect(blockedSide.hits).toEqual([])
    } finally { await close(blockedSide.server); await close(permittedSide.server) }
  })

  it('refuses a name whose every answer is blocked', async () => {
    const f = createSafeFetch({
      lookup: async () => [{ address: 'fe80::1', family: 6 }, { address: '169.254.169.254', family: 4 }],
    })
    await expect(f('http://metadata.test/', { ...init, signal: signal() })).rejects.toThrow(/loopback or metadata/)
  })

  it('refuses a stored URL carrying credentials instead of sending them as Authorization', async () => {
    const { server, hits } = receiver()
    const port = await listen(server)
    try {
      const f = createSafeFetch({ lookup: LOOPBACK, isBlocked: permitLoopback })
      await expect(f(`http://user:pass@ci.example.test:${port}/`, { ...init, signal: signal() })).rejects.toThrow(/credentials/)
      expect(hits).toEqual([])
    } finally { await close(server) }
  })

  it('refuses a blocked IP literal without a lookup', async () => {
    const { server, hits } = receiver()
    const port = await listen(server)
    let lookups = 0
    try {
      const f = createSafeFetch({ lookup: async () => { lookups++; return [] } })
      await expect(f(`http://127.0.0.1:${port}/`, { ...init, signal: signal() })).rejects.toThrow(/loopback or metadata/)
      expect(hits).toEqual([])
      expect(lookups).toBe(0)
    } finally { await close(server) }
  })

  it('does not follow redirects', async () => {
    const target = receiver()
    const targetPort = await listen(target.server)
    const bouncer = receiver((_req, res) => { res.writeHead(302, { Location: `http://127.0.0.1:${targetPort}/` }); res.end() })
    const bouncerPort = await listen(bouncer.server)
    try {
      const f = createSafeFetch({ lookup: LOOPBACK, isBlocked: permitLoopback })
      const res = await f(`http://public.example.test:${bouncerPort}/`, { ...init, signal: signal() })
      expect(res.status).toBe(302)
      expect(res.ok).toBe(false)
      expect(bouncer.hits).toHaveLength(1)
      expect(target.hits).toEqual([])
    } finally { await close(bouncer.server); await close(target.server) }
  })

  it('resolves once and connects to the address it checked (no rebind window)', async () => {
    const { server, hits } = receiver()
    const port = await listen(server)
    let lookups = 0
    // First answer permitted, every later answer blocked: a second resolution would be refused.
    const rebinding: LookupFn = async () => (lookups++ === 0 ? [{ address: '127.0.0.1', family: 4 }] : [{ address: '169.254.169.254', family: 4 }])
    try {
      const f = createSafeFetch({ lookup: rebinding, isBlocked: permitLoopback })
      const res = await f(`http://rebind.test:${port}/`, { ...init, signal: signal() })
      expect(res.ok).toBe(true)
      expect(lookups).toBe(1)
      expect(hits).toHaveLength(1)
    } finally { await close(server) }
  })

  it('keeps the hostname for TLS SNI while connecting to the checked address', async () => {
    let sni = false
    const tcp = net.createServer((sock) => {
      sock.once('data', (buf: Buffer) => { sni = buf.includes(Buffer.from('ci.example.test')); sock.destroy() })
    })
    const port = await listen(tcp)
    try {
      const f = createSafeFetch({ lookup: LOOPBACK, isBlocked: permitLoopback })
      await expect(f(`https://ci.example.test:${port}/`, { ...init, signal: signal() })).rejects.toThrow()
      expect(sni).toBe(true)
    } finally { await close(tcp) }
  })

  it('honours the abort signal', async () => {
    const sockets: net.Socket[] = []
    const hang = net.createServer((sock) => { sockets.push(sock) /* accept and never answer */ })
    const port = await listen(hang)
    try {
      const f = createSafeFetch({ lookup: LOOPBACK, isBlocked: permitLoopback })
      await expect(f(`http://slow.test:${port}/`, { ...init, signal: AbortSignal.timeout(100) })).rejects.toThrow()
    } finally { sockets.forEach((s) => s.destroy()); await close(hang) }
  })
})

describe('deliverWebhooks — default transport', () => {
  let tmpDir: string
  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-wh-ssrf-'))
    initDb(path.join(tmpDir, 'test.db'))
  })
  afterAll(() => { closeDb(); fs.rmSync(tmpDir, { recursive: true, force: true }) })
  afterEach(() => { getDb().exec('DELETE FROM webhook_endpoints'); config.webhooks.length = 0 })

  const payload: WebhookPayload = {
    event: 'build.status_changed',
    build: { id: '1', platform: 'ios', appVersion: '1.0.0', status: 'Rejected' },
    changedAt: '2026-10-06T00:00:00.000Z',
  }

  // The reported chain: an endpoint stored before this fix (or written straight to the DB) must not
  // reach a loopback listener when a build changes status.
  it.each([
    ['a .localhost name', (p: number) => `http://foo.localhost:${p}/`],
    ['a loopback literal', (p: number) => `http://127.0.0.1:${p}/`],
  ])('does not deliver to %s stored in the DB', async (_label, url) => {
    const { server, hits } = receiver()
    const port = await listen(server)
    try {
      getDb().prepare('INSERT INTO webhook_endpoints (url, secret, enabled) VALUES (?, ?, 1)').run(url(port), null)
      await expect(deliverWebhooks(payload)).resolves.toBeUndefined()
      await new Promise((r) => setTimeout(r, 100))
      expect(hits).toEqual([])
    } finally { await close(server) }
  })
})
