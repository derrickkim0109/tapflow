import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import http from 'http'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { RelayServer } from '../RelayServer'
import { initDb, getDb, closeDb } from '../db'

interface PostResult { status: number; body: { error?: string; ok?: boolean } }

function httpPost(port: number, urlPath: string, payload: unknown, headers: Record<string, string> = {}): Promise<PostResult> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload)
    const req = http.request(
      { hostname: '127.0.0.1', port, path: urlPath, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...headers } },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => resolve({ status: res.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString()) }))
      },
    )
    req.on('error', reject)
    req.end(data)
  })
}

async function canInitialize(port: number, headers: Record<string, string> = {}): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: '/api/v1/auth/status', method: 'GET', headers }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => resolve((JSON.parse(Buffer.concat(chunks).toString()) as { canInitialize: boolean }).canInitialize))
    })
    req.on('error', reject)
    req.end()
  })
}

// P0-3 — 무인증 부트스트랩 레이스: init은 localhost 출처만 허용
describe('POST /api/v1/auth/init — localhost-only gate', () => {
  let tmpDir: string

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-init-test-'))
    initDb(path.join(tmpDir, 'test.db'))
  })

  afterAll(() => {
    closeDb()
    fs.rmSync(tmpDir, { recursive: true })
  })

  beforeEach(() => {
    getDb().prepare('DELETE FROM users').run()
  })

  describe('신뢰 프록시 설정 없음 (직접 연결)', () => {
    let server: RelayServer
    let port: number

    beforeEach(async () => {
      server = new RelayServer({ port: 0 })
      await server.start()
      port = (server.address() as { port: number }).port
    })
    afterEach(async () => { await server.stop() })

    it('localhost 직접 요청 → 201 (정상 부트스트랩)', async () => {
      const r = await httpPost(port, '/api/v1/auth/init', { email: 'admin@example.com', password: 'password123' })
      expect(r.status).toBe(201)
      expect(r.body.ok).toBe(true)
    })

    // **이 셋은 리팩터가 모듈 경계를 넘겨 옮긴 응답인데 저장소 어디에서도 검증되지 않았다.**
    // `Already initialized` / `email and password required` / `Password must be at least 8
    // characters` 를 검색하면 릴레이 테스트 0건이고, 나머지 히트는 CLI·대시보드의 mock이다.
    // 대시보드 `Setup.tsx`가 `body.error`를 그대로 화면에 렌더링하므로 사용자에게 보이는 문자열이다.
    it('이미 초기화된 설치 → 403 Already initialized', async () => {
      await httpPost(port, '/api/v1/auth/init', { email: 'admin@example.com', password: 'password123' })
      const r = await httpPost(port, '/api/v1/auth/init', { email: 'second@example.com', password: 'password123' })
      expect(r.status).toBe(403)
      expect(r.body.error).toBe('Already initialized')
    })

    it('email/password 누락 → 400', async () => {
      const r = await httpPost(port, '/api/v1/auth/init', { email: 'admin@example.com' })
      expect(r.status).toBe(400)
      expect(r.body.error).toBe('email and password required')
    })

    it('비밀번호 8자 미만 → 400', async () => {
      const r = await httpPost(port, '/api/v1/auth/init', { email: 'admin@example.com', password: 'short12' })
      expect(r.status).toBe(400)
      expect(r.body.error).toBe('Password must be at least 8 characters')
    })

    it('스푸핑된 XFF는 신뢰 목록 밖이라 무시 → 여전히 localhost로 통과(201)', async () => {
      const r = await httpPost(port, '/api/v1/auth/init', { email: 'admin@example.com', password: 'password123' }, { 'X-Forwarded-For': '203.0.113.5' })
      expect(r.status).toBe(201)
    })
  })

  describe('신뢰 프록시 설정됨 (same-host 리버스 프록시)', () => {
    let server: RelayServer
    let port: number

    beforeEach(async () => {
      server = new RelayServer({ port: 0, trustedProxies: ['127.0.0.1'] })
      await server.start()
      port = (server.address() as { port: number }).port
    })
    afterEach(async () => { await server.stop() })

    it('프록시 경유 원격 클라이언트(XFF 공인 IP) → 403 (선점 차단)', async () => {
      const r = await httpPost(port, '/api/v1/auth/init', { email: 'evil@example.com', password: 'password123' }, { 'X-Forwarded-For': '203.0.113.5' })
      expect(r.status).toBe(403)
      expect(r.body.error).toContain('localhost')
      // 유저가 생성되지 않았는지 확인
      const { n } = getDb().prepare('SELECT COUNT(*) as n FROM users').get() as { n: number }
      expect(n).toBe(0)
    })

    it('프록시 경유 LAN 클라이언트(XFF 사설 IP) → 403', async () => {
      const r = await httpPost(port, '/api/v1/auth/init', { email: 'evil@example.com', password: 'password123' }, { 'X-Forwarded-For': '192.168.0.42' })
      expect(r.status).toBe(403)
    })

    it('스푸핑: 공격자가 XFF에 loopback 주입(프록시가 실제 IP를 append) → 403 (우측 실제 IP로 판정)', async () => {
      const r = await httpPost(port, '/api/v1/auth/init', { email: 'evil@example.com', password: 'password123' }, { 'X-Forwarded-For': '127.0.0.1, 203.0.113.5' })
      expect(r.status).toBe(403)
    })

    it('프록시 우회 직접 연결(XFF 없음) → 201 (프록시 뒤 배포에서도 호스트의 admin init은 직접 동작)', async () => {
      const r = await httpPost(port, '/api/v1/auth/init', { email: 'admin@example.com', password: 'password123' })
      expect(r.status).toBe(201)
    })
  })

  // The setup page decides between the form and the instruction from `auth/status`. Asked with the same
  // request, it must answer what `auth/init` then does — a page showing the form to a client init refuses
  // is #850 again, and one hiding it from a client init accepts locks the owner out of the browser path.
  describe('auth/status agrees with auth/init', () => {
    const cases: { name: string; allowed: boolean; trustedProxies?: string[]; headers?: Record<string, string> }[] = [
      { name: 'direct localhost', allowed: true },
      { name: 'spoofed XFF, no trusted proxy', allowed: true, headers: { 'X-Forwarded-For': '203.0.113.5' } },
      { name: 'trusted proxy, remote client', allowed: false, trustedProxies: ['127.0.0.1'], headers: { 'X-Forwarded-For': '203.0.113.5' } },
      { name: 'trusted proxy, LAN client', allowed: false, trustedProxies: ['127.0.0.1'], headers: { 'X-Forwarded-For': '192.168.0.42' } },
      { name: 'trusted proxy, forwarded loopback', allowed: true, trustedProxies: ['127.0.0.1'], headers: { 'X-Forwarded-For': '::1' } },
      { name: 'trusted proxy, bypassed', allowed: true, trustedProxies: ['127.0.0.1'] },
    ]
    for (const c of cases) {
      it(c.name, async () => {
        const server = new RelayServer({ port: 0, trustedProxies: c.trustedProxies })
        await server.start()
        try {
          const port = (server.address() as { port: number }).port
          // Pinned per case, not only compared: two answers that are wrong the same way would still agree.
          expect(await canInitialize(port, c.headers)).toBe(c.allowed)
          const r = await httpPost(port, '/api/v1/auth/init', { email: 'admin@example.com', password: 'password123' }, c.headers)
          expect(r.status).toBe(c.allowed ? 201 : 403)
        } finally {
          await server.stop()
        }
      })
    }

    it('says no once an admin exists, whoever asks', async () => {
      const server = new RelayServer({ port: 0 })
      await server.start()
      try {
        const port = (server.address() as { port: number }).port
        await httpPost(port, '/api/v1/auth/init', { email: 'admin@example.com', password: 'password123' })
        expect(await canInitialize(port)).toBe(false)
      } finally {
        await server.stop()
      }
    })
  })
})
