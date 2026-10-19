import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { execFile } from 'child_process'

// The runner is the one seam between the agent and `adb`, so it is driven against a fake `execFile`
// and needs no SDK or emulator. `promisify(execFile)` in `adb.ts` sees a plain `vi.fn()` with no
// `promisify.custom`, so it appends the node callback and resolves with that callback's second
// argument — which is why the fake answers `{ stdout }`, the shape the helpers destructure.
vi.mock('child_process', () => ({ execFile: vi.fn() }))

// The emulator path is resolved on disk before `execFile` runs; pinning it keeps the warn-once test on
// the execFile failure it names, rather than on whichever failure this host happens to produce.
vi.mock('../sdk', () => ({ getAdbPath: () => process.env['ADB_PATH'], getEmulatorPath: () => '/fake/emulator' }))

import { defaultRunner } from '../adb'

type ExecFileCallback = (error: Error | null, result: { stdout: string | Buffer }) => void

// Options are always passed by the runner, so the callback is the fourth argument here, not the
// third as in tests whose production call omits them.
function answer(stdout: string | Buffer) {
  return (_file: unknown, _args: unknown, _options: unknown, cb: ExecFileCallback) => {
    cb(null, { stdout })
    return {} as ReturnType<typeof execFile>
  }
}

function lastCall(): unknown[] {
  const calls = vi.mocked(execFile).mock.calls as unknown as unknown[][]
  return calls.at(-1) ?? []
}

describe('defaultRunner', () => {
  beforeEach(() => {
    vi.stubEnv('ADB_PATH', '/fake/adb')
    vi.mocked(execFile).mockReset()
  })

  afterEach(() => vi.unstubAllEnvs())

  // #842: `screencap -p` of a photo-heavy 1080×2424 screen is over 1 MiB, and `execFile` without
  // `maxBuffer` rejects with "stdout maxBuffer length exceeded" at exactly that size. The literal is
  // asserted rather than a constant imported from the module, so that dropping the option — or
  // lowering it back toward Node's default — fails here instead of on the next photo-heavy screen.
  it('execBinary gives adb 64 MiB of stdout and keeps the buffer encoding', async () => {
    vi.mocked(execFile).mockImplementation(answer(Buffer.from('png')) as never)

    const out = await defaultRunner.execBinary('-s', 'emulator-5554', 'exec-out', 'screencap', '-p')

    expect(out).toEqual(Buffer.from('png'))
    expect(lastCall()[0]).toBe('/fake/adb')
    expect(lastCall()[1]).toEqual(['-s', 'emulator-5554', 'exec-out', 'screencap', '-p'])
    expect(lastCall()[2]).toEqual({ encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 })
  })

  it('exec gives adb the same room, for the uiautomator dump behind the accessibility tree', async () => {
    vi.mocked(execFile).mockImplementation(answer('<hierarchy/>') as never)

    const out = await defaultRunner.exec('-s', 'emulator-5554', 'exec-out', 'uiautomator', 'dump', '/dev/tty')

    expect(out).toBe('<hierarchy/>')
    expect(lastCall()[1]).toEqual(['-s', 'emulator-5554', 'exec-out', 'uiautomator', 'dump', '/dev/tty'])
    expect(lastCall()[2]).toEqual({ maxBuffer: 64 * 1024 * 1024 })
  })

  // `warnedListAvds` is module state that outlives a test, so each warning test first lists
  // successfully, which re-arms it, instead of relying on running first.
  type ListCallback = (e: Error | null, r?: { stdout: string }) => void
  const failList = ((_f: unknown, _a: unknown, cb: ListCallback) => {
    cb(new Error('spawn /fake/emulator EACCES'))
    return {} as ReturnType<typeof execFile>
  }) as never
  const okList = ((_f: unknown, _a: unknown, cb: ListCallback) => {
    cb(null, { stdout: 'Pixel\n' })
    return {} as ReturnType<typeof execFile>
  }) as never

  function warnings(warn: { mock: { calls: unknown[][] } }): string[] {
    return warn.mock.calls.map((c) => c.join(' ')).filter((l) => l.includes('cannot list AVDs'))
  }

  // #903: an SDK the agent cannot find used to look exactly like a machine with no AVDs. The list is
  // still empty — the agent stays up for adb-only work — but the reason is said, and said once, since
  // devices are listed on every poll.
  it('listAvds warns once when the emulator cannot be run, and still returns an empty list', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.mocked(execFile).mockImplementation(okList)
    await defaultRunner.listAvds()
    vi.mocked(execFile).mockImplementation(failList)

    expect(await defaultRunner.listAvds()).toEqual([])
    expect(await defaultRunner.listAvds()).toEqual([])

    expect(warnings(warn)).toHaveLength(1)
    expect(warnings(warn)[0]).toContain('spawn /fake/emulator EACCES')
    warn.mockRestore()
  })

  // Once a listing succeeds the warning re-arms, so a failure that starts later is still reported.
  it('listAvds warns again after a success in between', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.mocked(execFile).mockImplementation(okList)
    await defaultRunner.listAvds()
    vi.mocked(execFile).mockImplementation(failList)
    await defaultRunner.listAvds()
    vi.mocked(execFile).mockImplementation(okList)
    expect(await defaultRunner.listAvds()).toEqual(['Pixel'])
    vi.mocked(execFile).mockImplementation(failList)
    await defaultRunner.listAvds()

    expect(warnings(warn)).toHaveLength(2)
    warn.mockRestore()
  })
})
