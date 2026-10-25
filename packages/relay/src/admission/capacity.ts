/**
 * How many devices automation may keep up on one Mac, and which idle one goes to make room.
 *
 * A boot is what hurts the other sessions on a Mac; a device that has settled does not (`settle.ts`). But devices
 * add up: 4 iOS simulators on an 8 GB Mac and 9 devices on a 32 GB one kept a person's session at baseline, and
 * nothing past that was measured. Automation is what piles them up — a flow run or an MCP client ends with
 * `session:leave`, which leaves the device running — so it is automation that is capped. A person is never counted,
 * never refused and never has a device shut down for this.
 *
 * Pure: the relay hands in the Mac's devices and carries out the answer.
 */

/** One device on the Mac, as the cap sees it. */
export interface CapacityDevice {
  sessionId: string
  /** Android emulators weigh 2: one fills memory like two simulators (M2). */
  platform: string
  /** Started by automation and still up, or being started by it now. */
  automated: boolean
  /** Up and settled enough to be shut down, rather than booting. */
  booted: boolean
  /** Someone holds the session, or watches it. Never shut down. */
  inUse: boolean
  /** The relay can reach its agent, so a shutdown would arrive. */
  reachable: boolean
  /** When automation started it; the oldest goes first. */
  bootedAt: number
}

export type CapacityPlan = { ok: true; evict: string[] } | { ok: false }

export function deviceWeight(platform: string): number {
  return platform === 'android' ? 2 : 1
}

/** The default cap: half the Mac's memory in GB, between 1 and 8 (8 GB → 4, the measured point). */
export function defaultCap(memTotalMB: number): number {
  return Math.min(8, Math.max(1, Math.floor(memTotalMB / 1024 / 2)))
}

/**
 * Whether `requester` may cold-boot under `cap`, and which idle automation devices must go first. The requester's
 * own weight is left out of what is already up: a re-boot of a device automation already runs adds nothing.
 */
/**
 * The one device to shut down when an automated boot is refused because the Mac's memory is critical: the oldest idle
 * automation device, or none. One per refusal, so memory is freed a device at a time while the client retries, and
 * stops as soon as the pressure lifts.
 */
export function idleToFree(devices: readonly CapacityDevice[], requesterId: string): string | null {
  const idle = devices.filter((d) => d.automated && d.booted && !d.inUse && d.reachable && d.sessionId !== requesterId)
  if (idle.length === 0) return null
  return idle.reduce((a, b) => (b.bootedAt < a.bootedAt ? b : a)).sessionId
}

export function planCapacity(devices: readonly CapacityDevice[], requester: { sessionId: string; platform: string }, cap: number): CapacityPlan {
  const counted = devices.filter((d) => d.automated && d.sessionId !== requester.sessionId)
  let over = counted.reduce((sum, d) => sum + deviceWeight(d.platform), 0) + deviceWeight(requester.platform) - cap
  if (over <= 0) return { ok: true, evict: [] }
  const evict: string[] = []
  const idle = counted.filter((d) => d.booted && !d.inUse && d.reachable).sort((a, b) => a.bootedAt - b.bootedAt)
  for (const d of idle) {
    if (over <= 0) break
    evict.push(d.sessionId)
    over -= deviceWeight(d.platform)
  }
  return over <= 0 ? { ok: true, evict } : { ok: false }
}
