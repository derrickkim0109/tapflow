import { describe, it, expect, vi, afterEach } from 'vitest'
import { EventEmitter } from 'events'
import { GuestHelper, type GuestHelperNative } from '../GuestHelper.js'

// A `simctl spawn` child: the agent talks to guest-helper through it. Its own pid is the host process; the
// guest's pid arrives on stdout as `pid <n>`, and the two die separately (measured: kill -9 on simctl
// leaves the guest running).
type FakeProc = EventEmitter & {
  pid: number | undefined
  stdin: EventEmitter & { writable: boolean; write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> }
  stdout: EventEmitter
  stderr: EventEmitter
  kill: ReturnType<typeof vi.fn>
}

let nextPid = 7000
function makeProc(): FakeProc {
  const proc = new EventEmitter() as FakeProc
  proc.pid = nextPid++
  proc.stdin = Object.assign(new EventEmitter(), { writable: true, write: vi.fn(() => true), end: vi.fn() }) as never
  proc.stdout = new EventEmitter()
  proc.stderr = new EventEmitter()
  proc.kill = vi.fn(() => true)
  return proc
}
function say(proc: FakeProc, ...lines: string[]): void {
  proc.stdout.emit('data', Buffer.from(lines.map((l) => `${l}\n`).join('')))
}
function die(proc: FakeProc, code: number | null = 1): void {
  proc.stdin.writable = false
  proc.emit('exit', code)
}
const written = (proc: FakeProc) => proc.stdin.write.mock.calls.map((c) => String(c[0]))

function fakeNative(procs: FakeProc[], orphans: number[][] = []) {
  let i = 0
  let sweep = 0
  return {
    spawn: vi.fn<GuestHelperNative['spawn']>(() => procs[Math.min(i++, procs.length - 1)] as never),
    findOrphans: vi.fn<GuestHelperNative['findOrphans']>(async () => orphans[Math.min(sweep++, Math.max(orphans.length - 1, 0))] ?? []),
    killPid: vi.fn<GuestHelperNative['killPid']>(),
    unavailableReason: vi.fn<GuestHelperNative['unavailableReason']>(async () => null),
  }
}

async function started(procs: FakeProc[], opts: { orphans?: number[][]; panels?: string[] } = {}) {
  const native = fakeNative(procs, opts.orphans)
  const panels = opts.panels ?? ['COVER', 'OPEN']
  const helper = new GuestHelper('UDID-1', async () => panels, native)
  await helper.start()
  return { helper, native }
}
const flush = () => new Promise((r) => setImmediate(r))

afterEach(() => vi.useRealTimers())

