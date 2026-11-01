import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'events'
import type { ChildProcess } from 'child_process'
import {
  XCUITreeReader,
  parseTunnelAddress,
  urlHost,
  xcodebuildArgs,
  TOKEN_HEADER,
  type RunnerNative,
  type RunnerPlatform,
} from '../XCUITreeReader'

type FakeProc = EventEmitter & {
  pid?: number
  exitCode: number | null
  signalCode: string | null
  killed: boolean
  kill: () => boolean
  stdout: EventEmitter
}

function fakeProc(): FakeProc {
  const p = new EventEmitter() as FakeProc
  p.pid = undefined
  p.exitCode = null
  p.signalCode = null
  p.killed = false
  p.stdout = new EventEmitter()
  p.kill = vi.fn(() => {
    p.killed = true
    queueMicrotask(() => p.emit('exit', null, 'SIGTERM'))
    return true
  })
  return p
}

const TREE = "Attributes: Application, 0x1, pid: 1, label: 'App'\nElement subtree:\n →Application, 0x1, pid: 1, label: 'App'\n"
const TUNNEL = 'fd11:c847:b35a::1'
const PORT = 24000

interface Call { url: string; init: RequestInit | undefined }

function setup(opts: { team?: string; built?: string; tunnel?: () => Promise<string>; physical?: string[] } = {}) {
  const tokens: string[] = []
  const physical = new Set(opts.physical ?? ['udid-P'])
  const native = {
    sourceStamp: vi.fn(async () => 'stamp-1'),
    builtStamp: vi.fn((): string | undefined => opts.built),
    build: vi.fn(async () => {}),
    spawn: vi.fn((_destination: string, token: string): ChildProcess => {
      tokens.push(token)
      const proc = fakeProc()
      queueMicrotask(() => proc.stdout.emit('data', `TAPFLOW_TREE_READY port=${PORT}\n`))
      return proc as unknown as ChildProcess
    }),
    terminateRunner: vi.fn(),
    tunnelAddress: vi.fn(opts.tunnel ?? (async () => TUNNEL)),
  } satisfies RunnerNative
  const reader = new XCUITreeReader(native, {
    platformOf: (udid): RunnerPlatform => (physical.has(udid) ? 'physical' : 'simulator'),
    team: () => opts.team,
  })
  return { native, reader, tokens }
}

