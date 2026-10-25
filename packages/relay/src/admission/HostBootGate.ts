import type { BootRefusalReason } from '@tapflowio/protocol'
import { isSettled, SETTLE } from './settle.js'

/**
 * One cold boot at a time per Mac, and a person never refused for it.
 *
 * A device that has finished booting does not slow the other sessions on its Mac; the boot does, for 30–90 s
 * (`contributing/simulator-boot-contention.md`). So each Mac has one boot **slot**, held from the moment a cold
 * boot is let through until the device has settled. An automated client (flow runner, MCP) that finds it taken is
 * refused with `host-booting` and retries on its own. A person is never refused: their boot waits in the Mac's
 * one-place **reservation**, which goes ahead of any automated retry, for at most `humanWaitMs`.
 *
 * Pure state: no sockets and no timers. Every call returns what the relay should do, and `nextDeadline()` says
 * when it must call `tick()`. That is read after the relay has carried out the effects rather than returned with
 * them, because carrying one out can feed the gate again (a held boot whose agent has gone is answered and
 * released), and a deadline returned before that would already be stale. The message a held boot carries rides in the gate as `M`, so there
 * is one owner of a held boot rather than a gate entry and a relay map that can disagree.
 *
 * **Memory is a safety valve, not a budget.** While an agent on the Mac reports critical kernel memory pressure, no
 * automated cold boot is let through (`host-memory-critical`) and a person's waits in the reservation as it would
 * behind a boot. The reading counts for `SETTLE.freshMs` after the last report that said so, so a Mac whose agents
 * went quiet is not held shut by their last word.
 *
 * **What releases a slot is a closed list** (`GateEvent`), not a general release call. A rebind, a correlator's
 * TTL or an evicted boot record does not appear in it, because the device is still booting on that Mac through
 * all three — the slot is about the Mac, `pendingBoots` is about who is waiting for an answer.
 */

export type BooterClass = 'interactive' | 'automated'

export interface GateTiming {
  /** A slot still `booting` after this is let go. The clients' own boot deadline: past it nobody is waiting. */
  bootMs: number
  /** A settling slot is let go this long after ready, settled or not. The slowest measured settle was 84 s. */
  settleCapMs: number
  /** With no CPU sample at all since ready, the slot is let go after this. Covers 76–84 s unmodified settles. */
  noSampleMs: number
  /** A person's boot waits in the reservation at most this long, then goes ahead regardless. */
  humanWaitMs: number
  /** After a rebind during booting, a slot whose session sends no new boot for this long is taken as abandoned. */
  reboundMs: number
  /** After this many people in a row took the slot while an automated client was being refused… */
  agingCount: number
  /** …the next free slot is kept for automation this long. Longer than the clients' largest backoff. */
  agingWindowMs: number
  /** An automated refusal counts as someone still waiting for this long. About twice the largest backoff. */
  recentRefusalMs: number
}

/** Numbers and their sources: L2 admission plan, appendix 숫자 결정. */
export const GATE_DEFAULTS: GateTiming = {
  bootMs: 180_000,
  settleCapMs: 120_000,
  noSampleMs: 90_000,
  humanWaitMs: 60_000,
  reboundMs: 30_000,
  agingCount: 3,
  agingWindowMs: 45_000,
  recentRefusalMs: 60_000,
}

export interface BootRequest<M> {
  hostKey: string
  sessionId: string
  requestId: string
  cost: 'cold' | 'warm'
  booterClass: BooterClass
  message: M
}

export type GateLogEvent =
  | 'overlap'
  | 'boot-timeout'
  | 'settle-timeout'
  | 'no-samples'
  | 'human-wait-expired'
  | 'rebound-abandoned'
  | 'aging-window'
  | 'memory-critical'
  | 'memory-critical-stale'

export type Effect<M> =
  /** Send this boot to its agent now. */
  | { kind: 'deliver'; sessionId: string; requestId: string; message: M }
  /** Answer this automated boot with `device:boot-error` and the reason; it was never forwarded. */
  | { kind: 'refuse'; sessionId: string; requestId: string; reason: BootRefusalReason; message: M }
  /** A person's boot is now held, or held for a different reason than they were told; tell them, and when it goes
   *  ahead regardless. */
  | { kind: 'waiting'; sessionId: string; requestId: string; until: number; reason: BootRefusalReason; message: M }
  /** A held boot that will not go ahead: answer it with `device:boot-error`. */
  | { kind: 'withdraw'; sessionId: string; requestId: string; why: 'cancelled' | 'replaced'; message: M }
  | { kind: 'log'; event: GateLogEvent; hostKey: string; sessionId?: string }