describe('GuestHelper start', () => {
  it('spawns the helper inside the simulator, detached, with its identifying argv and every panel', async () => {
    const proc = makeProc()
    const { native } = await started([proc])
    expect(native.spawn).toHaveBeenCalledTimes(1)
    const [udid, args] = native.spawn.mock.calls[0]
    expect(udid).toBe('UDID-1')
    expect(args).toEqual(['--udid', 'UDID-1', '--touchscreen', 'COVER', '--touchscreen', 'OPEN'])
  })

  it('kills orphans of an earlier agent before spawning, and only after the sweep', async () => {
    const proc = makeProc()
    const order: string[] = []
    const native = fakeNative([proc], [[111, 222]])
    native.findOrphans.mockImplementation(async () => { order.push('sweep'); return [111, 222] })
    native.killPid.mockImplementation((pid: number) => order.push(`kill ${pid}`))
    native.spawn.mockImplementation((() => { order.push('spawn'); return proc }) as never)
    await new GuestHelper('UDID-1', async () => ['COVER'], native).start()
    expect(order).toEqual(['sweep', 'kill 111', 'kill 222', 'spawn'])
  })

  it('is starting while it sweeps and reads the panels, before anything is spawned', async () => {
    const proc = makeProc()
    let releasePanels: (p: string[]) => void = () => {}
    const native = fakeNative([proc])
    const helper = new GuestHelper('UDID-1', () => new Promise((r) => { releasePanels = r }), native)
    const starting = helper.start()
    await flush()
    expect(native.spawn).not.toHaveBeenCalled()
    expect(helper.inputState()).toBe('starting')
    releasePanels(['NEW-UUID'])
    await starting
    expect(native.spawn.mock.calls[0][1]).toEqual(['--udid', 'UDID-1', '--touchscreen', 'NEW-UUID'])
  })

  it('reads the panels again on a respawn, since they change with every boot', async () => {
    const a = makeProc(); const b = makeProc()
    let n = 0
    const native = fakeNative([a, b])
    const helper = new GuestHelper('UDID-1', async () => [`UUID-${++n}`], native)
    await helper.start()
    die(a)
    await flush(); await flush()
    expect(native.spawn.mock.calls.map((c) => c[1].at(-1))).toEqual(['UUID-1', 'UUID-2'])
  })

  it('goes out of service when the panels cannot be read, and tries again', async () => {
    vi.useFakeTimers()
    const onUnavailable = vi.fn()
    const native = fakeNative([makeProc()])
    let fail = true
    const helper = new GuestHelper('UDID-1', async () => { if (fail) throw new Error('simctl io failed'); return ['COVER'] }, native, { onUnavailable })
    await helper.start()
    expect(native.spawn).not.toHaveBeenCalled()
    expect(helper.inputState()).toBe('starting')
    expect(onUnavailable).toHaveBeenCalledWith(expect.stringContaining('simctl io failed'))
    fail = false
    await vi.advanceTimersByTimeAsync(100)
    expect(native.spawn).toHaveBeenCalledTimes(1)
  })

  it('is starting until the helper says ready, then ready', async () => {
    const proc = makeProc()
    const { helper } = await started([proc])
    expect(helper.inputState()).toBe('starting')
    say(proc, 'pid 9001')
    expect(helper.inputState()).toBe('starting')
    say(proc, 'ready')
    expect(helper.inputState()).toBe('ready')
  })

  it('joins a ready line split across two chunks', async () => {
    const proc = makeProc()
    const { helper } = await started([proc])
    proc.stdout.emit('data', Buffer.from('pid 9001\nrea'))
    expect(helper.inputState()).toBe('starting')
    proc.stdout.emit('data', Buffer.from('dy\n'))
    expect(helper.inputState()).toBe('ready')
  })

  it('treats a spawn that never execed as unavailable', async () => {
    const proc = makeProc()
    proc.pid = undefined
    const { helper } = await started([proc])
    expect(helper.inputState()).toBe('unavailable')
  })

  it('reports whenReady() as true once ready and false on fatal', async () => {
    const a = makeProc()
    const first = await started([a])
    const ready = first.helper.whenReady()
    say(a, 'pid 1', 'ready')
    await expect(ready).resolves.toBe(true)

    const b = makeProc()
    const second = await started([b])
    const fatal = second.helper.whenReady()
    say(b, 'fatal HIDVirtualEventService missing')
    await expect(fatal).resolves.toBe(false)
  })
})