describe('XCUITreeReader on a physical device', () => {
  let calls: Call[]
  let inputAnswer: () => Response
  let tokens: string[]
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    if (url.includes('/health')) return new Response(tokens.at(-1) ?? '')
    if (url.includes('/tree')) return new Response(TREE)
    return inputAnswer()
  })
  const headerOf = (c: Call): string | undefined => (c.init?.headers as Record<string, string> | undefined)?.[TOKEN_HEADER]

  beforeEach(() => {
    calls = []
    inputAnswer = () => new Response('{"ok":true}', { status: 200 })
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => {
    fetchMock.mockClear()
    vi.unstubAllGlobals()
  })

  // Mutation: keep `platform=iOS Simulator` for every device. xcodebuild then looks for a simulator with the
  // iPhone's UDID and fails with "Unable to find a destination".
  it('builds and spawns for the device destination, signed by the team, and binds beyond loopback', async () => {
    const s = setup({ team: 'TEAM123' })
    tokens = s.tokens
    await s.reader.read('udid-P', 'com.app')
    expect(s.native.build).toHaveBeenCalledWith('platform=iOS,id=udid-P', 'stamp-1:TEAM123', { team: 'TEAM123' })
    expect(s.native.spawn).toHaveBeenCalledWith('platform=iOS,id=udid-P', s.tokens[0], 'physical')
    s.reader.stop()
  })

  // Mutation: pass `platform` to the simulator calls too. The simulator call shape is what the existing runner
  // contract (and its 44 tests) pin; a third argument there would change the spawn's environment.
  it('keeps the simulator calls exactly as they were', async () => {
    const s = setup({ team: 'TEAM123', built: 'stamp-0' })
    tokens = s.tokens
    await s.reader.read('udid-S', 'com.app')
    expect(s.native.build).toHaveBeenCalledWith('platform=iOS Simulator,id=udid-S', 'stamp-1')
    expect(s.native.build.mock.calls[0]).toHaveLength(2)
    expect(s.native.spawn.mock.calls[0]).toHaveLength(2)
    expect(s.native.tunnelAddress).not.toHaveBeenCalled()
    expect(calls.every((c) => c.url.startsWith(`http://localhost:${PORT}/`))).toBe(true)
    s.reader.stop()
    expect(s.native.terminateRunner).toHaveBeenCalledWith('udid-S')
  })

  // Mutation: drop the team check. The build then runs unsigned and fails minutes later with xcodebuild's log.
  it('refuses to build without a team, naming the variable, and spawns nothing', async () => {
    const s = setup({})
    tokens = s.tokens
    await expect(s.reader.read('udid-P', 'com.app')).rejects.toThrow(/TAPFLOW_IOS_TEAM_ID/)
    expect(s.native.build).not.toHaveBeenCalled()
    expect(s.native.spawn).not.toHaveBeenCalled()
  })

  // Mutation: compare the built stamp against the bare source stamp. A build signed by another team would then be
  // reused, and installing it fails with a provisioning error.
  it('rebuilds when the team changed, and reuses a build by the same team', async () => {
    const same = setup({ team: 'TEAM123', built: 'stamp-1:TEAM123' })
    tokens = same.tokens
    await same.reader.read('udid-P', 'com.app')
    expect(same.native.builtStamp).toHaveBeenCalledWith('physical')
    expect(same.native.build).not.toHaveBeenCalled()
    same.reader.stop()

    const other = setup({ team: 'TEAM456', built: 'stamp-1:TEAM123' })
    tokens = other.tokens
    await other.reader.read('udid-P', 'com.app')
    expect(other.native.build).toHaveBeenCalledTimes(1)
    other.reader.stop()
  })

  // Mutation: keep `localhost` for a device. Its runner listens on the device, so /health is refused until the
  // 90 s deadline.
  it('talks to the runner at the device tunnel address, carrying the token', async () => {
    const s = setup({ team: 'T' })
    tokens = s.tokens
    await s.reader.read('udid-P', 'com.app')
    expect(calls.map((c) => c.url)).toEqual([
      `http://[${TUNNEL}]:${PORT}/health`,
      `http://[${TUNNEL}]:${PORT}/tree?bundleId=com.app`,
    ])
    expect(calls.every((c) => headerOf(c) === s.tokens[0])).toBe(true)
    s.reader.stop()
  })

  // Mutation: spawn before resolving the tunnel. A runner would start on a device the Mac cannot reach and hold it
  // until the deadline.
  it('fails before spawning when the device has no tunnel', async () => {
    const s = setup({ team: 'T', tunnel: async () => { throw new Error('tunnel is not connected') } })
    tokens = s.tokens
    await expect(s.reader.read('udid-P', 'com.app')).rejects.toThrow(/cannot reach udid-P: tunnel is not connected/)
    expect(s.native.spawn).not.toHaveBeenCalled()
  })

  // Mutation: call `terminateRunner` for every platform. It runs `simctl terminate` with a hardware UDID.
  it('does not ask simctl to terminate a device runner', async () => {
    const s = setup({ team: 'T' })
    tokens = s.tokens
    await s.reader.read('udid-P', 'com.app')
    s.reader.stop()
    expect(s.native.terminateRunner).not.toHaveBeenCalled()
  })

  describe('input', () => {
    // Mutation: send the text as a query parameter or a GET. The runner reads a POST body only.
    it('POSTs typed text as the body, with the token', async () => {
      const s = setup({ team: 'T' })
      tokens = s.tokens
      await s.reader.input('udid-P', '/type?bundleId=com.app', 'héllo')
      const c = calls.find((x) => x.url.includes('/type'))!
      expect(c.url).toBe(`http://[${TUNNEL}]:${PORT}/type?bundleId=com.app`)
      expect(c.init?.method).toBe('POST')
      expect(c.init?.body).toBe('héllo')
      expect(headerOf(c)).toBe(s.tokens[0])
      s.reader.stop()
    })

    // Mutation: resolve on any 2xx. A runner that answers `{"ok":false}` would then read as delivered.
    it('rejects with the runner\'s own reason when it refuses', async () => {
      const s = setup({ team: 'T' })
      tokens = s.tokens
      inputAnswer = () => new Response('{"ok":false,"error":"no element has keyboard focus"}', { status: 409 })
      await expect(s.reader.input('udid-P', '/key?name=return')).rejects.toThrow(/refused \/key: no element has keyboard focus/)
      s.reader.stop()
    })

    // Mutation: drop the 404 hint. A runner built before the input routes answers plain text and the caller learns
    // nothing about rebuilding.
    it('names a runner that predates input', async () => {
      const s = setup({ team: 'T' })
      tokens = s.tokens
      inputAnswer = () => new Response('unknown route', { status: 404 })
      await expect(s.reader.input('udid-P', '/tap?x=0.5&y=0.5')).rejects.toThrow(/predates input/)
      s.reader.stop()
    })

    // Mutation: report `starting` forever after a failed start. The agent would then answer `channel-starting`
    // ("retry in a moment") to a device that cannot start without the user setting a team.
    it('reports unavailable after a failed start, and starting again once a new start is under way', async () => {
      const s = setup({})
      tokens = s.tokens
      const client = s.reader.inputClient('udid-P')
      expect(client.state()).toBe('starting')
      await expect(client.request('/tap?x=0.5&y=0.5')).rejects.toThrow(/TAPFLOW_IOS_TEAM_ID/)
      expect(client.state()).toBe('unavailable')
    })
  })
})

