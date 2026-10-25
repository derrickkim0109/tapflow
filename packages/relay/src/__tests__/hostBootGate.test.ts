import { describe, it, expect, beforeEach } from 'vitest'
import type { ServiceTier } from '@tapflowio/protocol'
import { HostBootGate, GATE_DEFAULTS, type BootRequest, type Effect } from '../admission/HostBootGate.js'
import { isSettled } from '../admission/settle.js'
import { classifyBoot } from '../admission/classifyBoot.js'
import { hostKeyOf } from '../admission/hostKey.js'

const HOST = 'mac-1'
let now = 0
let gate: HostBootGate<string>

function req(sessionId: string, booterClass: 'interactive' | 'automated', over: Partial<BootRequest<string>> = {}): BootRequest<string> {
  return { hostKey: HOST, sessionId, requestId: `${sessionId}-r`, cost: 'cold', booterClass, message: `boot ${sessionId}`, ...over }
}
const kinds = (fx: Effect<string>[]): string[] => fx.filter((e) => e.kind !== 'log').map((e) => `${e.kind}:${e.sessionId}`)
const delivered = (fx: Effect<string>[]): string[] => fx.flatMap((e) => (e.kind === 'deliver' ? [e.sessionId] : []))
const logged = (fx: Effect<string>[]): string[] => fx.flatMap((e) => (e.kind === 'log' ? [e.event] : []))

/** Ready, then reports until the slot settles: one dropped, then three flat ones 5 s apart. */
function settle(sessionId: string): Effect<string>[] {
  const fx = gate.onEvent({ kind: 'ready', hostKey: HOST, sessionId, cold: true })
  for (const cpu of [0, 40, 42, 41]) { now += 5_000; fx.push(...gate.onEvent({ kind: 'sample', hostKey: HOST, cpuPercent: cpu })) }
  return fx
}

beforeEach(() => {
  now = 1_000_000
  gate = new HostBootGate<string>(() => now)
})

describe('isSettled', () => {
  it('wants three flat samples under the ceiling', () => {
    expect(isSettled([40, 45])).toBe(false)
    expect(isSettled([40, 45, 50])).toBe(true)
    expect(isSettled([40, 45, 51])).toBe(false) // spread 11
    expect(isSettled([88, 89, 90])).toBe(false) // one at the ceiling
    expect(isSettled([95, 60, 61, 62])).toBe(true) // only the last three count
  })
})

describe('classifyBoot', () => {
  const slim: ServiceTier = { name: 'slim', keep: [] }
  const lean: ServiceTier = { name: 'lean', keep: [] }
  it('charges only a boot that brings a device up', () => {
    expect(classifyBoot('booted', {}, undefined)).toBe('warm')
    expect(classifyBoot('booted', { resetMode: 'app-only' }, undefined)).toBe('warm')
    expect(classifyBoot('booted', { resetMode: 'full-erase' }, undefined)).toBe('cold')
    expect(classifyBoot('shutdown', {}, undefined)).toBe('cold')
    expect(classifyBoot('unknown', { resetMode: 'app-only' }, undefined)).toBe('cold')
  })
  it('charges a running device asked onto another tier, and only when both sides are known', () => {
    expect(classifyBoot('booted', { serviceTier: slim }, lean)).toBe('cold')
    expect(classifyBoot('booted', { serviceTier: { name: 'slim', keep: ['push'] } }, slim)).toBe('cold')
    expect(classifyBoot('booted', { serviceTier: slim }, slim)).toBe('warm')
    expect(classifyBoot('booted', { serviceTier: { name: 'slim', keep: ['push', 'photos'] } }, { name: 'slim', keep: ['photos', 'push'] })).toBe('warm')
    expect(classifyBoot('booted', { serviceTier: slim }, 'unsupported')).toBe('warm')
    expect(classifyBoot('booted', { serviceTier: slim }, undefined)).toBe('warm')
    expect(classifyBoot('booted', {}, slim)).toBe('warm')
  })
})

describe('hostKeyOf', () => {
  it('keys by machine id, then name, and never by an empty string', () => {
    expect(hostKeyOf({ id: 's1', agentId: 'uuid-1', agentName: 'mac' })).toBe('uuid-1')
    expect(hostKeyOf({ id: 's1', agentName: 'mac' })).toBe('mac')
    // The register schema defaults a missing name to '' — two such agents must not share a slot.
    expect(hostKeyOf({ id: 's1', agentName: '' })).toBe('session:s1')
    expect(hostKeyOf({ id: 's2', agentId: '', agentName: '' })).toBe('session:s2')
  })
})