describe('GuestHelper input', () => {
  async function readyHelper() {
    const proc = makeProc()
    const r = await started([proc])
    say(proc, 'pid 9001', 'ready')
    return { ...r, proc }
  }

  it('writes a touch line and reports it delivered without waiting for a reply', async () => {
    const { helper, proc } = await readyHelper()
    expect(helper.touch('COVER', 'd', 0.25, 0.5, false)).toBe(true)
    expect(helper.touch('COVER', 'u', 0.25, 0.5, true)).toBe(true)
    expect(written(proc)).toEqual(['touch COVER d 0.25 0.5 0\n', 'touch COVER u 0.25 0.5 1\n'])
  })

  it('refuses input before ready, so a frame is not written into the start-up window', async () => {
    const proc = makeProc()
    const { helper } = await started([proc])
    expect(helper.touch('COVER', 'd', 0.5, 0.5, false)).toBe(false)
    expect(proc.stdin.write).not.toHaveBeenCalled()
  })

  it('does not let a down refused in the start-up window own the gesture once ready', async () => {
    // The case that makes "only a delivered down owns" load-bearing: the process is alive throughout, so
    // identity alone would pass and the up would reach a helper that never saw the down.
    const proc = makeProc()
    const { helper } = await started([proc])
    expect(helper.touch('COVER', 'd', 0.5, 0.5, false)).toBe(false)
    say(proc, 'pid 1', 'ready')
    expect(helper.ownsGesture()).toBe(false)
    expect(helper.touch('COVER', 'u', 0.5, 0.5, false)).toBe(false)
    expect(proc.stdin.write).not.toHaveBeenCalled()
  })

  it('resolves done-commands in order and does not let a touch error consume one', async () => {
    const { helper, proc } = await readyHelper()
    const hinge = helper.hinge(0, 130, 800)
    const orient = helper.orient('pud')
    say(proc, 'err 1 touch', 'done 0 hinge', 'done 1 orient')
    await expect(hinge).resolves.toBe(true)
    await expect(orient).resolves.toBe(false)
    expect(written(proc)).toEqual(['hinge 0 130 800\n', 'orient pud\n'])
  })

  it('writes a key with its modifiers and resolves on done', async () => {
    const { helper, proc } = await readyHelper()
    const key = helper.key(7, 0x04, 100, [[7, 0xe1]])
    say(proc, 'done 0 key')
    await expect(key).resolves.toBe(true)
    expect(written(proc)).toEqual(['key 7 4 100 7 225\n'])
  })

  it('holds a key across keydown and keyup', async () => {
    const { helper, proc } = await readyHelper()
    const down = helper.keyDown(12, 0x30)
    const up = helper.keyUp(12, 0x30)
    say(proc, 'done 0 keydown', 'done 0 keyup')
    await expect(down).resolves.toBe(true)
    await expect(up).resolves.toBe(true)
    expect(written(proc)).toEqual(['keydown 12 48\n', 'keyup 12 48\n'])
  })

  it('fails a done-command that never answers, and replaces the wedged helper', async () => {
    vi.useFakeTimers()
    const a = makeProc(); const b = makeProc()
    const { helper, native } = await started([a, b])
    say(a, 'pid 9001', 'ready')
    const orient = helper.orient('portrait')
    await vi.advanceTimersByTimeAsync(11_000)
    await expect(orient).resolves.toBe(false)
    expect(native.killPid).toHaveBeenCalledWith(9001, 'SIGKILL')
    die(a)
    await vi.advanceTimersByTimeAsync(0)
    expect(native.spawn).toHaveBeenCalledTimes(2)
  })

  // A fold can sit unanswered while the device changes panel — past 10.8 s on a loaded Mac, the panel having
  // lit at 10.6 s. Mutation: hold a fold to the ordinary margin (the helper is replaced just after it folded).
  it('waits longer for a fold before it calls the helper wedged', async () => {
    vi.useFakeTimers()
    const a = makeProc(); const b = makeProc()
    const { helper, native } = await started([a, b])
    say(a, 'pid 9001', 'ready')
    const hinge = helper.hinge(0, 180, 800)
    await vi.advanceTimersByTimeAsync(20_000)
    expect(native.killPid).not.toHaveBeenCalled()
    say(a, 'done 0 hinge')
    await expect(hinge).resolves.toBe(true)
  })

  it('rejects pending commands when the helper dies', async () => {
    const { helper, proc } = await readyHelper()
    const hinge = helper.hinge(0, 130, 800)
    die(proc)
    await expect(hinge).resolves.toBe(false)
  })

  it('refuses the rest of a gesture after the helper that took its down is replaced', async () => {
    const a = makeProc(); const b = makeProc()
    const { helper } = await started([a, b])
    say(a, 'pid 1', 'ready')
    expect(helper.touch('COVER', 'd', 0.5, 0.5, false)).toBe(true)
    expect(helper.ownsGesture()).toBe(true)
    die(a)
    await flush()
    say(b, 'pid 2', 'ready')
    expect(helper.inputState()).toBe('ready')
    expect(helper.ownsGesture()).toBe(false)
    expect(helper.touch('COVER', 'u', 0.5, 0.5, false)).toBe(false)
    expect(b.stdin.write).not.toHaveBeenCalled()
  })
})

