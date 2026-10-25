import type { ServiceTier } from '@tapflowio/protocol'

/**
 * Whether two service tiers switch off the same services: the same name and the same kept features as a set
 * (order and repeats do not count; `stock` has none). Shared because the agent decides from it whether a running device must restart onto a tier, and the relay
 * decides from it whether that boot costs a cold boot — the two must not disagree.
 */
export function sameServiceTier(a: ServiceTier, b: ServiceTier): boolean {
  if (a.name !== b.name) return false
  // `stock` switches nothing off, so there is nothing for `keep` to keep on — and no marker records one. Compared by
  // its features, `stock` with `keep` would differ from the device's recorded `stock` on every run and restart it.
  if (a.name === 'stock') return true
  const left = new Set(a.keep)
  const right = new Set(b.keep)
  return left.size === right.size && [...left].every((f) => right.has(f))
}
