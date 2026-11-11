// `tapflow maestro` — the run itself, with fake processes: which port holder may be ended,
// that Maestro and iproxy never outlive the run, and the exit codes the command promises (0/1/2/130).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { cmdMaestro, type CommandDeps } from '../../maestro/command'
import { DeviceUnavailable, portHolderVerdict, prepareDevice, runMaestroProcess, type RunDeps } from '../../maestro/run'
import type { IosCandidate, MaestroDevice } from '../../maestro/device'

const UDID = '00008140-0001111111111111'
const OTHER = '00008110-0002222222222222'
const iphone: MaestroDevice = { platform: 'ios', udid: UDID, tapflowId: UDID, name: 'Test iPhone' }
const android: MaestroDevice = { platform: 'android', serial: 'SERIAL0001', tapflowId: 'usb:SERIAL0001', name: 'SERIAL0001' }
const readyIphone: IosCandidate = { udid: UDID, name: 'Test iPhone', ready: true }

/** A child process that ends when told to: `close(code)` or, on `kill`, with the signal. */
class FakeChild extends EventEmitter {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  killed: (string | number | undefined)[] = []
  constructor(readonly cmd: string, readonly args: string[]) { super() }
  kill(sig?: string | number) {
    this.killed.push(sig ?? 'SIGTERM')
    if (this.exitCode === null && this.signalCode === null) setImmediate(() => this.close(null, (sig as NodeJS.Signals) ?? 'SIGTERM'))
    return true
  }
  close(code: number | null, sig: NodeJS.Signals | null = null) {
    if (this.exitCode !== null || this.signalCode !== null) return
    this.exitCode = code
    this.signalCode = sig
    this.emit('close', code, sig)
  }
}

interface Harness {
  deps: RunDeps
  spawned: FakeChild[]
  killedPids: number[]
  said: string[]
  /** What `exec` answers, by command. */
  exec: Record<string, (args: string[]) => string>
  /** How the maestro child behaves once spawned. */
  maestro: (child: FakeChild) => void
}

function harness(): Harness {
  const h: Harness = {
    spawned: [], killedPids: [], said: [], exec: {},
    maestro: (c) => setImmediate(() => { c.stdout.emit('data', Buffer.from('ok\n')); c.close(0) }),
    deps: undefined as unknown as RunDeps,
  }
  h.deps = {
    spawn: (cmd, args) => {
      const c = new FakeChild(cmd, args)
      h.spawned.push(c)
      if (cmd !== 'iproxy') h.maestro(c)
      return c as unknown as ChildProcess
    },
    exec: async (cmd, args) => {
      const f = h.exec[cmd]
      if (!f) return ''
      return f(args)
    },
    sleep: async () => {},
    say: (l) => { h.said.push(l) },
    out: () => {},
    kill: (pid) => { h.killedPids.push(pid) },
  }
  return h
}

describe('the iOS driver port', () => {
  it('may end only an iproxy left for the same phone', () => {
    expect(portHolderVerdict(`iproxy 22087 22087 -u ${UDID}`, 22087, UDID)).toBe('ours')
    expect(portHolderVerdict(`/opt/homebrew/bin/iproxy 22087 22087 -u ${UDID.toLowerCase()}`, 22087, UDID)).toBe('ours')
    expect(portHolderVerdict(`iproxy 22087 22087 -u ${OTHER}`, 22087, UDID)).toBe('other-phone')
    expect(portHolderVerdict('iproxy 22087 22087', 22087, UDID)).toBe('other-phone')
    expect(portHolderVerdict('/usr/bin/python3 -m http.server 22087', 22087, UDID)).toBe('foreign')
    expect(portHolderVerdict('', 22087, UDID)).toBe('foreign')
  })

  it('frees the port from our own leftover iproxy, then launches the app', async () => {
    const h = harness()
    h.exec.lsof = () => '4242\n'
    h.exec.ps = () => `iproxy 22087 22087 -u ${UDID}\n`
    const launched: string[][] = []
    h.exec.xcrun = (a) => { launched.push(a); return '' }
    await prepareDevice(iphone, 'com.example.app', h.deps)
    expect(h.killedPids).toEqual([4242])
    expect(launched[0]).toEqual(expect.arrayContaining(['launch', '--device', UDID, 'com.example.app']))
  })

  it('refuses — and ends nothing — when another iPhone\'s run holds the port, or another program does', async () => {
    for (const holder of [`iproxy 22087 22087 -u ${OTHER}`, 'node relay.js']) {
      const h = harness()
      h.exec.lsof = () => '777\n'
      h.exec.ps = () => holder
      await expect(prepareDevice(iphone, 'app', h.deps)).rejects.toThrow(DeviceUnavailable)
      expect(h.killedPids).toEqual([])
    }
  })

  it('wakes an Android phone and touches no port', async () => {
    const h = harness()
    const adb: string[][] = []
    h.exec.adb = (a) => { adb.push(a); return '' }
    h.exec.lsof = () => { throw new Error('not for android') }
    await prepareDevice(android, 'app', h.deps)
    expect(adb).toEqual([['-s', 'SERIAL0001', 'shell', 'input', 'keyevent', 'KEYCODE_WAKEUP']])
  })
})

