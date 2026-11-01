import { execFile } from 'child_process'
import { promisify } from 'util'
import { createLogger, type Device } from '@tapflowio/agent-core'

const logger = createLogger('ios-agent:devicectl')
const execFileAsync = promisify(execFile)

// The default ceiling on one devicectl call. A list merged into the simulators' holds them up for as long as it
// takes, so a caller someone is waiting on passes a shorter one (a boot passes 3 s); one `devicectl list devices`
// measured 0.22–0.72 s with ten paired devices (Xcode 26.3).
const DEFAULT_TIMEOUT_MS = 15_000

/** Runs `xcrun <args>` and resolves with its stdout; rejects with the exit status and stderr on failure. */
export type XcrunExec = (args: string[], timeoutMs?: number) => Promise<string>

const defaultExec: XcrunExec = async (args, timeoutMs) =>
  (await execFileAsync('xcrun', args, { timeout: timeoutMs ?? DEFAULT_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 })).stdout

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

/**
 * The iPhones and iPads in `devicectl list devices` an iOS session can use: plugged in over USB with its tunnel up,
 * trusted, and in Developer Mode. Over Wi-Fi a device's screen cannot be captured, and without Developer Mode nothing
 * can be installed on it, so a device that misses either is left out rather than offered and then refused.
 *
 * Known by the hardware UDID, not devicectl's CoreDevice identifier: xcodebuild's `-destination id=` and the screen
 * capture device both use the UDID, and devicectl accepts it too.
 */
export function parsePhysicalDevices(doc: unknown): Device[] {
  const result = isObj(doc) ? doc.result : undefined
  const list = isObj(result) && Array.isArray(result.devices) ? result.devices : []
  const devices: Device[] = []
  for (const d of list) {
    if (!isObj(d)) continue
    const hw = isObj(d.hardwareProperties) ? d.hardwareProperties : {}
    const conn = isObj(d.connectionProperties) ? d.connectionProperties : {}
    const props = isObj(d.deviceProperties) ? d.deviceProperties : {}
    const deviceType = str(hw.deviceType)
    const udid = str(hw.udid)
    if (hw.reality !== 'physical' || (deviceType !== 'iPhone' && deviceType !== 'iPad') || !udid) continue
    if (conn.transportType !== 'wired' || conn.tunnelState !== 'connected' || conn.pairingState !== 'paired') continue
    if (props.developerModeStatus !== 'enabled') continue
    const version = str(props.osVersionNumber)
    devices.push({
      id: udid,
      name: str(props.name) ?? udid,
      platform: 'ios',
      status: 'booted',
      ...(version ? { osVersion: `${deviceType === 'iPad' ? 'iPadOS' : 'iOS'} ${version}` } : {}),
      formFactor: deviceType === 'iPad' ? 'tablet' : 'phone',
      kind: 'physical',
    })
  }
  return devices
}

export class DevicectlWrapper {
  constructor(private readonly exec: XcrunExec = defaultExec) {}

  /** USB-connected iPhones and iPads (see `parsePhysicalDevices`). **Never rejects** unless `rejectOnFailure` is set:
   *  a Mac whose devicectl is missing, failing or slower than `timeoutMs` still has its simulators to offer, and this
   *  list is merged into theirs. The periodic re-read sets it, because to a re-read an empty list means every phone
   *  was unplugged, and a devicectl that failed this once says nothing of the kind. */
  async listPhysicalDevices(timeoutMs?: number, options: { rejectOnFailure?: boolean } = {}): Promise<Device[]> {
    const args = ['devicectl', 'list', 'devices', '-j', '-', '-q']
    try {
      return parsePhysicalDevices(JSON.parse(await (timeoutMs === undefined ? this.exec(args) : this.exec(args, timeoutMs))))
    } catch (e) {
      if (options.rejectOnFailure) throw e
      logger.warn(`physical devices unavailable: ${e instanceof Error ? e.message : String(e)}`)
      return []
    }
  }
}
