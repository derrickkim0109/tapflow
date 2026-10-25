import type { AdmissionRefusal } from '@tapflowio/protocol'

/** A device a lease could take, with what the relay would answer if it tried. */
export interface LeaseCandidate {
  sessionId: string
  hostKey: string
  /** Up from an earlier automated boot and idle, so leasing it boots nothing. */
  pool: boolean
  /** When automation booted it; the older of two pool devices goes first, as the cap's eviction would take it. */
  bootedAt: number
  /** Why taking it now would be refused, or `null` if it would go. */
  refusal: AdmissionRefusal | null
}

/** What the relay knows of a Mac's room, from its agents' reports. `null` when it has not reported. */
export interface LeaseHost {
  /** Memory left, by its latest report. */
  freeMB: number | null
  cpuPercent: number | null
  /** Automation devices up or starting on it. */
  automated: number
}

export type LeaseChoice =
  | { ok: true; sessionId: string }
  /** `hostKey`: a Mac that refused for critical memory, so the caller can free an idle device there. */
  | { ok: false; reason: AdmissionRefusal; criticalHost?: string }

/**
 * Which refusal to report when every candidate was refused: the one a client is likeliest to see lift by waiting.
 * A boot settles within a minute or two; the cap lifts when a run lets a device go; a busy CPU or critical memory can
 * last as long as the load behind it.
 */
const WAIT_ORDER: readonly AdmissionRefusal[] = ['host-booting', 'host-at-capacity', 'agent-resources-exhausted', 'host-memory-critical']

/**
 * Pick the device for a lease. A device already up wins over one to boot, on any Mac: it costs no boot. Between
 * boots, the Mac with the most memory left goes first, then the idler CPU, then the one running fewer automation
 * devices; a Mac that has not reported goes last, since nothing says it has room. One cold boot per Mac is the
 * gate's rule, so spreading boots this way is what lets two Macs boot two devices at once.
 */
export function chooseLease(candidates: readonly LeaseCandidate[], hosts: ReadonlyMap<string, LeaseHost>): LeaseChoice {
  const open = candidates.filter((c) => c.refusal === null)
  if (open.length > 0) {
    const room = (c: LeaseCandidate) => hosts.get(c.hostKey)?.freeMB ?? null
    const byRoom = (a: LeaseCandidate, b: LeaseCandidate) => {
      const ra = room(a), rb = room(b)
      if (ra === null || rb === null) return ra === rb ? 0 : ra === null ? 1 : -1
      return rb - ra
    }
    const pool = open.filter((c) => c.pool).sort((a, b) => byRoom(a, b) || a.bootedAt - b.bootedAt)
    if (pool.length > 0) return { ok: true, sessionId: pool[0]!.sessionId }
    const cpu = (c: LeaseCandidate) => hosts.get(c.hostKey)?.cpuPercent ?? Infinity
    const automated = (c: LeaseCandidate) => hosts.get(c.hostKey)?.automated ?? 0
    const boot = [...open].sort((a, b) => byRoom(a, b) || cpu(a) - cpu(b) || automated(a) - automated(b))
    return { ok: true, sessionId: boot[0]!.sessionId }
  }
  const refused = candidates.filter((c): c is LeaseCandidate & { refusal: AdmissionRefusal } => c.refusal !== null)
  const reason = WAIT_ORDER.find((r) => refused.some((c) => c.refusal === r)) ?? 'host-booting'
  if (reason !== 'host-memory-critical') return { ok: false, reason }
  // The Mac where freeing a device would help most: the one with the most memory already, so one device may be enough.
  const critical = refused.filter((c) => c.refusal === 'host-memory-critical')
  const best = [...critical].sort((a, b) => (hosts.get(b.hostKey)?.freeMB ?? -Infinity) - (hosts.get(a.hostKey)?.freeMB ?? -Infinity))[0]
  return { ok: false, reason, ...(best ? { criticalHost: best.hostKey } : {}) }
}
