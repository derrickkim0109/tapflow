import { describe, it, expect, vi, afterEach } from 'vitest'
import { createLogger, formatClock } from '../logger'
import { createLoopStallWatch, describeRelayLoss } from '../utils/diagnostics'

afterEach(() => { vi.restoreAllMocks() })

describe('logger timestamps', () => {
  // An agent drop could not be put in order against the boot and install that preceded it, because no
  // line carried a time. The stamp goes before the prefix so `[relay] msg` stays a substring for anything
  // matching on it.
  it('prefixes each line with a local HH:MM:SS.mmm stamp before [prefix]', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    createLogger('relay').info('agent connected')
    const line = String(log.mock.calls[0][0])
    expect(line).toMatch(/^\d{2}:\d{2}:\d{2}\.\d{3} \[relay\] agent connected$/)
  })

  it('still passes meta through as its own argument', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const meta = { code: 1006 }
    createLogger('ios').warn('x', meta)
    expect(warn.mock.calls[0][1]).toBe(meta)
  })

  it('formats a clock time with zero-padded fields', () => {
    expect(formatClock(new Date(2026, 9, 8, 7, 5, 3, 9))).toBe('07:05:03.009')
  })
})

describe('describeRelayLoss', () => {
  const now = 1_000_000

  // Most closes arrive as 1006 whoever caused them, so the code alone cannot tell a relay that terminated
  // a silent agent from a network that went away. The time since the relay's last ping is the part that
  // separates them: recent means the link was up and the agent stopped answering.
  it('names the close code, the socket error and how long ago the relay last pinged', () => {
    expect(describeRelayLoss({ code: 1006, reason: '', errorCode: 'ETIMEDOUT', lastPingAt: now - 41_000, now }))
      .toBe('code 1006, error ETIMEDOUT, last ping 41s ago')
  })

  it('includes a close reason when the relay sent one', () => {
    expect(describeRelayLoss({ code: 1008, reason: 'Unauthorized', lastPingAt: now - 2_000, now }))
      .toBe('code 1008 Unauthorized, last ping 2s ago')
  })

  it('says when no ping ever arrived on this connection', () => {
    expect(describeRelayLoss({ code: 1006, lastPingAt: null, now })).toBe('code 1006, no ping received')
  })

  // `_scheduleReconnect` also runs after a failed reconnect, where there is no close event to describe.
  it('says plainly when there are no close details at all', () => {
    expect(describeRelayLoss({ now })).toBe('no close details')
  })
})

describe('createLoopStallWatch', () => {
  function harness(thresholdMs = 2000) {
    let mono = 0
    let wall = Date.UTC(2026, 9, 8, 3, 0, 0)
    let cpuUs = 0
    let faults = 0
    let tick: (() => void) | null = null
    const onStall = vi.fn()
    const timer = { unref: vi.fn() }
    const watch = createLoopStallWatch({
      intervalMs: 1000,
      thresholdMs,
      onStall,
      now: () => mono,
      wallNow: () => wall,
      cpuMicros: () => cpuUs,
      majorFaults: () => faults,
      setInterval: (fn: () => void) => { tick = fn; return timer as unknown as ReturnType<typeof setInterval> },
      clearInterval: () => { tick = null },
    })
    const advance = (ms: number, extra: { cpuMs?: number; faults?: number } = {}) => {
      mono += ms; wall += ms; cpuUs += (extra.cpuMs ?? 0) * 1000; faults += extra.faults ?? 0
      tick?.()
    }
    return { watch, onStall, advance, timer, running: () => tick !== null }
  }

  it('stays quiet while ticks arrive on time', () => {
    const h = harness()
    h.watch.start()
    for (let i = 0; i < 10; i++) h.advance(1000)
    expect(h.onStall).not.toHaveBeenCalled()
  })

  it('reports one stall with how long, since when, CPU used and page faults', () => {
    const h = harness()
    h.watch.start()
    h.advance(1000)
    h.advance(4200, { cpuMs: 150, faults: 37 })
    expect(h.onStall).toHaveBeenCalledTimes(1)
    const r = h.onStall.mock.calls[0][0]
    // A 1s tick only bounds the stall: it began after the last tick and before the next one was due, and
    // lasted at least the lateness.
    expect(r.blockedMs).toBe(3200)
    expect(r.cpuMs).toBe(150)
    expect(r.majorFaults).toBe(37)
    expect(r.startedAfter.getTime()).toBe(Date.UTC(2026, 9, 8, 3, 0, 1))
    expect(r.startedBy.getTime()).toBe(Date.UTC(2026, 9, 8, 3, 0, 2))
  })

  it('does not report a lateness under the threshold', () => {
    const h = harness()
    h.watch.start()
    h.advance(2900)
    expect(h.onStall).not.toHaveBeenCalled()
  })

  it('unrefs its timer so it never keeps a process alive, and stop clears it', () => {
    const h = harness()
    h.watch.start()
    expect(h.timer.unref).toHaveBeenCalled()
    h.watch.stop()
    expect(h.running()).toBe(false)
  })

  it('start is idempotent', () => {
    const h = harness()
    h.watch.start()
    h.watch.start()
    h.advance(5000)
    expect(h.onStall).toHaveBeenCalledTimes(1)
  })
})
