import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest'
import { EventEmitter } from 'events'

const mockProcess = () => {
  const proc = new EventEmitter() as ReturnType<typeof import('child_process').spawn>
  const stderr = new EventEmitter()
  const stdout = new EventEmitter()
  Object.assign(proc, { stdout, stderr, kill: vi.fn(), pid: 1234 })
  return proc
}

vi.mock('child_process', () => ({ spawn: vi.fn(), execFileSync: vi.fn() }))
vi.mock('fs', () => ({
  default: {
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    unlinkSync: vi.fn(),
  },
}))
vi.mock('os', () => ({ default: { tmpdir: () => '/tmp' } }))
vi.mock('../../lib/ssh.js', () => ({
  sshExec: vi.fn(),
  scpUpload: vi.fn(),
}))
vi.mock('../../lib/download-binary.js', () => ({
  downloadBinary: vi.fn().mockResolvedValue('/home/user/.tapflow/bin/rathole-darwin-arm64'),
  cachedBinaryPath: vi.fn().mockReturnValue('/home/user/.tapflow/bin/rathole-darwin-arm64'),
}))

import { spawn, execFileSync } from 'child_process'
import fs from 'fs'
import { sshExec, scpUpload } from '../../lib/ssh.js'
import { downloadBinary } from '../../lib/download-binary.js'
import { RatholeTunnel } from '../../lib/rathole-tunnel.js'

const SSH = { host: 'vps.example.com', user: 'ubuntu', keyPath: '~/.ssh/id_rsa' }

const PORTS = { relayPort: 4000, tunnelPort: 4001 }

const BASE_OPTS = {
  serverAddr: 'vps.example.com:2333',
  publicUrl: 'https://vps.example.com',
  token: 'secret',
}