describe('xcodebuildArgs', () => {
  // Mutation: change any simulator argument. The simulator path must stay byte-for-byte what it was.
  it('keeps the simulator arguments', () => {
    const sim = 'platform=iOS Simulator,id=S'
    const build = xcodebuildArgs('build-for-testing', sim)
    expect(build[0]).toBe('build-for-testing')
    expect(build.slice(-1)).toEqual(['-quiet'])
    expect(build.slice(5, 9)).toEqual(['-destination', sim, '-derivedDataPath', expect.stringMatching(/xctest-runner\/build$/)])
    expect(build).toHaveLength(10)
    expect(xcodebuildArgs('test-without-building', sim)).toEqual(['test-without-building', ...build.slice(1, -1)])
  })

  // Mutation: share `build/` across platforms. The device build would then overwrite the simulator's .xctestrun.
  it('gives a device its own products dir, provisioning updates and the team', () => {
    const args = xcodebuildArgs('build-for-testing', 'platform=iOS,id=P', { team: 'TEAM123' })
    expect(args).toContain('-allowProvisioningUpdates')
    expect(args).toContain('DEVELOPMENT_TEAM=TEAM123')
    expect(args[args.indexOf('-derivedDataPath') + 1]).toMatch(/xctest-runner\/build-iphoneos$/)
    expect(xcodebuildArgs('test-without-building', 'platform=iOS,id=P', {}).some((a) => a.startsWith('DEVELOPMENT_TEAM'))).toBe(false)
  })
})

describe('parseTunnelAddress', () => {
  const doc = (conn: Record<string, unknown>) => ({ result: { connectionProperties: conn } })

  // Mutation: read another field (e.g. `localHostnames`). This is the field devicectl reports, measured.
  it('reads the tunnel address of a connected device', () => {
    expect(parseTunnelAddress(doc({ tunnelState: 'connected', tunnelIPAddress: TUNNEL }))).toBe(TUNNEL)
  })

  // Mutation: ignore `tunnelState`. A stale address from a disconnected tunnel would be dialled until the deadline.
  it('has none while the tunnel is down', () => {
    expect(parseTunnelAddress(doc({ tunnelState: 'disconnected', tunnelIPAddress: TUNNEL }))).toBeUndefined()
    expect(parseTunnelAddress({})).toBeUndefined()
  })

  // Mutation: interpolate the IPv6 literal bare. `http://fd11::1:24000` does not parse as a host and port.
  it('brackets an IPv6 address for a URL', () => {
    expect(urlHost(TUNNEL)).toBe(`[${TUNNEL}]`)
    expect(urlHost('localhost')).toBe('localhost')
  })
})
