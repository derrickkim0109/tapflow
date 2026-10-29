import { execFile } from 'child_process'
import { join } from 'path'
import { promisify } from 'util'
import { createLogger } from '@tapflowio/agent-core'
import type { Rotation } from './PanelState.js'

const logger = createLogger('ios-agent:physical-orientation')
const execFileAsync = promisify(execFile)

// One `devicectl device orientation get` measured ~0.18 s on the Mac mini (Xcode 27.1).
const DEVICECTL_TIMEOUT_MS = 10_000
// One `guest-helper --orientation` through `simctl spawn` measured 0.33–0.42 s, 1.6 s right after a boot (Xcode 26.6).
const GUEST_READ_TIMEOUT_MS = 10_000
// The same binary `GuestHelper` spawns; not imported from it, which would make this module start the helper's.
const GUEST_HELPER_BINARY = join(import.meta.dirname, '..', 'bin', 'guest-helper')
const AWAIT_INTERVAL_MS = 300

/** A device's physical orientation, in devicectl's (UIDeviceOrientation's) names. */
export type DeviceOrientation = 'portrait' | 'landscapeRight' | 'portraitUpsideDown' | 'landscapeLeft'

/**
 * How far each orientation turns the device clockwise as DeviceHub draws it. Measured on the iPhone Duo's
 * cover with Safari up: one clockwise turn from portrait reads `landscapeRight`, and that is the panel
 * DeviceHub shows on its right side.
 */
export const ORIENTATION_DEGREES: Record<DeviceOrientation, Rotation> = {
  portrait: 0, landscapeRight: 90, portraitUpsideDown: 180, landscapeLeft: 270,
}

const ORDER: DeviceOrientation[] = ['portrait', 'landscapeRight', 'portraitUpsideDown', 'landscapeLeft']

/** The orientation a quarter turn away. */
export function turned(from: DeviceOrientation, direction: 'clockwise' | 'counterclockwise'): DeviceOrientation {
  return ORDER[(ORDER.indexOf(from) + (direction === 'clockwise' ? 1 : 3)) % 4]
}

export interface PhysicalOrientationNative {
  /** The parsed JSON of `devicectl device orientation get` for this device. */
  readOrientation(udid: string): Promise<unknown>
}

/** Whether this host's devicectl sees simulators — Xcode 27 and later. Asked once per process; **a failed check
 *  is not an answer and is asked again** — kept as "no", an Xcode 27 host would read the guest's value, which does
 *  not follow DeviceHub, until the agent restarted. The read fails instead, and the caller keeps the last one. */
let devicectlSeesSimulators: Promise<boolean> | null = null
function hostDevicectlSeesSimulators(): Promise<boolean> {
  devicectlSeesSimulators ??= execFileAsync('xcodebuild', ['-version'], { timeout: 30_000 }).then(
    ({ stdout }) => Number(/Xcode (\d+)/.exec(stdout)?.[1] ?? 0) >= 27,
    (e: unknown) => { devicectlSeesSimulators = null; throw e },
  )
  return devicectlSeesSimulators
}

/**
 * Two sources, chosen by the host rather than tried in turn. **Xcode 27**: `devicectl device orientation get`,
 * public. **Older**: devicectl does not see simulators, so the guest helper asks backboardd (`guest-helper
 * --orientation`, the one file private API lives in). Not a fallback for a failed devicectl read on Xcode 27: on
 * iOS 27.1 backboardd's value did not follow a turn made in DeviceHub (measured on the Duo), so it would answer
 * portrait for a device that is not — a failed read is no answer, and the caller keeps the last one.
 */
export const defaultPhysicalOrientationNative: PhysicalOrientationNative = {
  async readOrientation(udid) {
    if (await hostDevicectlSeesSimulators()) {
      // `-j -` puts the JSON on stdout and everything human-readable on stderr.
      const { stdout } = await execFileAsync('xcrun', ['devicectl', 'device', 'orientation', 'get', '--device', udid, '-j', '-'],
        { timeout: DEVICECTL_TIMEOUT_MS })
      return JSON.parse(stdout)
    }
    const { stdout } = await execFileAsync('xcrun', ['simctl', 'spawn', udid, GUEST_HELPER_BINARY, '--orientation'], { timeout: GUEST_READ_TIMEOUT_MS })
    const name = /^orientation (\w+)$/m.exec(stdout)?.[1]
    if (!name) throw new Error(`guest-helper --orientation said: ${stdout.trim().slice(0, 200)}`)
    // The shape devicectl answers in, so one parser reads both.
    return { result: { deviceOrientation: name } }
  },
}

