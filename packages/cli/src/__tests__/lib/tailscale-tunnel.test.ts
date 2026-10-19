import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('child_process', () => ({
  execSync: vi.fn(),
}))

import { execSync } from 'child_process'
import { TailscaleTunnel } from '../../lib/tailscale-tunnel.js'

const PORTS = { relayPort: 4000, tunnelPort: 4001 }

const RUNNING_WITH_DNS = JSON.stringify({
  BackendState: 'Running',
  Self: {
    DNSName: 'my-mac.tailnet-test.ts.net.',
    TailscaleIPs: ['100.64.1.2', 'fd7a::1'],
  },
})

const RUNNING_WITHOUT_DNS = JSON.stringify({
  BackendState: 'Running',
  Self: {
    DNSName: '',
    TailscaleIPs: ['100.64.1.2'],
  },
})

const RUNNING_IPV6_ONLY = JSON.stringify({
  BackendState: 'Running',
  Self: {
    DNSName: '',
    TailscaleIPs: ['fd7a:115c:a1e0::1'],
  },
})

describe('TailscaleTunnel', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.mocked(execSync).mockReturnValue(Buffer.from('') as never)
  })

  it('setupServer() — no-op, execSync 미호출', async () => {
    const tunnel = new TailscaleTunnel({})
    await expect(tunnel.setupServer()).resolves.toBeUndefined()
    expect(execSync).not.toHaveBeenCalled()
  })

  it('stop() — no-op, execSync 미호출', async () => {
    const tunnel = new TailscaleTunnel({})
    await expect(tunnel.stop()).resolves.toBeUndefined()
    expect(execSync).not.toHaveBeenCalled()
  })

  it('start() — publicUrl 설정 시 tailscale 없이도 그대로 반환', async () => {
    vi.mocked(execSync).mockImplementation(() => { throw new Error('command not found') })
    const tunnel = new TailscaleTunnel({ publicUrl: 'http://my.custom.url:4000' })
    const result = await tunnel.start(PORTS)
    expect(result.publicUrl).toBe('http://my.custom.url:4000')
    expect(result.warnings).toEqual([])
  })

  it('start() — Tailscale 미설치 → 에러 + 설치 안내', async () => {
    vi.mocked(execSync).mockImplementation(() => { throw new Error('command not found') })
    const tunnel = new TailscaleTunnel({})
    const error = await tunnel.start(PORTS).catch((e: unknown) => e) as Error
    expect(error.message).toMatch(/not installed/)
    expect(error.message).toMatch(/brew install tailscale/)
  })

  it('start() — Running + MagicDNS → DNS 이름으로 URL 반환 (trailing dot 제거)', async () => {
    vi.mocked(execSync)
      .mockReturnValueOnce(Buffer.from('1.0.0') as never)
      .mockReturnValueOnce(Buffer.from(RUNNING_WITH_DNS) as never)
    const tunnel = new TailscaleTunnel({})
    const result = await tunnel.start(PORTS)
    expect(result.publicUrl).toBe('http://my-mac.tailnet-test.ts.net:4000')
  })

  it('start() — Running + MagicDNS 없음 → tailnet IP로 URL 반환', async () => {
    vi.mocked(execSync)
      .mockReturnValueOnce(Buffer.from('1.0.0') as never)
      .mockReturnValueOnce(Buffer.from(RUNNING_WITHOUT_DNS) as never)
    const tunnel = new TailscaleTunnel({})
    const result = await tunnel.start(PORTS)
    expect(result.publicUrl).toBe('http://100.64.1.2:4000')
  })

  it('start() — IPv6 전용 → 브래킷 URL 반환', async () => {
    vi.mocked(execSync)
      .mockReturnValueOnce(Buffer.from('1.0.0') as never)
      .mockReturnValueOnce(Buffer.from(RUNNING_IPV6_ONLY) as never)
    const tunnel = new TailscaleTunnel({})
    const result = await tunnel.start(PORTS)
    expect(result.publicUrl).toBe('http://[fd7a:115c:a1e0::1]:4000')
  })

  it('start() — IPv4 + IPv6 혼재 → IPv4 우선 선택', async () => {
    const mixed = JSON.stringify({
      BackendState: 'Running',
      Self: { DNSName: '', TailscaleIPs: ['fd7a::1', '100.64.1.2'] },
    })
    vi.mocked(execSync)
      .mockReturnValueOnce(Buffer.from('1.0.0') as never)
      .mockReturnValueOnce(Buffer.from(mixed) as never)
    const tunnel = new TailscaleTunnel({})
    const result = await tunnel.start(PORTS)
    expect(result.publicUrl).toBe('http://100.64.1.2:4000')
  })

  it('start() — BackendState !== Running → 에러 + tailscale up 안내', async () => {
    vi.mocked(execSync)
      .mockReturnValueOnce(Buffer.from('1.0.0') as never)
      .mockReturnValueOnce(Buffer.from(JSON.stringify({ BackendState: 'Stopped', Self: {} })) as never)
    const tunnel = new TailscaleTunnel({})
    const error = await tunnel.start(PORTS).catch((e: unknown) => e) as Error
    expect(error.message).toMatch(/not connected/)
    expect(error.message).toMatch(/tailscale up/)
  })

  // Both checks exist because the relay port counts loopback as local: anything Tailscale delivers there
  // from loopback reaches the relay with no sign-in.
  describe('start() — localhost exposure warnings', () => {
    const serveTo = (target: string) => JSON.stringify({
      TCP: { '443': { HTTPS: true } },
      Web: { 'my-mac.tailnet-test.ts.net:443': { Handlers: { '/': { Proxy: target } } } },
    })
    // execSync is called with the command as its first argument; answer by command, not by order.
    const answer = (status: string, serve: string | Error) => {
      vi.mocked(execSync).mockImplementation(((cmd: string) => {
        if (cmd.startsWith('tailscale serve status')) {
          if (serve instanceof Error) throw serve
          return Buffer.from(serve)
        }
        if (cmd.startsWith('tailscale status')) return Buffer.from(status)
        return Buffer.from('1.0.0')
      }) as typeof execSync)
    }

    it('warns when tailscale serve forwards to the relay port', async () => {
      answer(RUNNING_WITH_DNS, serveTo('http://127.0.0.1:4000'))
      const result = await new TailscaleTunnel({}).start(PORTS)
      expect(result.warnings).toHaveLength(1)
      expect(result.warnings![0]).toMatch(/tailscale serve/)
      expect(result.warnings![0]).toContain('4001')
    })

    it('also recognises localhost as the target', async () => {
      answer(RUNNING_WITH_DNS, serveTo('http://localhost:4000'))
      const result = await new TailscaleTunnel({}).start(PORTS)
      expect(result.warnings).toHaveLength(1)
    })

    it('checks even when the URL is configured — that is how the HTTPS setup is written', async () => {
      answer(RUNNING_WITH_DNS, serveTo('http://127.0.0.1:4000'))
      const result = await new TailscaleTunnel({ publicUrl: 'https://my-mac.tailnet-test.ts.net' }).start(PORTS)
      expect(result.publicUrl).toBe('https://my-mac.tailnet-test.ts.net')
      expect(result.warnings).toHaveLength(1)
    })

    it('is quiet when tailscale serve forwards to the tunnel port', async () => {
      answer(RUNNING_WITH_DNS, serveTo('http://127.0.0.1:4001'))
      expect((await new TailscaleTunnel({}).start(PORTS)).warnings).toEqual([])
    })

    it('does not mistake a longer port for the relay port', async () => {
      answer(RUNNING_WITH_DNS, serveTo('http://127.0.0.1:40001'))
      expect((await new TailscaleTunnel({}).start({ relayPort: 4000, tunnelPort: 40001 })).warnings).toEqual([])
    })

    it('is quiet with no serve config, and when the serve status cannot be read', async () => {
      answer(RUNNING_WITH_DNS, '{}')
      expect((await new TailscaleTunnel({}).start(PORTS)).warnings).toEqual([])
      answer(RUNNING_WITH_DNS, new Error('serve: not supported'))
      expect((await new TailscaleTunnel({}).start(PORTS)).warnings).toEqual([])
    })

    it('warns when tailscaled runs in userspace-networking mode', async () => {
      answer(JSON.stringify({ ...JSON.parse(RUNNING_WITH_DNS) as object, TUN: false }), '{}')
      const result = await new TailscaleTunnel({}).start(PORTS)
      expect(result.warnings).toHaveLength(1)
      expect(result.warnings![0]).toMatch(/userspace/)
    })

    it('is quiet in TUN mode', async () => {
      answer(JSON.stringify({ ...JSON.parse(RUNNING_WITH_DNS) as object, TUN: true }), '{}')
      expect((await new TailscaleTunnel({}).start(PORTS)).warnings).toEqual([])
    })
  })
})