export type GateEvent =
  /** The agent's `device:ready`. `cold` is its own account, absent from an agent that predates it. */
  | { kind: 'ready'; hostKey: string; sessionId: string; cold?: boolean }
  /** One `agent:resources` report from any agent on that Mac. */
  | { kind: 'sample'; hostKey: string; cpuPercent: number }
  /** The memory pressure on that report, from an agent that reads it. A report without one says nothing either way. */
  | { kind: 'pressure'; hostKey: string; critical: boolean }
  /** The agent's `device:boot-error`. No `requestId` is an Android stream that died outside a boot. */
  | { kind: 'boot-error'; sessionId: string; requestId?: string }
  | { kind: 'shutdown-done'; sessionId: string }
  | { kind: 'session-removed'; sessionId: string }
  /** The person's socket went away or they left: a held boot has nobody to show it to. */
  | { kind: 'browser-closed'; sessionId: string }
  /** The session moved to a restarted agent while its device may still be booting. */
  | { kind: 'rebound'; sessionId: string }

interface Slot {
  sessionId: string
  /** The boot whose failure releases the slot. Empty for a slot claimed from a ready, which no failure names. */
  requestId: string
  phase: 'booting' | 'settling'
  since: number
  readyAt: number | null
  /** CPU since ready, the first report dropped. */
  samples: number[]
  droppedFirst: boolean
  lastSampleAt: number | null
  reboundAt: number | null
}

interface Held<M> {
  sessionId: string
  requestId: string
  message: M
  since: number
  /** What the person was last told they are waiting for. */
  reason: BootRefusalReason
}

interface Host<M> {
  slot: Slot | null
  reservation: Held<M> | null
  /** People given the slot in a row while automation was being refused. */
  humanStreak: number
  lastAutomatedRefusalAt: number | null
  agingWindowUntil: number | null
  /** Critical memory pressure holds until this, unless a report says otherwise first. */
  criticalUntil: number | null
  /** What an aging window had left when pressure turned critical; it resumes with that much. */
  windowLeftMs: number | null
}

/**
 * Two agents on one Mac each report every 5 s, and each report is the host's CPU averaged since that agent's
 * previous one. Taking both would make `SETTLE.samples` mean half the time it was measured at, so a report
 * closer than this to the last one taken is skipped.
 */
const MIN_SAMPLE_GAP_MS = 4_000

export class HostBootGate<M> {
  private readonly hosts = new Map<string, Host<M>>()

  constructor(
    private readonly now: () => number,
    private readonly timing: GateTiming = GATE_DEFAULTS,
  ) {}

  admit(req: BootRequest<M>): Effect<M>[] {
    const fx: Effect<M>[] = []
    const host = this.host(req.hostKey)
    const now = this.now()

    if (host.reservation?.sessionId === req.sessionId) {
      // The same person asked again (a reconnect re-sends its boot). Keep their place and their clock.
      fx.push({ kind: 'withdraw', sessionId: req.sessionId, requestId: host.reservation.requestId, why: 'replaced', message: host.reservation.message })
      if (req.cost === 'warm') {
        host.reservation = null
        fx.push(this.deliverOf(req))
      } else {
        host.reservation = { ...host.reservation, requestId: req.requestId, message: req.message, reason: this.waitReason(host) }
        fx.push(this.waitingOf(host.reservation))
      }
      return fx
    }

    if (host.slot?.sessionId === req.sessionId) {
      // A re-boot of the device already holding the slot: the agent supersedes its own boot, and the Mac is
      // paying for one boot, not two. The slot follows the newest correlator so only its failure releases it.
      Object.assign(host.slot, { requestId: req.requestId, phase: 'booting', since: now, readyAt: null, samples: [], droppedFirst: false, reboundAt: null })
      fx.push(this.deliverOf(req))
      return fx
    }

    if (req.cost === 'warm') {
      fx.push(this.deliverOf(req))
      return fx
    }

    // Below the same-session and warm branches on purpose: a re-boot of the slot's own device and a device already up
    // add no boot to the Mac, and refusing the first would orphan the slot until its boot timeout.
    const critical = this.isCritical(host)
    const windowOpen = host.agingWindowUntil !== null
    if (req.booterClass === 'automated') {
      if (critical) {
        host.lastAutomatedRefusalAt = now
        fx.push({ kind: 'refuse', sessionId: req.sessionId, requestId: req.requestId, reason: 'host-memory-critical', message: req.message })
      } else if (host.slot === null && (windowOpen || host.reservation === null)) {
        this.takeSlot(host, req)
        host.humanStreak = 0
        host.agingWindowUntil = null
        fx.push(this.deliverOf(req))
      } else {
        host.lastAutomatedRefusalAt = now
        fx.push({ kind: 'refuse', sessionId: req.sessionId, requestId: req.requestId, reason: 'host-booting', message: req.message })
      }
      return fx
    }

    if (host.slot === null && !windowOpen && !critical) {
      this.takeSlot(host, req)
      this.noteHumanGrant(host)
      fx.push(this.deliverOf(req))
    } else if (host.reservation === null) {
      host.reservation = { sessionId: req.sessionId, requestId: req.requestId, message: req.message, since: now, reason: this.waitReason(host) }
      fx.push(this.waitingOf(host.reservation))
    } else {
      // The one place is taken. A second person at once is rare enough to let through rather than queue.
      fx.push({ kind: 'log', event: 'overlap', hostKey: req.hostKey, sessionId: req.sessionId })
      const held = host.reservation
      if (host.slot === null && critical) {
        // The free slot goes to whoever asked first: the held person goes now, and this one takes their place.
        host.reservation = { sessionId: req.sessionId, requestId: req.requestId, message: req.message, since: now, reason: this.waitReason(host) }
        this.deliverAnyway(host, held, fx)
        fx.push(this.waitingOf(host.reservation))
      } else {
        this.deliverAnyway(host, req, fx)
      }
    }
    return fx
  }

