// `tapflow maestro` — which phone a Maestro flow runs on.
//
// **The device is always named, never picked.** A wrapper that took "the connected iPhone" once ran a suite on
// somebody's own phone because it was the one plugged in, so nothing here falls back to a default: an id that
// matches no ready device is refused with the list of ready ones.

/** A phone Maestro can drive, with the id tapflow's agents give the same phone (`usb:<serial>` / hardware UDID). */
export type MaestroDevice =
  | { platform: 'android'; serial: string; tapflowId: string; name: string }
  | { platform: 'ios'; udid: string; tapflowId: string; name: string }

/** An iPhone or iPad as `devicectl list devices` describes it. */
export interface IosCandidate {
  /** The hardware UDID (`00008140-…`): the only id Maestro's iOS driver and iproxy accept. */
  udid: string
  /** devicectl's CoreDevice identifier (a UUID). Accepted as input and translated, never passed on. */
  coreDeviceId?: string
  name: string
  /** Plugged in over USB with its tunnel up, trusted and in Developer Mode: what the driver needs. */
  ready: boolean
  /** Why it is not ready, in words for the person running the command. */
  notReady?: string
}

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined)

/** Serials `adb devices` lists as usable (`device`), leaving out `offline` and `unauthorized` ones. */
export function parseAdbDevices(out: string): string[] {
  return out
    .split('\n')
    .slice(1)
    .map((l) => l.trim().split(/\s+/))
    .filter((cols) => cols.length >= 2 && cols[1] === 'device')
    .map((cols) => cols[0])
}

/** The iPhones and iPads in a `devicectl list devices --json-output` document. */
export function parseDevicectlDevices(doc: unknown): IosCandidate[] {
  const result = isObj(doc) ? doc.result : undefined
  const list = isObj(result) && Array.isArray(result.devices) ? result.devices : []
  const out: IosCandidate[] = []
  for (const d of list) {
    if (!isObj(d)) continue
    const hw = isObj(d.hardwareProperties) ? d.hardwareProperties : {}
    const conn = isObj(d.connectionProperties) ? d.connectionProperties : {}
    const props = isObj(d.deviceProperties) ? d.deviceProperties : {}
    const udid = str(hw.udid)
    const type = str(hw.deviceType)
    if (!udid || hw.reality !== 'physical' || (type !== 'iPhone' && type !== 'iPad')) continue
    const coreDeviceId = str(d.identifier)
    // The same conditions the iOS agent offers a phone under (`parsePhysicalDevices`): without Developer Mode the
    // driver cannot be installed, and an untrusted phone refuses it — both would otherwise fail late, inside Maestro.
    const notReady = conn.transportType !== 'wired' || conn.tunnelState !== 'connected'
      ? 'is not plugged in over USB — connect it with a cable and unlock it'
      : conn.pairingState !== 'paired'
        ? 'does not trust this Mac — unlock it and tap Trust'
        : props.developerModeStatus !== 'enabled'
          ? 'is not in Developer Mode — Settings › Privacy & Security › Developer Mode'
          : undefined
    out.push({
      udid,
      ...(coreDeviceId ? { coreDeviceId } : {}),
      name: str(props.name) ?? udid,
      ready: notReady === undefined,
      ...(notReady ? { notReady } : {}),
    })
  }
  return out
}

/** Why `pickDevice` refused, in words for the person running the command. */
export class DeviceNotFound extends Error {}

/**
 * The device `id` names. Accepted: an adb serial or tapflow's `usb:<serial>`, an iPhone's hardware UDID, or its
 * CoreDevice identifier — translated to the hardware UDID, because Maestro's driver fails on the CoreDevice one.
 */
export function pickDevice(id: string, adbSerials: string[], ios: IosCandidate[]): MaestroDevice {
  const wanted = id.trim()
  const serial = wanted.startsWith('usb:') ? wanted.slice('usb:'.length) : wanted
  // tapflow knows an emulator as `avd:<name>`, not by its adb serial, so its busy check could not see one a session
  // holds — and the flows this runs are for phones people carry.
  if (/^emulator-\d+$/.test(serial)) {
    throw new DeviceNotFound(`${serial} is an emulator — tapflow maestro runs on physical phones only`)
  }
  if (serial && adbSerials.includes(serial)) {
    return { platform: 'android', serial, tapflowId: `usb:${serial}`, name: serial }
  }
  const upper = wanted.toUpperCase()
  const phone = ios.find((d) => d.udid.toUpperCase() === upper || d.coreDeviceId?.toUpperCase() === upper)
  if (phone) {
    if (!phone.ready) {
      throw new DeviceNotFound(`iPhone "${phone.name}" (${phone.udid}) ${phone.notReady ?? 'is not ready'}`)
    }
    return { platform: 'ios', udid: phone.udid, tapflowId: phone.udid, name: phone.name }
  }
  const ready = [
    ...adbSerials.filter((s) => !/^emulator-\d+$/.test(s)).map((s) => `  android  ${s}`),
    ...ios.filter((d) => d.ready).map((d) => `  ios      ${d.udid}  ${d.name}`),
  ]
  throw new DeviceNotFound(
    `no ready device with id "${id}"` + (ready.length > 0 ? `. Ready devices:\n${ready.join('\n')}` : ' (no Android phone or USB iPhone is ready)'),
  )
}
