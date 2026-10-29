import { describe, it, expect, vi, afterEach } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { PanelState, parseDisplays, type PanelStateNative, type PanelReading } from '../PanelState.js'

// Captured from `xcrun devicectl device info displays --json-output` on Xcode 27.1 (devicectl 651.13.5),
// iPhone Duo, each after its fold had settled.
const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(join(import.meta.dirname, '..', '__fixtures__', `devicectl-displays-duo-${name}.json`), 'utf8'))
const FOLDED = fixture('folded')
const OPEN = fixture('open')

describe('parseDisplays', () => {
  it('reads the folded Duo: the cover is lit', () => {
    expect(parseDisplays(FOLDED)).toEqual({
      lit: { displayId: 1, rotation: 0 },
      panels: [{ displayId: 1, active: true, rotation: 0 }, { displayId: 3, active: false, rotation: 90 }],
    })
  })

  it('reads the unfolded Duo: the inner panel is lit, in its own rotation', () => {
    expect(parseDisplays(OPEN)?.lit).toEqual({ displayId: 3, rotation: 90 })
  })

  it('ignores displays that are not integrated panels', () => {
    const doc = structuredClone(OPEN) as { result: { displays: Array<Record<string, unknown>> } }
    doc.result.displays.unshift({ name: 'TVOut', displayId: 2, active: true, currentOrientation: 'rot0', type: { tvOut: {} } })
    expect(parseDisplays(doc)?.lit?.displayId).toBe(3)
  })

  it('reads no lit panel mid-transition rather than guessing', () => {
    const doc = structuredClone(OPEN) as { result: { displays: Array<{ active: boolean }> } }
    for (const d of doc.result.displays) d.active = false
    expect(parseDisplays(doc)?.lit).toBeNull()
  })

  it('returns null for a document it does not recognise', () => {
    expect(parseDisplays({ info: { outcome: 'failed' } })).toBeNull()
    expect(parseDisplays(null)).toBeNull()
  })

  it('keeps which panel is lit when a rotation is one it does not know', () => {
    const doc = structuredClone(OPEN) as { result: { displays: Array<{ currentOrientation: string }> } }
    doc.result.displays[1].currentOrientation = 'sideways'
    expect(parseDisplays(doc)?.lit).toEqual({ displayId: 3, rotation: null })
  })
})

function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

function scriptedNative() {
  const calls: Array<ReturnType<typeof deferred<unknown>>> = []
  const native = {
    readDisplays: vi.fn<PanelStateNative['readDisplays']>(() => {
      const d = deferred<unknown>()
      calls.push(d)
      return d.promise
    }),
  }
  return { native, calls }
}
const flush = () => new Promise((r) => setImmediate(r))

afterEach(() => vi.useRealTimers())

describe('PanelState.read — coalesce to the next call, never join', () => {
  it('a read that arrives during a call gets a call that starts after it', async () => {
    // The fold case from the design review: a poll started before the hinge crossed is still in flight
    // when the fold completes. Joining it would read the old panel and report the fold as failed.
    const { native, calls } = scriptedNative()
    const state = new PanelState(native)
    const poll = state.read('U')
    const afterFold = state.read('U')
    expect(native.readDisplays).toHaveBeenCalledTimes(1)
    calls[0].resolve(FOLDED)
    await expect(poll).resolves.toMatchObject({ lit: { displayId: 1 } })
    await flush()
    expect(native.readDisplays).toHaveBeenCalledTimes(2)
    calls[1].resolve(OPEN)
    await expect(afterFold).resolves.toMatchObject({ lit: { displayId: 3 } })
  })

  it('many reads during one call share exactly one follow-up call', async () => {
    const { native, calls } = scriptedNative()
    const state = new PanelState(native)
    const first = state.read('U')
    const later = [state.read('U'), state.read('U'), state.read('U')]
    calls[0].resolve(FOLDED)
    await first
    await flush()
    calls[1].resolve(OPEN)
    const results = await Promise.all(later)
    expect(native.readDisplays).toHaveBeenCalledTimes(2)
    for (const r of results) expect(r?.lit?.displayId).toBe(3)
  })

  it('keeps devices apart', async () => {
    const { native, calls } = scriptedNative()
    const state = new PanelState(native)
    const a = state.read('A')
    const b = state.read('B')
    expect(native.readDisplays).toHaveBeenCalledTimes(2)
    calls[0].resolve(FOLDED)
    calls[1].resolve(OPEN)
    expect((await a)?.lit?.displayId).toBe(1)
    expect((await b)?.lit?.displayId).toBe(3)
  })
})