describe('RatholeTunnel', () => {
  let proc: ReturnType<typeof mockProcess>

  beforeEach(() => {
    vi.resetAllMocks()
    proc = mockProcess()
    vi.mocked(spawn).mockReturnValue(proc as never)
    vi.mocked(sshExec).mockResolvedValue('')
    vi.mocked(scpUpload).mockResolvedValue(undefined)
    vi.mocked(downloadBinary).mockResolvedValue('/home/user/.tapflow/bin/rathole-darwin-arm64')
    vi.mocked(execFileSync).mockReturnValue('')
  })

  afterEach(() => vi.restoreAllMocks())

  // ── start() ──────────────────────────────────────────
  it('start() — rathole client spawn 후 publicUrl 반환', async () => {
    const tunnel = new RatholeTunnel(BASE_OPTS)
    const startPromise = tunnel.start(PORTS)
    await Promise.resolve() // downloadBinary microtask 완료 대기
    proc.stderr!.emit('data', Buffer.from('[INFO] Tunnel started\n'))
    const result = await startPromise
    expect(spawn).toHaveBeenCalled()
    expect(result.publicUrl).toBe('https://vps.example.com')
  })

  // The relay port treats loopback as local and skips sign-in, so a client forwarding the public URL there
  // would hand that exemption to everyone who has the URL.
  it('start() — the client forwards to the tunnel port, never the relay port', async () => {
    const tunnel = new RatholeTunnel(BASE_OPTS)
    const startPromise = tunnel.start({ relayPort: 4000, tunnelPort: 4555 })
    await Promise.resolve()
    proc.stderr!.emit('data', Buffer.from('[INFO] Tunnel started\n'))
    await startPromise
    const toml = String(vi.mocked(fs.writeFileSync).mock.calls.at(-1)![1])
    expect(toml).toContain('local_addr = "127.0.0.1:4555"')
    expect(toml).not.toContain(':4000')
  })

  // A client left behind by a tapflow process that died without its SIGINT handler keeps forwarding —
  // and one from before the tunnel port existed forwards to the relay port.
  describe('start() — clients left by a tapflow process that is gone', () => {
    const TAPFLOW = '  111 node /Users/u/tapflow/packages/cli/bin/tapflow.js start'
    const ORPHAN_CLIENT = '  501 /Users/u/.tapflow/bin/rathole-darwin-arm64 --client /var/folders/x/T/tapflow-rathole-client-222.toml'
    const LIVE_CLIENT = '  502 /Users/u/.tapflow/bin/rathole-darwin-arm64 --client /tmp/tapflow-rathole-client-111.toml'
    const psOutput = (lines: string[]) => lines.join('\n') + '\n'
    let killSpy: MockInstance<typeof process.kill>

    beforeEach(() => {
      killSpy = vi.spyOn(process, 'kill').mockImplementation((() => true) as typeof process.kill)
    })

    const startOnce = async () => {
      const tunnel = new RatholeTunnel(BASE_OPTS)
      const startPromise = tunnel.start(PORTS)
      await Promise.resolve()
      proc.stderr!.emit('data', Buffer.from('[INFO] Tunnel started\n'))
      await startPromise
    }

    it('kills them before starting a new one', async () => {
      vi.mocked(execFileSync).mockReturnValue(psOutput([ORPHAN_CLIENT]))
      await startOnce()
      expect(killSpy).toHaveBeenCalledWith(501)
      expect(vi.mocked(execFileSync).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(spawn).mock.invocationCallOrder[0]!)
    })

    it('leaves a client whose tapflow process is still running, and unrelated processes', async () => {
      vi.mocked(execFileSync).mockReturnValue(psOutput([
        TAPFLOW,
        LIVE_CLIENT,
        '  503 vim /tmp/tapflow-rathole-client-222.toml',
        '  504 /usr/local/bin/rathole --client /etc/rathole/client.toml',
      ]))
      await startOnce()
      expect(killSpy).not.toHaveBeenCalled()
    })

    // A bare `kill(pid, 0)` answers yes for a pid the OS handed to something else, which would leave the
    // orphan forwarding to the relay port for the life of that machine.
    it('kills one whose owner pid came back as an unrelated process', async () => {
      vi.mocked(execFileSync).mockReturnValue(psOutput([
        '  222 /usr/sbin/cupsd -l -f',
        ORPHAN_CLIENT,
      ]))
      await startOnce()
      expect(killSpy).toHaveBeenCalledWith(501)
    })

    // "A node process" is not tapflow: the reused pid on a dev Mac is most likely another node one.
    it('kills one whose owner pid came back as an unrelated node process', async () => {
      vi.mocked(execFileSync).mockReturnValue(psOutput([
        '  222 /Users/u/.nvm/versions/node/v24.15.0/bin/node /Users/u/Library/lsp/server.js',
        ORPHAN_CLIENT,
      ]))
      await startOnce()
      expect(killSpy).toHaveBeenCalledWith(501)
    })

    // `startConfiguredTunnel` runs setupServer first, and a failure there never reaches start().
    it('also runs from setupServer, so a failure before start() still cleans up', async () => {
      vi.mocked(execFileSync).mockReturnValue(psOutput([ORPHAN_CLIENT]))
      vi.mocked(downloadBinary).mockRejectedValue(new Error('network down'))
      const tunnel = new RatholeTunnel({ ...BASE_OPTS, ssh: SSH })
      await expect(tunnel.setupServer()).rejects.toThrow()
      expect(killSpy).toHaveBeenCalledWith(501)
      expect(spawn).not.toHaveBeenCalled()
    })

    it('starts anyway when the process list cannot be read', async () => {
      vi.mocked(execFileSync).mockImplementation(() => { throw new Error('ps: not found') })
      await startOnce()
      expect(spawn).toHaveBeenCalled()
      expect(killSpy).not.toHaveBeenCalled()
    })
  })

  it('start() — 토큰 누락 시 에러', async () => {
    const tunnel = new RatholeTunnel({ ...BASE_OPTS, token: '' })
    await expect(tunnel.start(PORTS)).rejects.toThrow(/TAPFLOW_TUNNEL_TOKEN/)
  })

  it('start() — serverAddr 누락 시 에러', async () => {
    const tunnel = new RatholeTunnel({ ...BASE_OPTS, serverAddr: '' })
    await expect(tunnel.start(PORTS)).rejects.toThrow(/serverAddr/)
  })

  it('프로세스 exit(1) → start() reject', async () => {
    const tunnel = new RatholeTunnel(BASE_OPTS)
    const startPromise = tunnel.start(PORTS)
    await Promise.resolve() // downloadBinary microtask 완료 대기
    proc.emit('exit', 1)
    await expect(startPromise).rejects.toThrow(/exited/)
  })

  // ── setupServer() ─────────────────────────────────────
  it('setupServer() — ssh 없으면 no-op', async () => {
    const tunnel = new RatholeTunnel(BASE_OPTS)
    await tunnel.setupServer()
    expect(sshExec).not.toHaveBeenCalled()
    expect(scpUpload).not.toHaveBeenCalled()
  })

  it('setupServer() — rathole 이미 있으면 binary 업로드 생략', async () => {
    vi.mocked(sshExec).mockImplementation(async (_ssh, cmd) => {
      if (cmd.includes('which rathole')) return '/usr/local/bin/rathole'
      return ''
    })
    const tunnel = new RatholeTunnel({ ...BASE_OPTS, ssh: SSH })
    await tunnel.setupServer()
    expect(scpUpload).not.toHaveBeenCalledWith(SSH, expect.stringContaining('rathole-darwin-'), expect.anything())
  })

  it('setupServer() — rathole 없으면 linux binary 다운로드 후 scp 업로드', async () => {
    vi.mocked(sshExec).mockImplementation(async (_ssh, cmd) => {
      if (cmd.includes('which rathole')) throw new Error('not found')
      if (cmd.includes('uname -m')) return 'x86_64'
      return ''
    })
    vi.mocked(downloadBinary).mockResolvedValue('/home/user/.tapflow/bin/rathole-linux-x86_64')
    const tunnel = new RatholeTunnel({ ...BASE_OPTS, ssh: SSH })
    await tunnel.setupServer()
    expect(downloadBinary).toHaveBeenCalledWith('linux', 'x86_64')
    expect(scpUpload).toHaveBeenCalledWith(SSH, '/home/user/.tapflow/bin/rathole-linux-x86_64', '/tmp/tapflow/rathole')
  })

  it('setupServer() — server.toml scp 업로드 + 서버 실행', async () => {
    const tunnel = new RatholeTunnel({ ...BASE_OPTS, ssh: SSH })
    await tunnel.setupServer()
    expect(scpUpload).toHaveBeenCalledWith(SSH, expect.any(String), '/tmp/tapflow/rathole-server.toml')
    expect(sshExec).toHaveBeenCalledWith(SSH, expect.stringContaining('rathole'))
  })

  // ── stop() ────────────────────────────────────────────
  it('stop() — client kill + 임시 파일 삭제', async () => {
    const fs = await import('fs')
    const tunnel = new RatholeTunnel(BASE_OPTS)
    const startPromise = tunnel.start(PORTS)
    await Promise.resolve()
    proc.stderr!.emit('data', Buffer.from('[INFO] Tunnel started\n'))
    await startPromise
    await tunnel.stop()
    expect(vi.mocked(proc).kill).toHaveBeenCalled()
    expect(fs.default.unlinkSync).toHaveBeenCalled()
  })

  it('stop() — ssh 있으면 VPS server도 종료', async () => {
    const tunnel = new RatholeTunnel({ ...BASE_OPTS, ssh: SSH })
    await tunnel.setupServer()
    const startPromise = tunnel.start(PORTS)
    await Promise.resolve()
    proc.stderr!.emit('data', Buffer.from('[INFO] Tunnel started\n'))
    await startPromise
    await tunnel.stop()
    expect(sshExec).toHaveBeenCalledWith(SSH, expect.stringContaining('tapflow-rathole.pid'))
  })

  it('stop() — start 전 호출해도 에러 없음', async () => {
    const tunnel = new RatholeTunnel(BASE_OPTS)
    await expect(tunnel.stop()).resolves.toBeUndefined()
  })
})
