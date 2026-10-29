import { describe, it, expect, vi, afterEach } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { PhysicalOrientation, parseOrientation, turned, ORIENTATION_DEGREES, type PhysicalOrientationNative } from '../PhysicalOrientation.js'

// Captured from `xcrun devicectl device orientation get -j -` on Xcode 27.1 (devicectl 651.13.5), iPhone Duo held
// landscapeRight, with the arguments and environment trimmed.
const FIXTURE = JSON.parse(readFileSync(join(import.meta.dirname, '..', '__fixtures__', 'devicectl-orientation-duo.json'), 'utf8'))
const doc = (deviceOrientation: string, deviceOrientationNonFlat = deviceOrientation) =>
  ({ ...FIXTURE, result: { ...FIXTURE.result, deviceOrientation, deviceOrientationNonFlat } })

describe('parseOrientation', () => {
  it('reads the captured document', () => {
    expect(parseOrientation(FIXTURE)).toBe('landscapeRight')
  })

  it('reads a device lying flat as the way it last stood', () => {
    expect(parseOrientation(doc('faceUp', 'landscapeLeft'))).toBe('landscapeLeft')
  })

  // Measured: a fresh device reports `unknown` until anything turns it, and it is drawn upright.
  it('reads a device nothing has turned yet as portrait', () => {
    expect(parseOrientation(doc('unknown'))).toBe('portrait')
  })

  it('returns null for a document it does not recognise', () => {
    expect(parseOrientation({ info: { outcome: 'failed' } })).toBeNull()
    expect(parseOrientation(doc('sideways', 'sideways'))).toBeNull()
    expect(parseOrientation(null)).toBeNull()
  })
})

describe('turned', () => {
  it('goes round clockwise in DeviceHub\'s order, and back the other way', () => {
    expect(turned('portrait', 'clockwise')).toBe('landscapeRight')
    expect(turned('landscapeLeft', 'clockwise')).toBe('portrait')
    expect(turned('portrait', 'counterclockwise')).toBe('landscapeLeft')
    // Each clockwise step is a quarter turn more.
    for (const o of ['portrait', 'landscapeRight', 'portraitUpsideDown', 'landscapeLeft'] as const) {
      expect((ORIENTATION_DEGREES[turned(o, 'clockwise')] - ORIENTATION_DEGREES[o] + 360) % 360).toBe(90)
    }
  })
})

function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((res) => { resolve = res })
  return { promise, resolve }
}

describe('PhysicalOrientation', () => {
  afterEach(() => vi.useRealTimers())

  // Mutation: join the call in flight. A read asked for after a turn would get the orientation from before it.
  it('gives a read that arrives during a call the next call, never the current one', async () => {
    const calls: Array<ReturnType<typeof deferred<unknown>>> = []
    const native = { readOrientation: vi.fn<PhysicalOrientationNative['readOrientation']>(() => { const d = deferred<unknown>(); calls.push(d); return d.promise }) }
    const state = new PhysicalOrientation(native)
    const before = state.read('U')
    const after = state.read('U')
    calls[0].resolve(doc('portrait'))
    await expect(before).resolves.toBe('portrait')
    await new Promise((r) => setImmediate(r))
    calls[1].resolve(doc('landscapeRight'))
    await expect(after).resolves.toBe('landscapeRight')
    expect(native.readOrientation).toHaveBeenCalledTimes(2)
  })

  it('keeps the last orientation when a read fails', async () => {
    const native = { readOrientation: vi.fn<PhysicalOrientationNative['readOrientation']>() }
    native.readOrientation.mockResolvedValueOnce(doc('landscapeLeft')).mockRejectedValueOnce(new Error('timed out'))
    const state = new PhysicalOrientation(native)
    await state.read('U')
    await expect(state.read('U')).resolves.toBeNull()
    expect(state.last('U')).toBe('landscapeLeft')
    // And so does a document it cannot read.
    native.readOrientation.mockResolvedValueOnce({ info: { outcome: 'failed' } })
    await expect(state.read('U')).resolves.toBeNull()
    expect(state.last('U')).toBe('landscapeLeft')
    state.forget('U')
    expect(state.last('U')).toBeNull()
  })

  // Mutation: drop the generation check — the orientation from before a shutdown came back after it.
  it('drops a reading that was in flight when it forgot the device', async () => {
    const calls: Array<ReturnType<typeof deferred<unknown>>> = []
    const native = { readOrientation: vi.fn<PhysicalOrientationNative['readOrientation']>(() => { const d = deferred<unknown>(); calls.push(d); return d.promise }) }
    const state = new PhysicalOrientation(native)
    const stale = state.read('U')
    state.forget('U')
    calls[0].resolve(doc('landscapeLeft'))
    await expect(stale).resolves.toBeNull()
    expect(state.last('U')).toBeNull()
  })

  it('waits until the orientation lands, and gives up at the deadline', async () => {
    vi.useFakeTimers()
    const native = { readOrientation: vi.fn<PhysicalOrientationNative['readOrientation']>() }
    native.readOrientation.mockResolvedValueOnce(doc('portrait')).mockResolvedValue(doc('landscapeRight'))
    const state = new PhysicalOrientation(native)
    const landed = state.await('U', (o) => o === 'landscapeRight', 3_000)
    await vi.advanceTimersByTimeAsync(1_000)
    await expect(landed).resolves.toBe('landscapeRight')
    const never = state.await('U', (o) => o === 'portrait', 3_000)
    await vi.advanceTimersByTimeAsync(4_000)
    await expect(never).resolves.toBeNull()
  })
})
