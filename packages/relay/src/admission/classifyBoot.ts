import type { DeviceStatus } from '@tapflowio/agent-core'
import { sameServiceTier } from '@tapflowio/agent-core/utils'
import type { DeviceBoot, ServiceTier } from '@tapflowio/protocol'

/**
 * Whether a boot will cost the Mac a boot: `cold` brings a device up, `warm` finds it running and only opens a
 * stream. Decided before the boot is forwarded, because that is when the gate has to charge it — the agent's
 * own answer (`device:ready.payload.cold`) comes after, and corrects this one in the gate when they differ.
 *
 * `deviceStatus` is what the relay last heard: the agent's list at registration, then `booted` on every ready and
 * `shutdown` on every shutdown. Only `'full-erase'` restarts a running device; `'app-only'`, which the dashboard
 * sends on every boot, does not.
 *
 * **A running device on another service tier than the boot asks for is cold too**: the agent restarts it onto the
 * tier (`IOSAgent.handleDeviceBoot`, `retier`). Compared only when both sides are known — a boot that asks for
 * none takes whatever the device has, and a device whose tier is `unsupported` or unreported cannot change.
 */
export function classifyBoot(
  deviceStatus: DeviceStatus,
  payload: Pick<DeviceBoot['payload'], 'resetMode' | 'serviceTier'>,
  currentTier: ServiceTier | 'unsupported' | undefined,
): 'cold' | 'warm' {
  if (deviceStatus !== 'booted' || payload.resetMode === 'full-erase') return 'cold'
  const asked = payload.serviceTier
  if (asked && currentTier && currentTier !== 'unsupported' && !sameServiceTier(currentTier, asked)) return 'cold'
  return 'warm'
}