const KNOWN = new Set<string>(ORDER)

/**
 * The device's physical orientation in a devicectl document, or null if it is not one. Lying flat
 * (`faceUp`/`faceDown`) reads as the last orientation it stood in (`deviceOrientationNonFlat`), which is how
 * a phone on a table keeps its screen. `unknown` is what a device reports until anything has turned it
 * (measured on a fresh iPhone 18 Pro); it boots upright and is drawn upright, so it reads as portrait.
 */
export function parseOrientation(doc: unknown): DeviceOrientation | null {
  const result = (doc as { result?: Record<string, unknown> } | null)?.result
  if (!result) return null
  for (const key of ['deviceOrientation', 'deviceOrientationNonFlat']) {
    const value = String(result[key])
    if (KNOWN.has(value)) return value as DeviceOrientation
  }
  return result.deviceOrientationNonFlat === 'unknown' || result.deviceOrientation === 'unknown' ? 'portrait' : null
}

interface Flight {
  current: Promise<DeviceOrientation | null>
  next: Promise<DeviceOrientation | null> | null
}

/**
 * Which way the device is held — what DeviceHub turns its whole frame by. **Not the interface orientation**:
 * `devicectl device info displays` follows what the app on screen shows, so a home screen (which never
 * turns on an iPhone) left it at portrait while DeviceHub turned the device four times. This is the
 * orientation the device keeps for whatever app comes up next, and it is what DeviceHub, tapflow's helper,
 * Purple and `devicectl orientation set` all write — measured for each.
 *
 * Same read discipline as `PanelState` (a read during a call gets the next call, never joins it), keyed by
 * udid outside `DeviceState` so a relay reconnect keeps it.
 */
export class PhysicalOrientation {
  private readonly flights = new Map<string, Flight>()
  private readonly known = new Map<string, DeviceOrientation>()
  // Bumped by `forget`, for the reason `PanelState` gives.
  private readonly generations = new Map<string, number>()

  constructor(private readonly native: PhysicalOrientationNative = defaultPhysicalOrientationNative) {}

  /** A fresh reading, or null when the call fails (`last()` keeps the previous answer). */
  read(udid: string): Promise<DeviceOrientation | null> {
    const flight = this.flights.get(udid)
    if (!flight) return this.startFlight(udid)
    if (!flight.next) {
      flight.next = flight.current.then(() => {
        const f = this.flights.get(udid)
        if (f) f.next = null
        return this.startFlight(udid)
      })
    }
    return flight.next
  }

  last(udid: string): DeviceOrientation | null {
    return this.known.get(udid) ?? null
  }

  /** What tapflow turned the device to, for when it cannot be read back at all — neither source answered (the
   *  guest helper is arm64-only, so an Intel Mac): the memory a single-panel device turns from there. */
  note(udid: string, orientation: DeviceOrientation): void {
    this.known.set(udid, orientation)
  }

  forget(udid: string): void {
    this.known.delete(udid)
    this.generations.set(udid, (this.generations.get(udid) ?? 0) + 1)
  }

  /** Reads until `done` holds, or `timeoutMs` passes (then null). */
  async await(udid: string, done: (o: DeviceOrientation) => boolean, timeoutMs: number): Promise<DeviceOrientation | null> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const reading = await this.read(udid)
      if (reading && done(reading)) return reading
      if (Date.now() + AWAIT_INTERVAL_MS > deadline) return null
      await new Promise((r) => setTimeout(r, AWAIT_INTERVAL_MS))
    }
  }

  private startFlight(udid: string): Promise<DeviceOrientation | null> {
    const generation = this.generations.get(udid) ?? 0
    const current = this.native.readOrientation(udid).then(
      (doc) => {
        if ((this.generations.get(udid) ?? 0) !== generation) return null
        const reading = parseOrientation(doc)
        if (reading) this.known.set(udid, reading)
        else logger.warn(`devicectl gave ${udid} an orientation this agent does not recognise: ${JSON.stringify(doc).slice(0, 400)}`)
        return reading
      },
      (e: unknown) => {
        logger.warn(`devicectl orientation failed for ${udid}: ${e instanceof Error ? e.message : String(e)}`)
        return null
      },
    )
    const flight: Flight = { current, next: null }
    this.flights.set(udid, flight)
    void current.then(() => { if (this.flights.get(udid) === flight && !flight.next) this.flights.delete(udid) })
    return current
  }
}
