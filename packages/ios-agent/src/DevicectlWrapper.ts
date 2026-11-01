import { execFile } from 'child_process'
import { promisify } from 'util'
import { join } from 'path'
import { createLogger, PlatformError, type Device } from '@tapflowio/agent-core'
import type { LaunchOptions } from '@tapflowio/protocol'
import { hasLaunchOptions } from '@tapflowio/protocol/launch'
import { iosLaunchArgv } from './launchArgs.js'

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

// Copying a build onto a phone over USB takes as long as its size needs; a hung transfer still has to end.
const INSTALL_TIMEOUT_MS = 600_000

/** A plist as JSON, the way `plutil` converts it. */
export type PlistReader = (path: string) => Promise<unknown>

const defaultPlistReader: PlistReader = async (path) =>
  JSON.parse((await execFileAsync('plutil', ['-convert', 'json', '-o', '-', path], { timeout: 5_000 })).stdout)

/** What a built `.app` says about itself. `platform` is `unknown` when its Info.plist names neither. */
export interface AppBundleInfo {
  bundleId?: string
  platform: 'device' | 'simulator' | 'unknown'
}

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

/** An app installed on a device, as `devicectl device info apps` describes it. */
export interface InstalledApp {
  /** `CFBundleShortVersionString (CFBundleVersion)` as far as devicectl reports them. */
  version?: string
}

/** The app with `bundleId` in a `devicectl device info apps -j` document, or null when it is not there. */
export function parseInstalledApp(doc: unknown, bundleId: string): InstalledApp | null {
  const result = isObj(doc) ? doc.result : undefined
  const apps = isObj(result) && Array.isArray(result.apps) ? result.apps : []
  const app = apps.find((a): a is Obj => isObj(a) && a.bundleIdentifier === bundleId)
  if (!app) return null
  const short = str(app.version)
  const build = str(app.bundleVersion)
  const version = short && build ? `${short} (${build})` : short ?? build
  return version ? { version } : {}
}

/**
 * Whether a refused install was refused because the build cannot replace the copy already on the device: a build
 * signed for another App ID prefix or team than the installed one (a development or ad-hoc build over the App Store
 * or TestFlight copy, or the other way round). installd says so in the error devicectl passes on, as
 * `MismatchedApplicationIdentifierEntitlement` or in prose ("… does not match installed application's …; rejecting
 * upgrade"). Only this failure is cured by removing the installed copy first; anything else (a profile without the
 * device, an expired certificate, a locked phone) fails the same way again, after the tester's copy is gone.
 */
export function isIdentityMismatch(e: unknown): boolean {
  const text = [isObj(e) && typeof e.stderr === 'string' ? e.stderr : '', e instanceof Error ? e.message : String(e)].join('\n')
  return /MismatchedApplicationIdentifierEntitlement|does not match (the )?installed application|rejecting upgrade/i.test(text)
}

/** An install refused only because the installed copy is signed differently (see `isIdentityMismatch`). */
export class AppIdentityMismatchError extends PlatformError {}

/** An Info.plist (as JSON) read as `AppBundleInfo`: `iPhoneOS` in `CFBundleSupportedPlatforms` is a device build. */
export function parseAppBundleInfo(plist: unknown): AppBundleInfo {
  const p = isObj(plist) ? plist : {}
  const platforms = Array.isArray(p.CFBundleSupportedPlatforms) ? p.CFBundleSupportedPlatforms : []
  const sdk = str(p.DTPlatformName)
  const platform = platforms.includes('iPhoneOS') || sdk === 'iphoneos'
    ? 'device'
    : platforms.includes('iPhoneSimulator') || sdk === 'iphonesimulator' ? 'simulator' : 'unknown'
  const bundleId = str(p.CFBundleIdentifier)
  return bundleId ? { bundleId, platform } : { platform }
}

/** devicectl's own reason from a failed call: with `-q`, its stderr is an `ERROR:` line and indented detail. */
function devicectlFailure(what: string, e: unknown): PlatformError {
  const stderr = isObj(e) && typeof e.stderr === 'string' ? e.stderr : ''
  const line = stderr.split('\n').map((l) => l.trim()).find((l) => l.startsWith('ERROR:'))
  const reason = line ? line.slice('ERROR:'.length).trim() : (e instanceof Error ? e.message.split('\n')[0] : String(e))
  return new PlatformError(`${what}: ${reason}`)
}

export class DevicectlWrapper {
  constructor(
    private readonly exec: XcrunExec = defaultExec,
    private readonly readPlist: PlistReader = defaultPlistReader,
  ) {}

  /** The bundle id and platform of a built `.app` on this Mac. A bundle whose Info.plist cannot be read is `unknown`. */
  async appBundleInfo(appPath: string): Promise<AppBundleInfo> {
    try {
      return parseAppBundleInfo(await this.readPlist(join(appPath, 'Info.plist')))
    } catch (e) {
      logger.warn(`could not read ${appPath}/Info.plist: ${e instanceof Error ? e.message : String(e)}`)
      return { platform: 'unknown' }
    }
  }

  /** `bundleId` as installed on the device, or null. `--include-all-apps`: by default devicectl lists only apps a
   *  developer built, and one from TestFlight or the App Store would read as missing. */
  async installedApp(udid: string, bundleId: string): Promise<InstalledApp | null> {
    try {
      const out = await this.exec(['devicectl', 'device', 'info', 'apps', '--device', udid, '--bundle-id', bundleId, '--include-all-apps', '-j', '-', '-q'])
      return parseInstalledApp(JSON.parse(out), bundleId)
    } catch (e) {
      throw devicectlFailure(`could not list the apps on ${udid}`, e)
    }
  }

  /** Installs a device-signed `.app` on the device, over the installed copy of the same app (its data is kept). Rejects
   *  with `AppIdentityMismatchError` when that copy is signed so differently that it has to be removed first. */
  async installApp(udid: string, appPath: string): Promise<void> {
    try {
      await this.exec(['devicectl', 'device', 'install', 'app', '--device', udid, appPath, '-q'], INSTALL_TIMEOUT_MS)
    } catch (e) {
      const failure = devicectlFailure('install failed', e)
      throw isIdentityMismatch(e) ? new AppIdentityMismatchError(failure.message) : failure
    }
  }

  async uninstallApp(udid: string, bundleId: string): Promise<void> {
    try {
      await this.exec(['devicectl', 'device', 'uninstall', 'app', '--device', udid, bundleId, '-q'])
    } catch (e) {
      throw devicectlFailure(`uninstall of ${bundleId} failed`, e)
    }
  }

  /**
   * Launches an installed app in the foreground. As `simctl launch` does, a launch that carries options ends a
   * running instance first, since arguments and environment are read only when the process starts. `--` ends
   * devicectl's own options: the app's arguments start with `-`, which it would otherwise take for its own.
   */
  async launchApp(udid: string, bundleId: string, options?: LaunchOptions): Promise<void> {
    const withOptions = hasLaunchOptions(options)
    const env = options?.env && Object.keys(options.env).length > 0 ? ['--environment-variables', JSON.stringify(options.env)] : []
    try {
      await this.exec([
        'devicectl', 'device', 'process', 'launch', '--device', udid, '-q',
        ...(withOptions ? ['--terminate-existing'] : []), ...env,
        '--', bundleId, ...iosLaunchArgv(options?.arguments),
      ])
    } catch (e) {
      throw devicectlFailure(`could not launch ${bundleId}`, e)
    }
  }

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