  onEvent(ev: GateEvent): Effect<M>[] {
    const fx: Effect<M>[] = []
    switch (ev.kind) {
      case 'ready': {
        const found = this.slotOf(ev.sessionId)
        if (found) {
          if (ev.cold === false) {
            // Charged as cold, and the agent found the device running: nothing to wait for.
            this.release(found.key, found.host, fx)
          } else {
            Object.assign(found.host.slot!, { phase: 'settling', readyAt: this.now(), samples: [], droppedFirst: false, lastSampleAt: null })
          }
        } else if (ev.cold === true) {
          // Let through as warm, and the agent had to bring it up after all (stopped between our view and its).
          const host = this.host(ev.hostKey)
          if (host.slot === null) {
            const now = this.now()
            host.slot = { sessionId: ev.sessionId, requestId: '', phase: 'settling', since: now, readyAt: now, samples: [], droppedFirst: false, lastSampleAt: null, reboundAt: null }
          } else {
            fx.push({ kind: 'log', event: 'overlap', hostKey: ev.hostKey, sessionId: ev.sessionId })
          }
        }
        break
      }
      case 'sample': {
        const slot = this.hosts.get(ev.hostKey)?.slot
        if (!slot || slot.phase !== 'settling') break
        const now = this.now()
        if (slot.lastSampleAt !== null && now - slot.lastSampleAt < MIN_SAMPLE_GAP_MS) break
        if (slot.lastSampleAt !== null && now - slot.lastSampleAt > SETTLE.freshMs) slot.samples = []
        slot.lastSampleAt = now
        if (!slot.droppedFirst) { slot.droppedFirst = true; break }
        slot.samples.push(ev.cpuPercent)
        if (isSettled(slot.samples)) this.release(ev.hostKey, this.host(ev.hostKey), fx)
        break
      }
      case 'pressure': {
        const host = this.host(ev.hostKey)
        const now = this.now()
        if (ev.critical) {
          const was = this.isCritical(host)
          host.criticalUntil = now + SETTLE.freshMs
          if (!was) {
            fx.push({ kind: 'log', event: 'memory-critical', hostKey: ev.hostKey })
            if (host.agingWindowUntil !== null) host.windowLeftMs = Math.max(0, host.agingWindowUntil - now)
            this.refreshWaiting(host, fx)
          }
        } else if (host.criticalUntil !== null) {
          host.criticalUntil = null
          this.criticalEnded(host, fx)
        }
        break
      }
      case 'boot-error': {
        const found = this.slotOf(ev.sessionId)
        if (found && (ev.requestId === undefined || ev.requestId === found.host.slot!.requestId)) {
          this.release(found.key, found.host, fx)
        }
        break
      }
      case 'shutdown-done':
      case 'session-removed': {
        this.withdrawHeld(ev.sessionId, fx)
        const found = this.slotOf(ev.sessionId)
        if (found) this.release(found.key, found.host, fx)
        break
      }
      case 'browser-closed':
        this.withdrawHeld(ev.sessionId, fx)
        break
      case 'rebound': {
        const found = this.slotOf(ev.sessionId)
        if (found) found.host.slot!.reboundAt = this.now()
        break
      }
      default: {
        const never: never = ev
        throw new Error(`unhandled gate event ${JSON.stringify(never)}`)
      }
    }
    return fx
  }

