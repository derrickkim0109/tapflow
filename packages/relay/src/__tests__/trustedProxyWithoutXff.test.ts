import { describe, it, expect, vi, afterEach, beforeAll, afterAll } from 'vitest'
import http from 'http'
import fs from 'fs'
import os from 'os'
import path from 'path'
import WebSocket from 'ws'
import { RelayServer } from '../RelayServer'
import { initDb, closeDb } from '../db'

// GHSA-pq37 finding 2, at the relay: the notice fires on both doors that decide locality, once, and the
// rule is stated at start to anyone who set the list. Locality itself is unchanged and covered by
// `clientAddress.test.ts` and `init-localhost.test.ts`.

function get(port: number, headers: Record<string, string>): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: '/api/v1/nothing-here', method: 'GET', headers }, (res) => { res.resume(); res.on('end', () => resolve()) })
    req.on('error', reject)
    req.end()
  })
}

function upgrade(port: number, headers: Record<string, string>): Promise<void> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers })
    const done = () => resolve()
    ws.on('close', done)
    ws.on('error', done)
    ws.on('open', () => ws.close())
  })
}

const notices = (spy: { mock: { calls: unknown[][] } }) =>
  spy.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('but no X-Forwarded-For'))

describe('RelayServer — a trusted proxy that sends no X-Forwarded-For', () => {
  let server: RelayServer | null = null
  let tmpDir: string
  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-proxy-xff-'))
    initDb(path.join(tmpDir, 'test.db'))
  })
  afterAll(() => { closeDb(); fs.rmSync(tmpDir, { recursive: true }) })
  afterEach(async () => { await server?.stop(); server = null; vi.restoreAllMocks() })

  async function start(trustedProxies: string[]) {
    server = new RelayServer({ port: 0, trustedProxies })
    await server.start()
    return (server.address() as { port: number }).port
  }

  it('warns once on an HTTP request that carries a proxy header and no X-Forwarded-For', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const port = await start(['127.0.0.1', '::1'])
    await get(port, { 'X-Real-IP': '203.0.113.5' })
    await get(port, { 'X-Forwarded-Proto': 'https' })
    expect(notices(warn)).toHaveLength(1)
    expect(notices(warn)[0]).toContain('x-real-ip')
  })

  it('warns on the WebSocket door too', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const port = await start(['127.0.0.1', '::1'])
    await upgrade(port, { 'X-Real-IP': '203.0.113.5' })
    expect(notices(warn)).toHaveLength(1)
  })

  // The host's agent and CLI: from a listed address, no proxy header. The two tests above are the control.
  it('says nothing about this host\'s own agent or CLI', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const port = await start(['127.0.0.1', '::1'])
    await get(port, {})
    await upgrade(port, {})
    expect(notices(warn)).toHaveLength(0)
  })

  it('says nothing when the proxy sends X-Forwarded-For', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const port = await start(['127.0.0.1', '::1'])
    await get(port, { 'X-Real-IP': '203.0.113.5', 'X-Forwarded-For': '203.0.113.5' })
    expect(notices(warn)).toHaveLength(0)
  })

  it('states the rule at start when trusted proxies are set, and not otherwise', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const rule = () => log.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('Trusted proxies:'))
    await start([])
    expect(rule()).toHaveLength(0)
    await server!.stop(); server = null
    await start(['127.0.0.1'])
    expect(rule()).toHaveLength(1)
  })
})
