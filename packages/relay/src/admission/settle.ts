/**
 * When a booted device has stopped costing its Mac.
 *
 * The harm a boot does to other sessions on the same Mac lasts 30–90 s after it, while the kernel compresses and
 * pages the other devices' memory to make room (`contributing/simulator-boot-contention.md`). The boot gate holds
 * its slot until that is over, and this is how it tells.
 *
 * **CPU only, and flat rather than low.** Each further device raises the CPU a settled Mac idles at, and an 8 GB
 * Mac compresses all the time, so "back to where it was before the boot" never arrives and a rule built on it is
 * a fixed timer in disguise. Decompressions are left out for the same reason: an Android emulator and a lean
 * iOS simulator go on decompressing 10–30 thousand pages a second once settled while the person's session is at
 * baseline (M2, 2026-10-23), so a floor on them would hold the slot until the cap every time.
 *
 * The numbers come from 27 measured boots on an 8 GB Mac (L2 admission plan, appendix 숫자 결정): three flat
 * samples put the settle point at 45 s after boot on average, 76–84 s for an unmodified simulator, and inside
 * the harm in 7 of 27 boots, most of them at the rate a Mac with no boot shows anyway. Four samples cut that
 * to 5 and moved the average to 58 s.
 */
export const SETTLE = {
  /** Consecutive samples that must agree. Agents report every 5 s, so this is 15 s. */
  samples: 3,
  /** Largest spread across those samples, in percentage points. */
  spread: 10,
  /** Every one of them below this. A Mac pinned near 100 % is not settled however flat it reads. */
  ceiling: 90,
  /** A sample older than this is not about now. Three missed reports. */
  freshMs: 15_000,
} as const

/**
 * Whether the samples taken since the device reported ready say it has settled. The caller drops the first
 * sample after ready: an agent's CPU reading averages over the interval since its previous one, so it still
 * covers the boot.
 */
export function isSettled(cpuSinceReady: readonly number[]): boolean {
  if (cpuSinceReady.length < SETTLE.samples) return false
  const last = cpuSinceReady.slice(-SETTLE.samples)
  const high = Math.max(...last)
  return high < SETTLE.ceiling && high - Math.min(...last) <= SETTLE.spread
}