  /** Act on every deadline that has passed. */
  tick(): Effect<M>[] {
    const fx: Effect<M>[] = []
    const now = this.now()
    const t = this.timing
    for (const [key, host] of this.hosts) {
      // First, so a reservation the expiry frees goes out in this same tick.
      if (host.criticalUntil !== null && now >= host.criticalUntil) {
        host.criticalUntil = null
        fx.push({ kind: 'log', event: 'memory-critical-stale', hostKey: key })
        this.criticalEnded(host, fx)
      }
      const slot = host.slot
      if (slot) {
        let expired: GateLogEvent | null = null
        // Only while booting: once the device is up its slot runs on the settle clocks, and the automated clients
        // re-boot after a rebind only when their next step needs it, so a settling device would be released early.
        if (slot.phase === 'booting' && slot.reboundAt !== null && now >= slot.reboundAt + t.reboundMs) expired = 'rebound-abandoned'
        else if (slot.phase === 'booting' && now >= slot.since + t.bootMs) expired = 'boot-timeout'
        else if (slot.phase === 'settling' && slot.readyAt !== null) {
          if (now >= slot.readyAt + t.settleCapMs) expired = 'settle-timeout'
          else if (slot.lastSampleAt === null && now >= slot.readyAt + t.noSampleMs) expired = 'no-samples'
        }
        if (expired) {
          fx.push({ kind: 'log', event: expired, hostKey: key, sessionId: slot.sessionId })
          this.release(key, host, fx)
        }
      }
      // Not while critical: automation is refused then, so the window would run out with nobody able to use it.
      // `criticalEnded` starts it again.
      if (host.agingWindowUntil !== null && now >= host.agingWindowUntil && !this.isCritical(host)) {
        host.agingWindowUntil = null
        host.humanStreak = 0
        this.dispatchReservation(host, fx)
      }
      const held = host.reservation
      if (held && now >= held.since + t.humanWaitMs) {
        host.reservation = null
        fx.push({ kind: 'log', event: 'human-wait-expired', hostKey: key, sessionId: held.sessionId })
        this.deliverAnyway(host, held, fx)
      }
    }
    return fx
  }

  /**
   * What `admit` would answer an automated cold boot on this Mac now — `null` for go — without recording anything.
   * A lease tries Macs in turn, and an `admit` per candidate would stamp a refusal on each Mac it passed over: that
   * stamp is what opens an aging window for automation, so people on those Macs would be made to wait for a boot
   * that went elsewhere. Mirrors the automated branch of `admit` and must move with it.
   */
  wouldRefuseAutomated(hostKey: string): BootRefusalReason | null {
    const host = this.hosts.get(hostKey)
    if (!host) return null
    if (this.isCritical(host)) return 'host-memory-critical'
    return host.slot === null && (host.agingWindowUntil !== null || host.reservation === null) ? null : 'host-booting'
  }

  /** Whether a cold boot is being paid for on this Mac now. The relay pauses its CPU join gate while it is. */
  isBooting(hostKey: string): boolean {
    return this.hosts.get(hostKey)?.slot != null
  }

  private release(key: string, host: Host<M>, fx: Effect<M>[]): void {
    host.slot = null
    const now = this.now()
    const automationWaiting = host.lastAutomatedRefusalAt !== null && now - host.lastAutomatedRefusalAt <= this.timing.recentRefusalMs
    if (automationWaiting && host.humanStreak >= this.timing.agingCount) {
      host.agingWindowUntil = now + this.timing.agingWindowMs
      fx.push({ kind: 'log', event: 'aging-window', hostKey: key })
      return
    }
    this.dispatchReservation(host, fx)
  }

  private criticalEnded(host: Host<M>, fx: Effect<M>[]): void {
    // A window that opened during critical gets its whole length; one that was running gets what it had left.
    if (host.agingWindowUntil !== null) host.agingWindowUntil = this.now() + (host.windowLeftMs ?? this.timing.agingWindowMs)
    host.windowLeftMs = null
    this.dispatchReservation(host, fx)
    this.refreshWaiting(host, fx)
  }