describe('HostBootGate', () => {
  it('lets one cold boot through per Mac and refuses the next automated one', () => {
    expect(kinds(gate.admit(req('a', 'automated')))).toEqual(['deliver:a'])
    const second = gate.admit(req('b', 'automated'))
    expect(second).toEqual([{ kind: 'refuse', sessionId: 'b', requestId: 'b-r', reason: 'host-booting', message: 'boot b' }])
    expect(gate.isBooting(HOST)).toBe(true)
  })

  it('does not charge a warm boot, and keeps Macs apart', () => {
    gate.admit(req('a', 'automated'))
    expect(kinds(gate.admit(req('b', 'automated', { cost: 'warm' })))).toEqual(['deliver:b'])
    expect(kinds(gate.admit(req('c', 'automated', { hostKey: 'mac-2' })))).toEqual(['deliver:c'])
  })

  it('holds a person behind a boot and lets them through when it settles', () => {
    gate.admit(req('a', 'automated'))
    const held = gate.admit(req('p', 'interactive'))
    expect(held).toEqual([{ kind: 'waiting', sessionId: 'p', requestId: 'p-r', until: now + GATE_DEFAULTS.humanWaitMs, reason: 'host-booting', message: 'boot p' }])
    expect(delivered(settle('a'))).toEqual(['p'])
    expect(gate.isBooting(HOST)).toBe(true) // the person's boot now holds it
  })

  it('puts the person ahead of an automated retry while they wait', () => {
    gate.admit(req('a', 'automated'))
    gate.admit(req('p', 'interactive'))
    expect(gate.admit(req('b', 'automated'))[0]).toMatchObject({ kind: 'refuse' })
  })

  it('sends a person after humanWaitMs whatever the slot says', () => {
    gate.admit(req('a', 'automated'))
    expect(delivered(gate.admit(req('p', 'interactive')))).toEqual([])
    expect(gate.nextDeadline()).toBe(now + GATE_DEFAULTS.humanWaitMs)
    now += GATE_DEFAULTS.humanWaitMs
    const fx = gate.tick()
    expect(delivered(fx)).toEqual(['p'])
    expect(logged(fx)).toContain('human-wait-expired')
  })

  it('lets a second person through at once rather than queue them', () => {
    gate.admit(req('a', 'automated'))
    gate.admit(req('p', 'interactive'))
    const fx = gate.admit(req('q', 'interactive'))
    expect(delivered(fx)).toEqual(['q'])
    expect(logged(fx)).toContain('overlap')
  })

  it('keeps a reconnecting person in their place and answers the request they replaced', () => {
    gate.admit(req('a', 'automated'))
    const t0 = now
    gate.admit(req('p', 'interactive'))
    now += 10_000
    const again = gate.admit(req('p', 'interactive', { requestId: 'p-r2', message: 'boot p again' }))
    expect(again).toEqual([
      { kind: 'withdraw', sessionId: 'p', requestId: 'p-r', why: 'replaced', message: 'boot p' },
      { kind: 'waiting', sessionId: 'p', requestId: 'p-r2', until: t0 + GATE_DEFAULTS.humanWaitMs, reason: 'host-booting', message: 'boot p again' },
    ])
    expect(gate.nextDeadline()).toBe(t0 + GATE_DEFAULTS.humanWaitMs) // the clock did not restart
    const fx = settle('a')
    expect(fx).toContainEqual({ kind: 'deliver', sessionId: 'p', requestId: 'p-r2', message: 'boot p again' })
    expect(delivered(fx)).toEqual(['p']) // once
  })

  it('drops a held boot whose person went away', () => {
    gate.admit(req('a', 'automated'))
    gate.admit(req('p', 'interactive'))
    expect(gate.onEvent({ kind: 'browser-closed', sessionId: 'p' }))
      .toEqual([{ kind: 'withdraw', sessionId: 'p', requestId: 'p-r', why: 'cancelled', message: 'boot p' }])
    expect(delivered(settle('a'))).toEqual([])
  })

  describe('release', () => {
    beforeEach(() => { gate.admit(req('a', 'automated')) })
    const free = (): boolean => !gate.isBooting(HOST)

    it('on settling', () => { settle('a'); expect(free()).toBe(true) })
    it('on shutdown-done', () => { gate.onEvent({ kind: 'shutdown-done', sessionId: 'a' }); expect(free()).toBe(true) })
    it('on session removal', () => { gate.onEvent({ kind: 'session-removed', sessionId: 'a' }); expect(free()).toBe(true) })
    it('on the current boot failing', () => { gate.onEvent({ kind: 'boot-error', sessionId: 'a', requestId: 'a-r' }); expect(free()).toBe(true) })
    it('on a dead stream with no correlator', () => { gate.onEvent({ kind: 'boot-error', sessionId: 'a' }); expect(free()).toBe(true) })
    it('when the agent says the device was already up', () => { gate.onEvent({ kind: 'ready', hostKey: HOST, sessionId: 'a', cold: false }); expect(free()).toBe(true) })

    it('not on a superseded boot failing', () => {
      gate.admit(req('a', 'automated', { requestId: 'a-r2' }))
      gate.onEvent({ kind: 'boot-error', sessionId: 'a', requestId: 'a-r' })
      expect(free()).toBe(false)
    })

    it('not when the person closes their tab', () => {
      gate.onEvent({ kind: 'browser-closed', sessionId: 'a' })
      expect(free()).toBe(false)
    })

    it('after bootMs stuck booting', () => {
      now += GATE_DEFAULTS.bootMs - 1
      gate.tick(); expect(free()).toBe(false)
      now += 1
      expect(logged(gate.tick())).toContain('boot-timeout'); expect(free()).toBe(true)
    })

    it('after settleCapMs of samples that never flatten', () => {
      gate.onEvent({ kind: 'ready', hostKey: HOST, sessionId: 'a', cold: true })
      const readyAt = now
      for (let i = 0; now < readyAt + GATE_DEFAULTS.settleCapMs - 5_000; i++) {
        now += 5_000
        gate.onEvent({ kind: 'sample', hostKey: HOST, cpuPercent: i % 2 ? 30 : 80 })
      }
      gate.tick(); expect(free()).toBe(false)
      now = readyAt + GATE_DEFAULTS.settleCapMs
      expect(logged(gate.tick())).toContain('settle-timeout'); expect(free()).toBe(true)
    })

    it('after noSampleMs with no report at all', () => {
      gate.onEvent({ kind: 'ready', hostKey: HOST, sessionId: 'a', cold: true })
      now += GATE_DEFAULTS.noSampleMs
      expect(logged(gate.tick())).toContain('no-samples'); expect(free()).toBe(true)
    })

    it('after a rebind nobody follows up', () => {
      gate.onEvent({ kind: 'rebound', sessionId: 'a' })
      now += GATE_DEFAULTS.reboundMs
      expect(logged(gate.tick())).toContain('rebound-abandoned'); expect(free()).toBe(true)
    })

    it('not after a rebind once the device is settling: the settle clocks own it then', () => {
      gate.onEvent({ kind: 'ready', hostKey: HOST, sessionId: 'a', cold: true })
      now += 1_000
      gate.onEvent({ kind: 'sample', hostKey: HOST, cpuPercent: 80 })
      gate.onEvent({ kind: 'rebound', sessionId: 'a' })
      now += GATE_DEFAULTS.reboundMs
      gate.tick(); expect(free()).toBe(false)
    })

    it('not after a rebind the session follows up, which inherits the slot', () => {
      gate.onEvent({ kind: 'rebound', sessionId: 'a' })
      now += 1_000
      expect(kinds(gate.admit(req('a', 'automated', { requestId: 'a-r2' })))).toEqual(['deliver:a'])
      now += GATE_DEFAULTS.reboundMs
      gate.tick(); expect(free()).toBe(false)
    })
  })

  it('skips a second agent reporting close behind the first, so three samples stay 15 s', () => {
    gate.admit(req('a', 'automated'))
    gate.onEvent({ kind: 'ready', hostKey: HOST, sessionId: 'a', cold: true })
    for (const cpu of [0, 40, 41, 42]) {
      now += 2_500
      gate.onEvent({ kind: 'sample', hostKey: HOST, cpuPercent: cpu })
    }
    expect(gate.isBooting(HOST)).toBe(true) // only two of those four were taken
  })

  it('claims the slot for a boot let through warm that the agent had to bring up', () => {
    gate.admit(req('a', 'interactive', { cost: 'warm' }))
    gate.onEvent({ kind: 'ready', hostKey: HOST, sessionId: 'a', cold: true })
    expect(gate.isBooting(HOST)).toBe(true)
    expect(gate.admit(req('b', 'automated'))[0]).toMatchObject({ kind: 'refuse' })
  })

  describe('aging', () => {
    /** A person takes the free slot, an automated client is refused behind them, and the person settles. */
    function personRound(id: string): Effect<string>[] {
      expect(kinds(gate.admit(req(id, 'interactive')))).toEqual([`deliver:${id}`])
      expect(gate.admit(req('auto', 'automated'))[0]).toMatchObject({ kind: 'refuse' })
      return settle(id)
    }

    it('keeps the slot for automation after agingCount people in a row while it waited', () => {
      gate.admit(req('first', 'interactive'))
      gate.admit(req('auto', 'automated')) // refused
      settle('first')
      let fx: Effect<string>[] = []
      for (let i = 0; i < GATE_DEFAULTS.agingCount; i++) fx = personRound(`p${i}`)
      expect(logged(fx)).toContain('aging-window')
      // a person now waits, and the next automated retry gets the slot
      expect(gate.admit(req('late', 'interactive'))[0]).toMatchObject({ kind: 'waiting', sessionId: 'late' })
      expect(kinds(gate.admit(req('auto', 'automated')))).toEqual(['deliver:auto'])
    })

    it('does not open the window when nobody automated was refused recently', () => {
      gate.admit(req('auto', 'automated'))
      settle('auto')
      now += GATE_DEFAULTS.recentRefusalMs + 1
      for (let i = 0; i < GATE_DEFAULTS.agingCount + 1; i++) {
        gate.admit(req(`p${i}`, 'interactive'))
        expect(logged(settle(`p${i}`))).not.toContain('aging-window')
      }
    })

    it('hands the slot back to the waiting person when the window passes unused', () => {
      gate.admit(req('first', 'interactive'))
      gate.admit(req('auto', 'automated'))
      settle('first')
      for (let i = 0; i < GATE_DEFAULTS.agingCount; i++) personRound(`p${i}`)
      gate.admit(req('late', 'interactive'))
      now += GATE_DEFAULTS.agingWindowMs
      expect(delivered(gate.tick())).toEqual(['late'])
    })
  })

  // The memory safety valve: critical kernel pressure on the Mac keeps new devices off it.
  describe('critical memory pressure', () => {
    const critical = (on = true): Effect<string>[] => gate.onEvent({ kind: 'pressure', hostKey: HOST, critical: on })
    const waits = (fx: Effect<string>[]): string[] => fx.flatMap((e) => (e.kind === 'waiting' ? [`${e.sessionId}:${e.reason}`] : []))

    it('refuses an automated cold boot even with the slot free, and lets warm boots through', () => {
      expect(logged(critical())).toEqual(['memory-critical'])
      expect(gate.admit(req('a', 'automated'))).toEqual([{ kind: 'refuse', sessionId: 'a', requestId: 'a-r', reason: 'host-memory-critical', message: 'boot a' }])
      expect(kinds(gate.admit(req('w', 'automated', { cost: 'warm' })))).toEqual(['deliver:w'])
      expect(gate.isBooting(HOST)).toBe(false)
    })

    it('names memory over a busy slot, since it is the longer wait', () => {
      gate.admit(req('a', 'automated'))
      critical()
      expect(gate.admit(req('b', 'automated'))[0]).toMatchObject({ kind: 'refuse', reason: 'host-memory-critical' })
    })

    it('does not refuse a re-boot of the device already holding the slot', () => {
      gate.admit(req('a', 'automated'))
      critical()
      expect(kinds(gate.admit(req('a', 'automated', { requestId: 'a-r2' })))).toEqual(['deliver:a'])
    })

    it('holds a person with the slot free, and lets them go when a report says pressure is over', () => {
      critical()
      expect(waits(gate.admit(req('p', 'interactive')))).toEqual(['p:host-memory-critical'])
      expect(critical().filter((e) => e.kind !== 'log')).toEqual([]) // still critical: nothing changes
      expect(delivered(critical(false))).toEqual(['p'])
      expect(gate.isBooting(HOST)).toBe(true)
    })

    it('lets the person go when the agents stop saying so, at the deadline it reports', () => {
      critical()
      gate.admit(req('p', 'interactive'))
      expect(gate.nextDeadline()).toBe(now + 15_000)
      now += 15_000
      const fx = gate.tick()
      expect(logged(fx)).toContain('memory-critical-stale')
      expect(delivered(fx)).toEqual(['p'])
    })

    it('keeps the person told why they wait as the reason changes', () => {
      gate.admit(req('a', 'automated'))
      expect(waits(gate.admit(req('p', 'interactive')))).toEqual(['p:host-booting'])
      expect(waits(critical())).toEqual(['p:host-memory-critical'])
      expect(waits(critical(false))).toEqual(['p:host-booting']) // the slot still holds them
      // The slot frees while memory is short again (each report renews it): the person is told so, not let go.
      const fx = [...critical(), ...gate.onEvent({ kind: 'ready', hostKey: HOST, sessionId: 'a', cold: true })]
      for (const cpu of [0, 40, 42, 41]) { now += 5_000; fx.push(...critical(), ...gate.onEvent({ kind: 'sample', hostKey: HOST, cpuPercent: cpu })) }
      expect(gate.isBooting(HOST)).toBe(false)
      expect(delivered(fx)).toEqual([])
      expect(waits(fx)).toEqual(['p:host-memory-critical'])
      expect(delivered(critical(false))).toEqual(['p'])
    })

    it('a person let through after the wait limit takes the free slot, so no automated boot starts beside them', () => {
      critical()
      gate.admit(req('p', 'interactive'))
      for (let t = 0; t < GATE_DEFAULTS.humanWaitMs; t += 10_000) { now += 10_000; critical() }
      const fx = gate.tick()
      expect(logged(fx)).toContain('human-wait-expired')
      expect(delivered(fx)).toEqual(['p'])
      critical(false)
      expect(gate.admit(req('a', 'automated'))[0]).toMatchObject({ kind: 'refuse', reason: 'host-booting' })
    })

    it('a second person sends the first one waiting into the free slot, and waits in their place', () => {
      critical()
      gate.admit(req('p', 'interactive'))
      now += 5_000
      const fx = gate.admit(req('q', 'interactive'))
      expect(kinds(fx)).toEqual(['deliver:p', 'waiting:q'])
      expect(fx.find((e) => e.kind === 'waiting')).toMatchObject({ until: now + GATE_DEFAULTS.humanWaitMs, reason: 'host-memory-critical' })
      expect(gate.isBooting(HOST)).toBe(true)
      // A third finds the slot taken, which is the rare overlap the gate lets through rather than queue.
      expect(kinds(gate.admit(req('r', 'interactive')))).toEqual(['deliver:r'])
    })

    it('does not let an aging window run out while automation cannot use it', () => {
      gate.admit(req('first', 'interactive'))
      gate.admit(req('auto', 'automated'))
      settle('first')
      for (let i = 0; i < GATE_DEFAULTS.agingCount - 1; i++) {
        gate.admit(req(`p${i}`, 'interactive'))
        gate.admit(req('auto', 'automated'))
        settle(`p${i}`)
      }
      gate.admit(req('last', 'interactive'))
      critical()
      expect(logged(settle('last'))).toContain('aging-window')
      // A person arrives and waits behind the window as usual.
      expect(gate.admit(req('late', 'interactive'))[0]).toMatchObject({ kind: 'waiting', sessionId: 'late' })
      // Critical outlasts the window: it does not expire, and the timer is not asked to fire in the past.
      // 50 s: past the 45 s window, inside the person's 60 s limit.
      for (let t = 0; t < GATE_DEFAULTS.agingWindowMs + 5_000; t += 10_000) {
        now += 10_000
        critical()
        expect(delivered(gate.tick())).toEqual([])
      }
      expect(gate.nextDeadline()).toBeGreaterThan(now)
      // Pressure clears and automation gets a whole window again, not one that ran out meanwhile.
      expect(delivered(critical(false))).toEqual([])
      now += 5_000
      expect(delivered(gate.tick())).toEqual([])
      expect(kinds(gate.admit(req('auto', 'automated')))).toEqual(['deliver:auto'])
    })

    /** Opens an aging window: agingCount people in a row while automation is refused. */
    function openWindow(): void {
      gate.admit(req('first', 'interactive'))
      gate.admit(req('auto', 'automated'))
      settle('first')
      for (let i = 0; i < GATE_DEFAULTS.agingCount; i++) {
        gate.admit(req(`p${i}`, 'interactive'))
        gate.admit(req('auto', 'automated'))
        expect(logged(settle(`p${i}`)).includes('aging-window')).toBe(i === GATE_DEFAULTS.agingCount - 1)
      }
    }

    it('a person whose wait runs out behind a window frozen by critical takes the slot', () => {
      openWindow()
      gate.admit(req('late', 'interactive'))
      let fx: Effect<string>[] = []
      for (let t = 0; t < GATE_DEFAULTS.humanWaitMs; t += 10_000) { now += 10_000; fx = [...critical(), ...gate.tick()] }
      expect(delivered(fx)).toEqual(['late'])
      expect(gate.isBooting(HOST)).toBe(true)
      critical(false)
      expect(gate.admit(req('auto', 'automated'))[0]).toMatchObject({ kind: 'refuse', reason: 'host-booting' })
    })

    it('a window paused by a short spell of critical resumes with what it had left', () => {
      openWindow()
      gate.admit(req('late', 'interactive'))
      now += 40_000
      critical()
      now += 5_000
      critical(false)
      now += GATE_DEFAULTS.agingWindowMs - 40_000 - 1
      expect(delivered(gate.tick())).toEqual([])
      now += 1
      expect(delivered(gate.tick())).toEqual(['late'])
    })
  })
})

