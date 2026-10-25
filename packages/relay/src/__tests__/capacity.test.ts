import { describe, it, expect, vi } from 'vitest'
import { RelayServer } from '../RelayServer.js'
import { planCapacity, defaultCap, idleToFree, type CapacityDevice } from '../admission/capacity.js'

const dev = (sessionId: string, over: Partial<CapacityDevice> = {}): CapacityDevice => ({
  sessionId, platform: 'ios', automated: true, booted: true, inUse: false, reachable: true, bootedAt: 0, ...over,
})
const ios = { sessionId: 'new', platform: 'ios' }

describe('defaultCap', () => {
  it('is half the memory in GB, between 1 and 8', () => {
    expect(defaultCap(8192)).toBe(4)
    expect(defaultCap(16384)).toBe(8)
    expect(defaultCap(32768)).toBe(8)
    expect(defaultCap(1024)).toBe(1)
  })
})

describe('planCapacity', () => {
  it('lets a boot through under the cap, shutting nothing down', () => {
    expect(planCapacity([dev('a'), dev('b')], ios, 4)).toEqual({ ok: true, evict: [] })
  })

  it('shuts down the oldest idle automation device to make room', () => {
    const devices = [dev('a', { bootedAt: 30 }), dev('b', { bootedAt: 10 }), dev('c', { bootedAt: 20 }), dev('d', { bootedAt: 40 })]
    expect(planCapacity(devices, ios, 4)).toEqual({ ok: true, evict: ['b'] })
  })

  it('never shuts down a device in use, booting, unreachable, or started by a person', () => {
    const devices = [
      dev('held', { inUse: true, bootedAt: 1 }),
      dev('booting', { booted: false, bootedAt: 2 }),
      dev('gone', { reachable: false, bootedAt: 3 }),
      dev('person', { automated: false, bootedAt: 4 }),
      dev('idle', { bootedAt: 5 }),
    ]
    expect(planCapacity(devices, ios, 4)).toEqual({ ok: true, evict: ['idle'] })
  })

  it('refuses when nothing idle can make room', () => {
    expect(planCapacity([dev('a', { inUse: true }), dev('b', { booted: false })], ios, 2)).toEqual({ ok: false })
  })

  it('counts an emulator as two, both as what is up and as what is asked for', () => {
    expect(planCapacity([dev('e', { platform: 'android' })], ios, 3)).toEqual({ ok: true, evict: [] })
    expect(planCapacity([dev('e', { platform: 'android' })], { sessionId: 'n', platform: 'android' }, 3)).toEqual({ ok: true, evict: ['e'] })
    // An emulator needs two simulators gone, oldest first.
    expect(planCapacity([dev('a', { bootedAt: 1 }), dev('b', { bootedAt: 2 }), dev('c', { bootedAt: 3 })], { sessionId: 'n', platform: 'android' }, 3))
      .toEqual({ ok: true, evict: ['a', 'b'] })
  })

  it('does not count the requester twice when it re-boots a device automation already runs', () => {
    expect(planCapacity([dev('a'), dev('b'), dev('c'), dev('new')], ios, 4)).toEqual({ ok: true, evict: [] })
  })
})

describe('idleToFree', () => {
  it('names the oldest idle automation device, never the requester, one in use, or a person\'s', () => {
    const devices = [
      dev('held', { inUse: true, bootedAt: 1 }),
      dev('person', { automated: false, bootedAt: 2 }),
      dev('me', { bootedAt: 3 }),
      dev('newer', { bootedAt: 9 }),
      dev('older', { bootedAt: 5 }),
    ]
    expect(idleToFree(devices, 'me')).toBe('older')
    expect(idleToFree([dev('held', { inUse: true })], 'me')).toBeNull()
  })
})

// A cap someone set and mistyped must not quietly turn into the automatic one, which may allow more.
describe('TAPFLOW_MAX_AUTOMATED_DEVICES', () => {
  const capFor = (value: string | undefined) => {
    const before = process.env['TAPFLOW_MAX_AUTOMATED_DEVICES']
    if (value === undefined) delete process.env['TAPFLOW_MAX_AUTOMATED_DEVICES']
    else process.env['TAPFLOW_MAX_AUTOMATED_DEVICES'] = value
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const cap = (new RelayServer({ port: 0 }) as unknown as { automatedCapOverride: number | null }).automatedCapOverride
      return { cap, warned: warn.mock.calls.map((c) => c.join(' ')).join('\n') }
    } finally {
      warn.mockRestore()
      if (before === undefined) delete process.env['TAPFLOW_MAX_AUTOMATED_DEVICES']
      else process.env['TAPFLOW_MAX_AUTOMATED_DEVICES'] = before
    }
  }

  it.each([
    ['unset', undefined, null],
    ['a blank value', '  ', null],
    ['a real value', '3', 3],
  ])('reads %s as %s, quietly', (_label, value, expected) => {
    const { cap, warned } = capFor(value as string | undefined)
    expect(cap).toBe(expected)
    expect(warned).not.toContain('TAPFLOW_MAX_AUTOMATED_DEVICES')
  })

  it.each([['zero', '0'], ['a negative', '-2'], ['a fraction', '2.5'], ['a non-number', 'four']])('warns about %s and uses the automatic cap', (_label, value) => {
    const { cap, warned } = capFor(value)
    expect(cap).toBeNull()
    expect(warned).toContain('TAPFLOW_MAX_AUTOMATED_DEVICES')
    expect(warned).toContain(value)
  })
})
