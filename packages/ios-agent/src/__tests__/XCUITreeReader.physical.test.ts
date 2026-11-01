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

function setup(opts: { team?: string; bundlePrefix?: string; built?: string; tunnel?: () => Promise<string>; physical?: string[] } = {}) {
  const tokens: string[] = []
  const physical = new Set(opts.physical ?? ['udid-P'])
  const native = {
    sourceStamp: vi.fn(async () => 'stamp-1'),
    builtStamp: vi.fn((): string | undefined => opts.built),
    build: vi.fn(async (_destination: string, _stamp: string, _device?: { team: string; bundlePrefix?: string }) => {}),
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
    bundlePrefix: () => opts.bundlePrefix,
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
    expect(s.native.build).toHaveBeenCalledWith('platform=iOS,id=udid-P', 'stamp-1:TEAM123|udid-P', { team: 'TEAM123' })
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
    // The simulator runner answers /health and /tree only to the token too (any local process can reach its port).
    // Mutation: drop the header from either request — that runner then answers 401 and nothing is read.
    expect(calls.map((c) => c.url.split('?')[0]!.replace(/^http:\/\/localhost:\d+/, ''))).toEqual(expect.arrayContaining(['/health', '/tree']))
    expect(calls.every((c) => headerOf(c) === s.tokens[0])).toBe(true)
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

  // Mutations: drop the backoff (every write to a phone whose build failed runs xcodebuild again), or key it without the
  // team (a corrected team would wait out a failure it did not cause).
  it('does not build for a phone again right after its build failed, until the backoff is over or the team changes', async () => {
    let now = 1_000_000
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now)
    try {
      const s = setup({ team: 'TEAM123' })
      tokens = s.tokens
      s.native.build.mockRejectedValueOnce(new Error('xcodebuild: error: The device is locked.'))
      await expect(s.reader.read('udid-P', 'com.app')).rejects.toThrow(/device is locked/)
      now += 30_000
      await expect(s.reader.read('udid-P', 'com.app')).rejects.toThrow(/not built again for 60 s/)
      expect(s.native.build).toHaveBeenCalledTimes(1)
      now += 30_000
      await s.reader.read('udid-P', 'com.app')
      expect(s.native.build).toHaveBeenCalledTimes(2)
      s.reader.stop()

      const opts = { team: 'TEAM123' }
      const t = setup(opts)
      tokens = t.tokens
      t.native.build.mockRejectedValueOnce(new Error('signing failed'))
      await expect(t.reader.read('udid-P', 'com.app')).rejects.toThrow(/signing failed/)
      opts.team = 'TEAM456'
      await t.reader.read('udid-P', 'com.app')
      expect(t.native.build).toHaveBeenCalledTimes(2)
      t.reader.stop()
    } finally {
      clock.mockRestore()
    }
  })

  // Mutations: keep one failure for every phone (each phone's failure replaces the other's, so two failing phones
  // rebuild on every write), or never forget a phone's failure once its build succeeds.
  it('keeps each failing phone in its own backoff, and forgets the failure of a phone whose build succeeds', async () => {
    let now = 1_000_000
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now)
    try {
      const s = setup({ team: 'TEAM123', physical: ['udid-P', 'udid-Q'] })
      tokens = s.tokens
      s.native.build.mockRejectedValue(new Error('xcodebuild: error: The device is locked.'))
      await expect(s.reader.read('udid-P', 'com.app')).rejects.toThrow(/device is locked/)
      await expect(s.reader.read('udid-Q', 'com.app')).rejects.toThrow(/device is locked/)
      now += 10_000
      for (const udid of ['udid-P', 'udid-Q', 'udid-P', 'udid-Q']) {
        await expect(s.reader.read(udid, 'com.app')).rejects.toThrow(/not built again for 60 s/)
      }
      expect(s.native.build).toHaveBeenCalledTimes(2)
      now += 60_000
      s.native.build.mockResolvedValue(undefined)
      await s.reader.read('udid-P', 'com.app')
      expect(s.native.build).toHaveBeenCalledTimes(3)
      expect((s.reader as unknown as { deviceBuildFailures: Map<string, unknown> }).deviceBuildFailures.has('udid-P|TEAM123|')).toBe(false)
      s.reader.stop()
    } finally {
      clock.mockRestore()
    }
  })

  // A phone that joined another phone's build did not run its own, so it is not held back by that build's failure.
  // Mutation: record the failure for the phone that joined too — its own build then waits out a failure it did not run.
  it('does not hold back a phone that only joined the build that failed', async () => {
    const s = setup({ team: 'TEAM123', physical: ['udid-P', 'udid-Q'] })
    tokens = s.tokens
    s.native.build.mockRejectedValueOnce(new Error('xcodebuild: error: The device is locked.'))
    const reads = await Promise.allSettled([s.reader.read('udid-P', 'com.app'), s.reader.read('udid-Q', 'com.app')])
    expect(reads.map((r) => r.status)).toEqual(['rejected', 'rejected'])
    expect(s.native.build).toHaveBeenCalledTimes(1)
    await expect(s.reader.read('udid-P', 'com.app')).rejects.toThrow(/not built again for 60 s/)
    await s.reader.read('udid-Q', 'com.app')
    expect(s.native.build).toHaveBeenCalledTimes(2)
    expect(s.native.build.mock.calls[1]![0]).toBe('platform=iOS,id=udid-Q')
    s.reader.stop()
  })

  // Mutation: compare the built stamp against the bare source stamp. A build signed by another team would then be
  // reused, and installing it fails with a provisioning error.
  it('rebuilds when the team changed, and reuses a build by the same team', async () => {
    const same = setup({ team: 'TEAM123', built: 'stamp-1:TEAM123|udid-P' })
    tokens = same.tokens
    await same.reader.read('udid-P', 'com.app')
    expect(same.native.builtStamp).toHaveBeenCalledWith('physical')
    expect(same.native.build).not.toHaveBeenCalled()
    same.reader.stop()

    const other = setup({ team: 'TEAM456', built: 'stamp-1:TEAM123|udid-P' })
    tokens = other.tokens
    await other.reader.read('udid-P', 'com.app')
    expect(other.native.build).toHaveBeenCalledTimes(1)
    other.reader.stop()
  })

  // Mutation: leave the device out of the stamp (or its check). A second phone then skips the build that registers it
  // and puts it in the profile, and `test-without-building`, which does not re-sign, cannot install the runner there.
  it('rebuilds for a phone the build was not made for, keeping the phones it was', async () => {
    const s = setup({ team: 'TEAM123', built: 'stamp-1:TEAM123|udid-P', physical: ['udid-P', 'udid-Q'] })
    tokens = s.tokens
    await s.reader.read('udid-Q', 'com.app')
    expect(s.native.build).toHaveBeenCalledWith('platform=iOS,id=udid-Q', 'stamp-1:TEAM123|udid-P,udid-Q', { team: 'TEAM123' })
    s.reader.stop()
  })

  // Mutation: let a phone that joined another phone's build in flight return with it. That build was for the first
  // phone only, so the second would run products its profile does not name.
  it('builds again for a phone that joined another phone\'s build', async () => {
    const s = setup({ team: 'TEAM123', physical: ['udid-P', 'udid-Q'] })
    let built: string | undefined
    s.native.builtStamp.mockImplementation(() => built)
    s.native.build.mockImplementation(async (_d: string, stamp: string) => { built = stamp })
    tokens = s.tokens
    await Promise.all([s.reader.read('udid-P', 'com.app'), s.reader.read('udid-Q', 'com.app')])
    expect(s.native.build.mock.calls.map((c) => c[1])).toEqual(['stamp-1:TEAM123|udid-P', 'stamp-1:TEAM123|udid-P,udid-Q'])
    s.reader.stop()
  })

  // Mutation: keep the simulator's "check Xcode/simulator state" for a phone, or drop xcodebuild's own lines — the
  // tester is sent to a simulator that is not involved, without the reason xcodebuild printed.
  it('says what to check on the phone, with xcodebuild\'s reason, when its runner exits before it is ready', async () => {
    const s = setup({ team: 'T' })
    s.native.spawn.mockImplementation((): ChildProcess => {
      const proc = fakeProc()
      queueMicrotask(() => {
        proc.stdout.emit('data', 'Testing started\nxcodebuild: error: The device is locked.\n')
        proc.exitCode = 65
        proc.emit('exit', 65, null)
      })
      return proc as unknown as ChildProcess
    })
    await expect(s.reader.read('udid-P', 'com.app')).rejects.toThrow(/device is unlocked, trusts this Mac.*The device is locked/)
    s.reader.stop()
  })

  // App IDs are unique across every Apple team, so a team that cannot register `dev.tapflow.treerunner.*` signs under
  // its own prefix. Mutation: leave the prefix out of the stamp — a prefix change reuses products signed under the old
  // IDs — or out of `build` — the device build ignores it.
  it('builds under a bundle prefix when one is set, and rebuilds when it changes', async () => {
    const s = setup({ team: 'TEAM123', bundlePrefix: 'com.example.tapflow', built: 'stamp-1:TEAM123|udid-P' })
    tokens = s.tokens
    await s.reader.read('udid-P', 'com.app')
    expect(s.native.build).toHaveBeenCalledWith('platform=iOS,id=udid-P', 'stamp-1:TEAM123:com.example.tapflow|udid-P', { team: 'TEAM123', bundlePrefix: 'com.example.tapflow' })
    s.reader.stop()
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

    // Mutations: keep only that it failed (a Set), not why — the tester would read "not ready" with nothing to act on,
    // while the reason (here, no team) sits in the agent's log on another Mac; or forget it as soon as a retry starts —
    // an input refused during that retry would lose it too.
    it('keeps why the last start failed through a retry, until a start succeeds', async () => {
      let team: string | undefined = undefined
      const s = setup({})
      const reader = new XCUITreeReader(s.native, { platformOf: () => 'physical', team: () => team })
      tokens = s.tokens
      const client = reader.inputClient('udid-P')
      expect(client.lastError?.()).toBeNull()
      await expect(client.request('/tap?x=0.5&y=0.5')).rejects.toThrow()
      expect(client.lastError?.()).toMatch(/TAPFLOW_IOS_TEAM_ID/)
      team = 'T'
      const retry = client.request('/tap?x=0.5&y=0.5')
      expect(client.state()).toBe('starting')
      expect(client.lastError?.()).toMatch(/TAPFLOW_IOS_TEAM_ID/)
      await retry
      expect(client.lastError?.()).toBeNull()
      reader.stop()
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
  // Mutation: drop the setting from the args — the project keeps `dev.tapflow.treerunner` and signing fails for a
  // team that cannot register it.
  it('passes a bundle prefix to the project only when one is set', () => {
    expect(xcodebuildArgs('build-for-testing', 'platform=iOS,id=P', { team: 'T', bundlePrefix: 'com.example.tapflow' }))
      .toContain('TAPFLOW_RUNNER_BUNDLE_PREFIX=com.example.tapflow.treerunner')
    expect(xcodebuildArgs('build-for-testing', 'platform=iOS,id=P', { team: 'T' }).some((a) => a.startsWith('TAPFLOW_RUNNER_BUNDLE_PREFIX'))).toBe(false)
  })

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
