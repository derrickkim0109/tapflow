import { describe, it, expect } from 'vitest'
import { chooseLease, type LeaseCandidate, type LeaseHost } from '../admission/leaseChoice.js'

const cand = (sessionId: string, hostKey: string, over: Partial<LeaseCandidate> = {}): LeaseCandidate =>
  ({ sessionId, hostKey, pool: false, bootedAt: 0, refusal: null, ...over })
const hosts = (entries: Record<string, Partial<LeaseHost>>): Map<string, LeaseHost> =>
  new Map(Object.entries(entries).map(([k, h]) => [k, { freeMB: null, cpuPercent: null, automated: 0, ...h }]))

describe('chooseLease', () => {
  it('takes a device already up over a boot, whatever room the boot Mac has', () => {
    const c = chooseLease([cand('boot', 'roomy'), cand('up', 'tight', { pool: true })], hosts({ roomy: { freeMB: 20_000 }, tight: { freeMB: 500 } }))
    expect(c).toEqual({ ok: true, sessionId: 'up' })
  })

  it('takes the oldest of two pool devices on equally roomy Macs', () => {
    const c = chooseLease([cand('new', 'a', { pool: true, bootedAt: 200 }), cand('old', 'a', { pool: true, bootedAt: 100 })], hosts({ a: { freeMB: 8_000 } }))
    expect(c).toEqual({ ok: true, sessionId: 'old' })
  })

  it('boots on the Mac with the most memory left, then the idler CPU, then fewer automation devices', () => {
    expect(chooseLease([cand('a1', 'a'), cand('b1', 'b')], hosts({ a: { freeMB: 4_000 }, b: { freeMB: 9_000 } })))
      .toEqual({ ok: true, sessionId: 'b1' })
    expect(chooseLease([cand('a1', 'a'), cand('b1', 'b')], hosts({ a: { freeMB: 4_000, cpuPercent: 70 }, b: { freeMB: 4_000, cpuPercent: 20 } })))
      .toEqual({ ok: true, sessionId: 'b1' })
    expect(chooseLease([cand('a1', 'a'), cand('b1', 'b')], hosts({ a: { freeMB: 4_000, cpuPercent: 20, automated: 3 }, b: { freeMB: 4_000, cpuPercent: 20, automated: 1 } })))
      .toEqual({ ok: true, sessionId: 'b1' })
  })

  it('puts a Mac that has not reported last', () => {
    expect(chooseLease([cand('silent', 'x'), cand('known', 'y')], hosts({ x: {}, y: { freeMB: 100 } })))
      .toEqual({ ok: true, sessionId: 'known' })
  })

  it('skips a refused device for one that would go', () => {
    const c = chooseLease([cand('a1', 'a', { refusal: 'host-booting' }), cand('b1', 'b')], hosts({ a: { freeMB: 30_000 }, b: { freeMB: 1_000 } }))
    expect(c).toEqual({ ok: true, sessionId: 'b1' })
  })

  it('reports the refusal likeliest to lift by waiting', () => {
    const all = [cand('a', 'a', { refusal: 'host-memory-critical' }), cand('b', 'b', { refusal: 'host-at-capacity' }), cand('c', 'c', { refusal: 'host-booting' })]
    expect(chooseLease(all, hosts({}))).toEqual({ ok: false, reason: 'host-booting' })
    expect(chooseLease(all.slice(0, 2), hosts({}))).toEqual({ ok: false, reason: 'host-at-capacity' })
  })

  it('names the critical Mac with the most memory, so the caller can free a device there', () => {
    const c = chooseLease(
      [cand('a', 'a', { refusal: 'host-memory-critical' }), cand('b', 'b', { refusal: 'host-memory-critical' })],
      hosts({ a: { freeMB: 300 }, b: { freeMB: 900 } }),
    )
    expect(c).toEqual({ ok: false, reason: 'host-memory-critical', criticalHost: 'b' })
  })
})