describe('PanelState.last', () => {
  it('remembers the last lit panel, and a failed read keeps it', async () => {
    const { native, calls } = scriptedNative()
    const state = new PanelState(native)
    expect(state.last('U')).toBeNull()
    const ok = state.read('U')
    calls[0].resolve(OPEN)
    await ok
    expect(state.last('U')?.lit).toEqual({ displayId: 3, rotation: 90 })
    const failed = state.read('U')
    calls[1].reject(new Error('devicectl timed out'))
    await expect(failed).resolves.toBeNull()
    expect(state.last('U')?.lit?.displayId).toBe(3)
  })

  it('does not overwrite the last lit panel with a mid-transition reading', async () => {
    const { native, calls } = scriptedNative()
    const state = new PanelState(native)
    const ok = state.read('U')
    calls[0].resolve(FOLDED)
    await ok
    const dark = structuredClone(OPEN) as { result: { displays: Array<{ active: boolean }> } }
    for (const d of dark.result.displays) d.active = false
    const mid = state.read('U')
    calls[1].resolve(dark)
    expect((await mid)?.lit).toBeNull()
    expect(state.last('U')?.lit?.displayId).toBe(1)
  })

  it('forget() drops what it knew', async () => {
    const { native, calls } = scriptedNative()
    const state = new PanelState(native)
    const ok = state.read('U')
    calls[0].resolve(OPEN)
    await ok
    state.forget('U')
    expect(state.last('U')).toBeNull()
  })

  // A reading in flight when the device shut down describes the boot before; kept, the next boot started from
  // the panel lit before the shutdown. Mutation: drop the generation check.
  it('drops a reading that was in flight when it forgot the device', async () => {
    const { native, calls } = scriptedNative()
    const state = new PanelState(native)
    const stale = state.read('U')
    state.forget('U')
    calls[0].resolve(OPEN)
    await expect(stale).resolves.toBeNull()
    expect(state.last('U')).toBeNull()
    // A read asked for afterwards is a new one, and counts.
    const fresh = state.read('U')
    await flush()
    calls[1].resolve(FOLDED)
    expect((await fresh)?.lit?.displayId).toBe(1)
    expect(state.last('U')?.lit?.displayId).toBe(1)
  })
})

// A Duo coming up from an erase lit its unfolded panel for up to 3.2 s and went back to its cover (measured).
describe('PanelState.last — a panel nobody asked for counts once it holds', () => {
  const reads = (...docs: unknown[]) => {
    const native = { readDisplays: vi.fn<PanelStateNative['readDisplays']>() }
    for (const d of docs) native.readDisplays.mockResolvedValueOnce(d)
    return native
  }

  // Mutation: settle every lit reading.
  it('keeps the panel it had while another is lit for less than the hold', async () => {
    vi.useFakeTimers()
    const state = new PanelState(reads(FOLDED, OPEN, OPEN, FOLDED), 4_000)
    await state.read('U')
    await state.read('U')
    expect(state.changing('U')).toBe(true)
    await vi.advanceTimersByTimeAsync(3_000)
    await state.read('U')
    expect(state.last('U')?.lit?.displayId).toBe(1)
    await state.read('U')
    expect(state.changing('U')).toBe(false)
    expect(state.last('U')?.lit?.displayId).toBe(1)
  })

  // Mutation: never settle a change (a fold made in DeviceHub would never be followed).
  it('takes the new panel once it has held', async () => {
    vi.useFakeTimers()
    const state = new PanelState(reads(FOLDED, OPEN, OPEN), 4_000)
    await state.read('U')
    await state.read('U')
    await vi.advanceTimersByTimeAsync(4_000)
    await state.read('U')
    expect(state.last('U')?.lit?.displayId).toBe(3)
    expect(state.changing('U')).toBe(false)
  })

  // Mutation: hold the very first reading too (a fresh boot would show the largest, dark panel meanwhile).
  it('takes the first reading at once', async () => {
    const state = new PanelState(reads(OPEN), 4_000)
    await state.read('U')
    expect(state.last('U')?.lit?.displayId).toBe(3)
  })

  // Mutation: leave a fold this agent made and waited for to the hold.
  it('takes a panel it was waiting for at once', async () => {
    vi.useFakeTimers()
    const native = reads(FOLDED)
    native.readDisplays.mockResolvedValue(OPEN)
    const state = new PanelState(native, 4_000)
    await state.read('U')
    const result = state.awaitLit('U', (r: PanelReading) => r.lit?.displayId === 3, 10_000)
    await vi.advanceTimersByTimeAsync(0)
    await result
    expect(state.last('U')?.lit?.displayId).toBe(3)
  })
})

describe('PanelState.awaitLit', () => {
  it('reads until the condition holds', async () => {
    vi.useFakeTimers()
    const native = { readDisplays: vi.fn<PanelStateNative['readDisplays']>() }
    native.readDisplays.mockResolvedValueOnce(FOLDED).mockResolvedValueOnce(FOLDED).mockResolvedValue(OPEN)
    const state = new PanelState(native)
    const result = state.awaitLit('U', (r: PanelReading) => r.lit?.displayId === 3, 10_000)
    await vi.advanceTimersByTimeAsync(2_000)
    await expect(result).resolves.toMatchObject({ lit: { displayId: 3 } })
    expect(native.readDisplays).toHaveBeenCalledTimes(3)
  })

  it('gives up at the deadline and answers null', async () => {
    vi.useFakeTimers()
    const native = { readDisplays: vi.fn<PanelStateNative['readDisplays']>().mockResolvedValue(FOLDED) }
    const state = new PanelState(native)
    const result = state.awaitLit('U', (r: PanelReading) => r.lit?.displayId === 3, 10_000)
    await vi.advanceTimersByTimeAsync(11_000)
    await expect(result).resolves.toBeNull()
    const calls = native.readDisplays.mock.calls.length
    await vi.advanceTimersByTimeAsync(5_000)
    expect(native.readDisplays.mock.calls.length).toBe(calls)
  })
})