describe('the Maestro process', () => {
  let dir: string
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-run-')) })
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })
  const base = (signal?: AbortSignal) => ({ maestroBin: 'maestro', argv: [], env: {}, cwd: dir, logFile: path.join(dir, 'maestro.log'), signal })

  it('never starts iproxy for a Maestro that ended before the forward was due', async () => {
    const h = harness()
    const r = await runMaestroProcess({ ...base(), device: iphone, iproxyDelayMs: 50 }, h.deps)
    await new Promise((res) => setTimeout(res, 80))
    expect(r.exitCode).toBe(0)
    expect(h.spawned.map((c) => c.cmd)).toEqual(['maestro'])
    expect(fs.readFileSync(path.join(dir, 'maestro.log'), 'utf8')).toBe('ok\n')
  })

  it('ends iproxy when Maestro ends', async () => {
    const h = harness()
    h.maestro = (c) => setTimeout(() => c.close(1), 40)
    const r = await runMaestroProcess({ ...base(), device: iphone, iproxyDelayMs: 5 }, h.deps)
    expect(r.exitCode).toBe(1)
    const iproxy = h.spawned.find((c) => c.cmd === 'iproxy')!
    expect(iproxy.args).toEqual(['22087', '22087', '-u', UDID])
    expect(iproxy.killed.length).toBe(1)
  })

  it('on the signal, stops Maestro with SIGINT and says it was interrupted', async () => {
    const h = harness()
    h.maestro = () => { /* runs until told */ }
    const abort = new AbortController()
    const p = runMaestroProcess({ ...base(abort.signal), device: android }, h.deps)
    setTimeout(() => abort.abort(), 10)
    const r = await p
    expect(r.interrupted).toBe(true)
    expect(h.spawned[0].killed).toEqual(['SIGINT'])
  })

  it('starts nothing once the signal came first', async () => {
    const h = harness()
    const abort = new AbortController()
    abort.abort()
    const r = await runMaestroProcess({ ...base(abort.signal), device: android }, h.deps)
    expect(r).toMatchObject({ interrupted: true, exitCode: 130 })
    expect(h.spawned).toEqual([])
  })

  it('leaves no exit listener behind', async () => {
    const before = process.listenerCount('exit')
    await runMaestroProcess({ ...base(), device: android }, harness().deps)
    expect(process.listenerCount('exit')).toBe(before)
  })
})

describe('tapflow maestro — exit codes', () => {
  let dir: string
  let flow: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-cmd-'))
    flow = path.join(dir, 'c1.yaml')
    fs.writeFileSync(flow, 'appId: ${APP_ID}\nname: c1\n---\n- tapOn: a\n')
  })
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks() })

  function cmdDeps(h: Harness, over: Partial<CommandDeps> = {}): CommandDeps & { fire: () => void } {
    let handler: (() => void) | undefined
    return {
      ...h.deps,
      readyDevices: () => ({ adb: ['SERIAL0001'], ios: [readyIphone] }),
      findMaestro: () => '/bin/maestro',
      hasProgram: () => true,
      processEnv: {},
      homeDir: dir,
      onSignal: (fn) => { handler = fn; return () => { handler = undefined } },
      fire: () => handler?.(),
      ...over,
    }
  }
  // A relay that refuses at once: the run is not recorded, and nothing waits on it.
  const run = (deps: CommandDeps, device = 'SERIAL0001') =>
    cmdMaestro(flow, { device, record: false, relay: 'ws://127.0.0.1:9', outputDir: path.join(dir, 'out') }, deps)

  it('0 when the flow passes, 1 when it fails', async () => {
    const h = harness()
    expect(await run(cmdDeps(h))).toBe(0)
    h.maestro = (c) => setImmediate(() => c.close(1))
    expect(await run(cmdDeps(h))).toBe(1)
  })

  it('2 when it cannot run: no such phone, no maestro, no iproxy for an iPhone, an iPhone run already going on', async () => {
    expect(await run(cmdDeps(harness()), 'nope')).toBe(2)
    expect(await run(cmdDeps(harness(), { findMaestro: () => null }))).toBe(2)
    expect(await run(cmdDeps(harness(), { hasProgram: () => false }), UDID)).toBe(2)
    const h = harness()
    h.exec.lsof = () => '777\n'
    h.exec.ps = () => `iproxy 22087 22087 -u ${OTHER}`
    expect(await run(cmdDeps(h), UDID)).toBe(2)
    expect(h.spawned).toEqual([])
  })

  it('2, not 1, for an error nobody planned for', async () => {
    const deps = cmdDeps(harness(), { readyDevices: () => { throw new Error('boom') } })
    expect(await run(deps)).toBe(2)
  })

  it('130 when SIGINT/SIGTERM arrives, with Maestro stopped and the listener gone', async () => {
    const h = harness()
    h.maestro = () => { /* runs until told */ }
    const deps = cmdDeps(h)
    const p = run(deps)
    await new Promise((r) => setTimeout(r, 30))
    deps.fire()
    expect(await p).toBe(130)
    expect(h.spawned[0].killed).toEqual(['SIGINT'])
    deps.fire() // listener removed: nothing left to stop
  })

  it('passes test data from the environment to Maestro, and clears an earlier run\'s debug output', async () => {
    const h = harness()
    const out = path.join(dir, 'out', 'maestro-debug')
    fs.mkdirSync(out, { recursive: true })
    fs.writeFileSync(path.join(out, 'commands-(old.yaml).json'), '[]')
    expect(await run(cmdDeps(h, { processEnv: { TEST_PIN: '012345' } }))).toBe(0)
    expect(h.spawned[0].args).toEqual(expect.arrayContaining(['-e', 'TEST_PIN=012345']))
    expect(fs.existsSync(path.join(out, 'commands-(old.yaml).json'))).toBe(false)
  })
})