// A lease asks every Mac it passes over, so asking must agree with `admit` and must leave nothing behind.
describe('wouldRefuseAutomated', () => {
  /** What `admit` answers an automated cold boot now: `null` for go, else the refusal. Mutates the gate. */
  const admitted = (id: string) => {
    const fx = gate.admit(req(id, 'automated'))
    const refused = fx.find((e) => e.kind === 'refuse')
    return refused?.kind === 'refuse' ? refused.reason : fx.some((e) => e.kind === 'deliver') ? null : 'other'
  }

  it('answers what admit would, in every state the automated branch reads', () => {
    expect(gate.wouldRefuseAutomated(HOST)).toBeNull() // a Mac never seen
    expect(gate.wouldRefuseAutomated(HOST)).toBe(admitted('a')) // free slot
    expect(gate.wouldRefuseAutomated(HOST)).toBe('host-booting') // slot held
    expect(admitted('b')).toBe('host-booting')
    settle('a')
    gate.admit(req('p', 'interactive'))
    gate.admit(req('q', 'interactive')) // q waits in the reservation behind p
    settle('p') // q takes the slot
    expect(gate.wouldRefuseAutomated(HOST)).toBe(admitted('c'))
    settle('q')
    gate.onEvent({ kind: 'pressure', hostKey: HOST, critical: true })
    expect(gate.wouldRefuseAutomated(HOST)).toBe('host-memory-critical')
    expect(admitted('d')).toBe('host-memory-critical')
  })

  it('agrees with admit while a person waits in the reservation', () => {
    gate.admit(req('p', 'interactive'))
    gate.admit(req('q', 'interactive'))
    expect(gate.wouldRefuseAutomated(HOST)).toBe('host-booting')
    expect(admitted('a')).toBe('host-booting')
  })

  // The reason it exists: a refusal stamped on a Mac the lease passed over would count toward aging there, and a
  // person on that Mac would be made to wait for a boot that went elsewhere.
  it('stamps no refusal, so asking alone never opens an aging window', () => {
    gate.admit(req('first', 'interactive'))
    expect(gate.wouldRefuseAutomated(HOST)).toBe('host-booting')
    settle('first')
    for (let i = 0; i < GATE_DEFAULTS.agingCount + 1; i++) {
      gate.admit(req(`p${i}`, 'interactive'))
      expect(gate.wouldRefuseAutomated(HOST)).toBe('host-booting')
      expect(logged(settle(`p${i}`))).not.toContain('aging-window')
    }
  })
})
