import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest'

const mockTunnel = { setupServer: vi.fn(), start: vi.fn(), stop: vi.fn() }
vi.mock('../../lib/rathole-tunnel.js', () => ({
  RatholeTunnel: vi.fn().mockImplementation(function () { return mockTunnel }),
}))
vi.mock('../../lib/tailscale-tunnel.js', () => ({
  TailscaleTunnel: vi.fn().mockImplementation(function () { return mockTunnel }),
}))

import { RatholeTunnel } from '../../lib/rathole-tunnel.js'
import { TailscaleTunnel } from '../../lib/tailscale-tunnel.js'
import { startConfiguredTunnel, tunnelRuntimeFor } from '../../lib/tunnel-runner.js'

const PORTS = { relayPort: 4000, tunnelPort: 4001 }

// A detected Tailscale URL is always http://, and a TLS relay answers only HTTPS on that port, so handing
// the relay that URL would put an address nothing answers into mail, links and CORS.
describe('tunnelRuntimeFor', () => {
  it('passes the tunnel outcome through for a plain-HTTP relay', () => {
    expect(tunnelRuntimeFor('http://my-mac.tailnet.ts.net:4000', false)).toEqual({ publicUrl: 'http://my-mac.tailnet.ts.net:4000' })
    expect(tunnelRuntimeFor(null, false)).toEqual({ publicUrl: null })
  })

  it('drops an http:// tunnel URL when the relay serves TLS', () => {
    expect(tunnelRuntimeFor('http://my-mac.tailnet.ts.net:4000', true)).toEqual({ publicUrl: null })
    expect(tunnelRuntimeFor('HTTP://my-mac.tailnet.ts.net:4000', true)).toEqual({ publicUrl: null })
  })

  it('keeps an https:// tunnel URL when the relay serves TLS', () => {
    expect(tunnelRuntimeFor('https://vps.example.com', true)).toEqual({ publicUrl: 'https://vps.example.com' })
  })
})

describe('startConfiguredTunnel', () => {
  let exitSpy: MockInstance

  beforeEach(() => {
    vi.resetAllMocks()
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit') })
    vi.spyOn(console, 'log').mockImplementation(() => {})
    mockTunnel.setupServer.mockResolvedValue(undefined)
    mockTunnel.start.mockResolvedValue({ publicUrl: 'https://vps.example.com' })
    mockTunnel.stop.mockResolvedValue(undefined)
    vi.mocked(RatholeTunnel).mockImplementation(function () { return mockTunnel as never })
    vi.mocked(TailscaleTunnel).mockImplementation(function () { return mockTunnel as never })
  })

  afterEach(() => vi.restoreAllMocks())

  it('tailscale: TailscaleTunnel 생성 후 publicUrl 반환 (토큰 불필요)', async () => {
    mockTunnel.start.mockResolvedValue({ publicUrl: 'http://my-mac.tailnet.ts.net:4000' })
    const res = await startConfiguredTunnel({ provider: 'tailscale' }, PORTS)
    expect(TailscaleTunnel).toHaveBeenCalledWith({ publicUrl: undefined })
    expect(RatholeTunnel).not.toHaveBeenCalled()
    expect(res.publicUrl).toBe('http://my-mac.tailnet.ts.net:4000')
    expect(res.tunnel).toBe(mockTunnel)
  })

  it('rathole: 토큰 있으면 setupServer → start 순서 + publicUrl 반환', async () => {
    vi.stubEnv('TAPFLOW_TUNNEL_TOKEN', 'secret-token')
    const order: string[] = []
    mockTunnel.setupServer.mockImplementation(async () => { order.push('setupServer') })
    mockTunnel.start.mockImplementation(async () => { order.push('start'); return { publicUrl: 'https://vps.example.com' } })

    const res = await startConfiguredTunnel(
      { provider: 'rathole', serverAddr: 'vps.example.com:2333', publicUrl: 'https://vps.example.com', ssh: null }, PORTS)

    expect(RatholeTunnel).toHaveBeenCalledWith(expect.objectContaining({ serverAddr: 'vps.example.com:2333', token: 'secret-token' }))
    expect(order).toEqual(['setupServer', 'start'])
    expect(res.publicUrl).toBe('https://vps.example.com')
    vi.unstubAllEnvs()
  })

  it('rathole: TAPFLOW_TUNNEL_TOKEN 없으면 warn 후 fallback 반환 (exit 안 함)', async () => {
    vi.unstubAllEnvs()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const res = await startConfiguredTunnel(
      { provider: 'rathole', serverAddr: 'a:1', publicUrl: 'https://a', ssh: null }, PORTS)

    expect(exitSpy).not.toHaveBeenCalled()
    expect(RatholeTunnel).not.toHaveBeenCalled()
    expect(res).toEqual({ tunnel: null, publicUrl: null })
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('TAPFLOW_TUNNEL_TOKEN'))
  })

  it('passes both ports to the tunnel', async () => {
    await startConfiguredTunnel({ provider: 'tailscale' }, { relayPort: 5000, tunnelPort: 5001 })
    expect(mockTunnel.start).toHaveBeenCalledWith({ relayPort: 5000, tunnelPort: 5001 })
  })

  it('prints what the tunnel warned about', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mockTunnel.start.mockResolvedValue({ publicUrl: 'https://x.ts.net', warnings: ['serve points at the relay port'] })
    const res = await startConfiguredTunnel({ provider: 'tailscale' }, PORTS)
    expect(res.publicUrl).toBe('https://x.ts.net')
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('serve points at the relay port'))
  })

  it('터널 기동 실패 시 warn 후 { tunnel: null, publicUrl: null } 반환', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mockTunnel.start.mockRejectedValue(new Error('connection refused'))

    const res = await startConfiguredTunnel({ provider: 'tailscale' }, PORTS)

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('connection refused'))
    expect(res.tunnel).toBeNull()
    expect(res.publicUrl).toBeNull()
  })
})
