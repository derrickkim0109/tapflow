import type { AgentResources } from '@/lib/types'

export const RESOURCE_WARN_THRESHOLD = 70
export const RESOURCE_BLOCK_THRESHOLD = 80
/** A report older than this is treated as absent. One value for the QA Session cards and the Mac Resources
 *  live head, so a Mac is not live on one page and stale on the other. */
export const RESOURCE_STALE_MS = 30_000

export type ResourceHealth = 'unknown' | 'healthy' | 'warning' | 'overloaded'

export function getResourceHealth(
  res: AgentResources | undefined,
  isStale: boolean,
): ResourceHealth {
  if (!res || isStale) return 'unknown'
  const memPercent = (res.memUsedMB / res.memTotalMB) * 100
  if (res.cpuPercent > RESOURCE_BLOCK_THRESHOLD || memPercent > RESOURCE_BLOCK_THRESHOLD) return 'overloaded'
  if (res.cpuPercent >= RESOURCE_WARN_THRESHOLD || memPercent >= RESOURCE_WARN_THRESHOLD) return 'warning'
  return 'healthy'
}
