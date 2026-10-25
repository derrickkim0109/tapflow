import { AdmissionRefusedError, SessionJoinError, type AdmissionReason } from './RelayClient.js'

/**
 * Waiting out a Mac that is busy rather than broken.
 *
 * These refusals mean that: a join over the resource ceiling (`agent-resources-exhausted`), a boot behind
 * another boot on the same Mac (`host-booting`), a boot on a Mac whose kernel reports critical memory
 * pressure (`host-memory-critical`), and a boot on a Mac whose automation devices are all in use
 * (`host-at-capacity`). All clear on their own, and before the relay's boot gate a run met none of
 * them — it booted at once and slowed everyone else instead — so failing on them would turn the gate into a
 * source of red CI.
 *
 * **The attempt is expected to let go of the session before it throws.** A runner that waited while still
 * holding the session would make that device `session-busy` for a person who wanted it, for as long as the
 * wait lasted. `tapflow flow run` joins and boots inside the attempt and leaves when the boot is refused.
 */

/** The refusal behind an error, or null for any other failure — which is final. */
export function admissionRefusalOf(e: unknown): AdmissionReason | null {
  if (e instanceof AdmissionRefusedError) return e.reason
  if (e instanceof SessionJoinError && e.reason === 'agent-resources-exhausted') return e.reason
  return null
}

/**
 * 5 s, doubling to 30 s, each ±20 % so runners refused together do not come back together. A boot holds its Mac
 * for 30–90 s (`contributing/simulator-boot-contention.md`), so this asks two to four times per boot. The relay's
 * aging window for automation (`GATE_DEFAULTS.agingWindowMs`, 45 s) is longer than the largest wait on purpose:
 * a retry must be able to arrive while it is open.
 */
export const ADMISSION_BACKOFF = { firstMs: 5_000, factor: 2, maxMs: 30_000, jitter: 0.2 } as const

export interface RetryAdmissionOptions {
  /** Give up once this much time has passed since the first attempt. */
  timeoutMs: number
  /** Told before each wait, so a run can say why it is not moving. */
  onWait?: (reason: AdmissionReason, delayMs: number) => void
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  random?: () => number
}

/** What a retried attempt cost, for the run's record. */
export interface AdmissionWait {
  attempts: number
  waitedMs: number
}

/**
 * Run `attempt` until it succeeds, fails for a reason that is not an admission refusal, or `timeoutMs` passes.
 * The last refusal is rethrown when time runs out, with how long was spent in its message.
 */
export async function retryAdmission<T>(attempt: () => Promise<T>, opts: RetryAdmissionOptions): Promise<{ value: T } & AdmissionWait> {
  const now = opts.now ?? Date.now
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const random = opts.random ?? Math.random
  const started = now()
  let delay: number = ADMISSION_BACKOFF.firstMs
  for (let attempts = 1; ; attempts++) {
    try {
      return { value: await attempt(), attempts, waitedMs: now() - started }
    } catch (e) {
      const reason = admissionRefusalOf(e)
      if (reason === null) throw e
      const jittered = Math.round(delay * (1 + (random() * 2 - 1) * ADMISSION_BACKOFF.jitter))
      const left = started + opts.timeoutMs - now()
      if (left <= 0) {
        throw new AdmissionRefusedError(
          `${(e as Error).message} — still refused after ${Math.round((now() - started) / 1000)}s and ${attempts} attempts`,
          reason, { cause: e },
        )
      }
      const wait = Math.min(jittered, left)
      opts.onWait?.(reason, wait)
      await sleep(wait)
      delay = Math.min(delay * ADMISSION_BACKOFF.factor, ADMISSION_BACKOFF.maxMs)
    }
  }
}