describe('GuestHelper death and fatal', () => {
  it('respawns after a death, sweeping orphans first, within a rolling budget', async () => {
    const procs = [makeProc(), makeProc(), makeProc(), makeProc(), makeProc()]
    const { helper, native } = await started(procs)
    for (let n = 0; n < 4; n++) { die(procs[n]); await flush() }
    // 1 start + 2 respawns: the budget is 3 spawns in the window.
    expect(native.spawn).toHaveBeenCalledTimes(3)
    expect(native.findOrphans.mock.calls.length).toBeGreaterThanOrEqual(3)
    // Out of budget is not out for good: input is told to wait.
    expect(helper.inputState()).toBe('starting')
  })

  // A first version made the budget final, and an 8 GB Mac swapping under a Duo lost input for the rest of
  // the boot after one slow minute. Mutations: never relaunch; relaunch at once (the budget then bounds nothing).
  it('waits out the window after the budget runs out, then comes back and says so', async () => {
    vi.useFakeTimers()
    const procs = [makeProc(), makeProc(), makeProc(), makeProc()]
    const onUnavailable = vi.fn(); const onAvailable = vi.fn()
    const native = fakeNative(procs)
    const helper = new GuestHelper('UDID-1', async () => ['COVER'], native, { onUnavailable, onAvailable })
    await helper.start()
    for (const p of procs.slice(0, 3)) { die(p); await vi.advanceTimersByTimeAsync(0) }
    expect(native.spawn).toHaveBeenCalledTimes(3)
    expect(onUnavailable).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(native.spawn).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(native.spawn).toHaveBeenCalledTimes(4)
    say(procs[3], 'pid 4', 'ready')
    expect(helper.inputState()).toBe('ready')
    expect(onAvailable).toHaveBeenCalledTimes(1)
  })

  it('does not respawn after fatal, and says why', async () => {
    const proc = makeProc()
    const onUnavailable = vi.fn()
    const native = fakeNative([proc, makeProc()])
    const helper = new GuestHelper('UDID-1', async () => ['COVER'], native, { onUnavailable })
    await helper.start()
    say(proc, 'fatal HIDVirtualEventService missing')
    die(proc, 3)
    await flush()
    expect(native.spawn).toHaveBeenCalledTimes(1)
    expect(helper.inputState()).toBe('unavailable')
    expect(onUnavailable).toHaveBeenCalledWith('HIDVirtualEventService missing')
  })

  it('stays out for good after fatal even past the window', async () => {
    vi.useFakeTimers()
    const proc = makeProc()
    const native = fakeNative([proc, makeProc()])
    const helper = new GuestHelper('UDID-1', async () => ['COVER'], native)
    await helper.start()
    say(proc, 'fatal HIDVirtualEventService missing')
    die(proc, 3)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(native.spawn).toHaveBeenCalledTimes(1)
    expect(helper.inputState()).toBe('unavailable')
  })

  it('tells the owner when the respawn budget runs out', async () => {
    const procs = [makeProc(), makeProc(), makeProc()]
    const onUnavailable = vi.fn()
    const native = fakeNative(procs)
    const helper = new GuestHelper('UDID-1', async () => ['COVER'], native, { onUnavailable })
    await helper.start()
    for (const p of procs) { die(p); await flush() }
    expect(onUnavailable).toHaveBeenCalledTimes(1)
  })

  it('replaces a helper that never says ready', async () => {
    vi.useFakeTimers()
    const a = makeProc(); const b = makeProc()
    const { native } = await started([a, b])
    await vi.advanceTimersByTimeAsync(16_000)
    expect(a.kill).toHaveBeenCalled()
    die(a)
    await vi.advanceTimersByTimeAsync(0)
    expect(native.spawn).toHaveBeenCalledTimes(2)
  })
})

describe('GuestHelper stop', () => {
  it('closes stdin, kills the simctl process group and the guest pid, and does not respawn', async () => {
    const proc = makeProc()
    const { helper, native } = await started([proc])
    say(proc, 'pid 9001', 'ready')
    helper.stop()
    expect(proc.stdin.end).toHaveBeenCalled()
    expect(native.killPid).toHaveBeenCalledWith(-proc.pid!, 'SIGTERM')
    expect(native.killPid).toHaveBeenCalledWith(9001, 'SIGTERM')
    die(proc)
    await flush()
    expect(native.spawn).toHaveBeenCalledTimes(1)
    expect(helper.inputState()).toBe('unavailable')
  })

  it('stop() during the orphan sweep leaves nothing spawned', async () => {
    const proc = makeProc()
    let releaseSweep: (pids: number[]) => void = () => {}
    const native = fakeNative([proc])
    native.findOrphans.mockImplementation(() => new Promise((r) => { releaseSweep = r }))
    const helper = new GuestHelper('UDID-1', async () => ['COVER'], native)
    const starting = helper.start()
    helper.stop()
    releaseSweep([])
    await starting
    expect(native.spawn).not.toHaveBeenCalled()
  })
})