  /**
   * A boot let through regardless — a second person while the reservation is taken, or a person whose wait ran
   * out. With the slot free it takes the slot, so the boot is tracked to its settle like any other: free here means
   * the Mac was critical, and letting it through slotless would let the next automated boot start beside it the
   * moment pressure cleared. An open aging window keeps it slotless only while automation can use that slot; under
   * critical pressure it cannot, and a window frozen by critical can outlast a person's wait.
   */
  private deliverAnyway(host: Host<M>, req: { sessionId: string; requestId: string; message: M }, fx: Effect<M>[]): void {
    if (host.slot === null && (host.agingWindowUntil === null || this.isCritical(host))) {
      this.takeSlot(host, req)
      this.noteHumanGrant(host)
    }
    fx.push({ kind: 'deliver', sessionId: req.sessionId, requestId: req.requestId, message: req.message })
  }

  private isCritical(host: Host<M>): boolean {
    return host.criticalUntil !== null && this.now() < host.criticalUntil
  }

  private waitReason(host: Host<M>): BootRefusalReason {
    return this.isCritical(host) ? 'host-memory-critical' : 'host-booting'
  }

  /** Tell a held person when what they wait for has changed, keeping their place and clock. Called on each change of
   *  pressure, since that is the only thing `waitReason` reads. */
  private refreshWaiting(host: Host<M>, fx: Effect<M>[]): void {
    const held = host.reservation
    if (!held) return
    const reason = this.waitReason(host)
    if (reason === held.reason) return
    held.reason = reason
    fx.push(this.waitingOf(held))
  }

  private waitingOf(held: Held<M>): Effect<M> {
    return { kind: 'waiting', sessionId: held.sessionId, requestId: held.requestId, until: held.since + this.timing.humanWaitMs, reason: held.reason, message: held.message }
  }

  private dispatchReservation(host: Host<M>, fx: Effect<M>[]): void {
    const held = host.reservation
    if (!held || host.slot !== null || host.agingWindowUntil !== null || this.isCritical(host)) return
    host.reservation = null
    this.takeSlot(host, held)
    this.noteHumanGrant(host)
    fx.push({ kind: 'deliver', sessionId: held.sessionId, requestId: held.requestId, message: held.message })
  }

  private noteHumanGrant(host: Host<M>): void {
    const automationWaiting = host.lastAutomatedRefusalAt !== null && this.now() - host.lastAutomatedRefusalAt <= this.timing.recentRefusalMs
    host.humanStreak = automationWaiting ? host.humanStreak + 1 : 0
  }

  private withdrawHeld(sessionId: string, fx: Effect<M>[]): void {
    for (const host of this.hosts.values()) {
      if (host.reservation?.sessionId !== sessionId) continue
      fx.push({ kind: 'withdraw', sessionId, requestId: host.reservation.requestId, why: 'cancelled', message: host.reservation.message })
      host.reservation = null
    }
  }

  private takeSlot(host: Host<M>, req: { sessionId: string; requestId: string }): void {
    host.slot = { sessionId: req.sessionId, requestId: req.requestId, phase: 'booting', since: this.now(), readyAt: null, samples: [], droppedFirst: false, lastSampleAt: null, reboundAt: null }
  }

  private deliverOf(req: BootRequest<M>): Effect<M> {
    return { kind: 'deliver', sessionId: req.sessionId, requestId: req.requestId, message: req.message }
  }

  private slotOf(sessionId: string): { key: string; host: Host<M> } | null {
    for (const [key, host] of this.hosts) if (host.slot?.sessionId === sessionId) return { key, host }
    return null
  }

  private host(key: string): Host<M> {
    let host = this.hosts.get(key)
    if (!host) {
      host = { slot: null, reservation: null, humanStreak: 0, lastAutomatedRefusalAt: null, agingWindowUntil: null, criticalUntil: null, windowLeftMs: null }
      this.hosts.set(key, host)
    }
    return host
  }

  /** When `tick()` must next run, or null when nothing is pending. */
  nextDeadline(): number | null {
    const t = this.timing
    let next: number | null = null
    const consider = (at: number): void => { if (next === null || at < next) next = at }
    for (const host of this.hosts.values()) {
      const slot = host.slot
      if (slot) {
        if (slot.phase === 'booting' && slot.reboundAt !== null) consider(slot.reboundAt + t.reboundMs)
        if (slot.phase === 'booting') consider(slot.since + t.bootMs)
        else if (slot.readyAt !== null) {
          consider(slot.readyAt + t.settleCapMs)
          if (slot.lastSampleAt === null) consider(slot.readyAt + t.noSampleMs)
        }
      }
      if (host.criticalUntil !== null) consider(host.criticalUntil)
      // A window does not run out while critical, and a past deadline here would spin the relay's timer.
      if (host.agingWindowUntil !== null && !this.isCritical(host)) consider(host.agingWindowUntil)
      if (host.reservation) consider(host.reservation.since + t.humanWaitMs)
    }
    return next
  }
}
