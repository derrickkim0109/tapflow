import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { DevicectlWrapper, AppIdentityMismatchError, isIdentityMismatch, parsePhysicalDevices, parseInstalledApp, parseAppBundleInfo } from '../DevicectlWrapper.js'

// Captured from `xcrun devicectl list devices -j -` (devicectl 506.7, Xcode 26.3) with five paired devices, names and
// identifiers replaced and the fields nothing reads trimmed. Only iPhone A is usable: B is paired over the network,
// C is out of reach, D is plugged in with Developer Mode off, and E is a watch.
const FIXTURE = JSON.parse(readFileSync(join(import.meta.dirname, '..', '__fixtures__', 'devicectl-list-devices.json'), 'utf8'))
type Doc = { result: { devices: Array<Record<string, Record<string, unknown>>> } }
const withDevice = (patch: (d: Record<string, Record<string, unknown>>) => void): Doc => {
  const doc = structuredClone(FIXTURE) as Doc
  patch(doc.result.devices[0])
  return doc
}

describe('parsePhysicalDevices', () => {
  it('offers only the iPhone that is plugged in, trusted and in Developer Mode', () => {
    expect(parsePhysicalDevices(FIXTURE)).toEqual([{
      id: '00008140-0000000000000001',
      name: 'iPhone A',
      platform: 'ios',
      status: 'booted',
      osVersion: 'iOS 26.5.2',
      formFactor: 'phone',
      kind: 'physical',
    }])
  })

  // The hardware UDID, not devicectl's CoreDevice identifier: xcodebuild's `-destination id=` and the screen capture
  // device both know the device by the UDID. Mutation: `id: d.identifier`.
  it('identifies a device by its hardware UDID', () => {
    expect(parsePhysicalDevices(FIXTURE)[0].id).toBe('00008140-0000000000000001')
  })

  // A device paired over Wi-Fi shows up `connected` too while it is nearby; the screen can only be captured over USB.
  // Mutation: drop the transport check, and iPhone B appears once its tunnel is up.
  it('leaves out a device reachable only over the network', () => {
    const doc = withDevice((d) => { d.connectionProperties.transportType = 'localNetwork' })
    expect(parsePhysicalDevices(doc).map((d) => d.name)).toEqual([])
  })

  it('leaves out a device whose tunnel is not up', () => {
    const doc = withDevice((d) => { d.connectionProperties.tunnelState = 'disconnected' })
    expect(parsePhysicalDevices(doc)).toEqual([])
  })

  // Without Developer Mode nothing can be installed or tested on it. Mutation: drop the check, and iPhone D appears.
  it('leaves out a device with Developer Mode off', () => {
    expect(parsePhysicalDevices(FIXTURE).map((d) => d.name)).not.toContain('iPhone D')
  })

  it('reads an iPad as a tablet', () => {
    const doc = withDevice((d) => { d.hardwareProperties.deviceType = 'iPad' })
    expect(parsePhysicalDevices(doc)[0].formFactor).toBe('tablet')
  })

  // A watch or a TV that devicectl lists is not something an iOS session can drive.
  it('leaves out devices that are not an iPhone or an iPad', () => {
    const doc = withDevice((d) => { d.hardwareProperties.deviceType = 'appleTV'; d.hardwareProperties.platform = 'tvOS' })
    expect(parsePhysicalDevices(doc)).toEqual([])
  })

  it('returns no devices for a document it does not recognise', () => {
    expect(parsePhysicalDevices(null)).toEqual([])
    expect(parsePhysicalDevices({ info: { outcome: 'failed' } })).toEqual([])
  })
})

describe('DevicectlWrapper.listPhysicalDevices', () => {
  it('asks devicectl for JSON on stdout and parses it', async () => {
    const exec = vi.fn().mockResolvedValue(JSON.stringify(FIXTURE))
    const devices = await new DevicectlWrapper(exec).listPhysicalDevices()
    expect(exec).toHaveBeenCalledWith(['devicectl', 'list', 'devices', '-j', '-', '-q'])
    expect(devices.map((d) => d.name)).toEqual(['iPhone A'])
  })

  // Mutation: drop the timeout on its way to exec. A boot would then wait out devicectl's 15 s default on a hung
  // CoreDevice daemon, simulators included.
  it('hands a caller\'s timeout to devicectl, and still never rejects', async () => {
    const exec = vi.fn().mockRejectedValue(new Error('Command failed: timed out'))
    await expect(new DevicectlWrapper(exec).listPhysicalDevices(3_000)).resolves.toEqual([])
    expect(exec).toHaveBeenCalledWith(['devicectl', 'list', 'devices', '-j', '-', '-q'], 3_000)
  })

  // A Mac without devicectl (no Xcode 15+) or one where it fails must still list its simulators: the caller merges
  // this list into the simulator one. Mutation: let the error through, and `agent:register` never goes out.
  it('lists no devices when devicectl fails', async () => {
    const exec = vi.fn().mockRejectedValue(new Error('xcrun: error: unable to find utility "devicectl"'))
    await expect(new DevicectlWrapper(exec).listPhysicalDevices()).resolves.toEqual([])
  })

  // Every boot and register lists devices, so a Mac without devicectl would warn on each one.
  // Mutation: drop the `listFailureWarned` check — the second failure warns again.
  it('warns about a failing devicectl once, not on every list', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const exec = vi.fn().mockRejectedValue(new Error('xcrun: error: unable to find utility "devicectl"'))
      const wrapper = new DevicectlWrapper(exec)
      await wrapper.listPhysicalDevices()
      await wrapper.listPhysicalDevices()
      await wrapper.listPhysicalDevices()
      expect(warn.mock.calls.filter((c) => c.some((a) => String(a).includes('physical devices unavailable')))).toHaveLength(1)
    } finally {
      warn.mockRestore()
    }
  })

  // The 30 s re-read must tell "devicectl failed" from "no phones": the second, twice in a row, drops every phone.
  // Mutation: swallow the error under `rejectOnFailure` too.
  it('rejects when asked to, so a re-read can tell a failure from no phones', async () => {
    const exec = vi.fn().mockRejectedValue(new Error('Command failed: timed out'))
    await expect(new DevicectlWrapper(exec).listPhysicalDevices(3_000, { rejectOnFailure: true })).rejects.toThrow('timed out')
  })
})

// Captured from `xcrun devicectl device info apps --device <udid> --bundle-id <id> --include-all-apps -j - -q`
// (devicectl 506.7, Xcode 26.3) on an iPhone, identifiers and names replaced.
const APPS = JSON.parse(readFileSync(join(import.meta.dirname, '..', '__fixtures__', 'devicectl-info-apps.json'), 'utf8'))
const UDID = '00008140-0000000000000001'
// What execFile rejects with when devicectl exits non-zero under `-q`: its stderr is the ERROR line and detail.
const devicectlError = (line: string) => Object.assign(new Error(`Command failed: xcrun devicectl ...\n${line}`), {
  stderr: `ERROR: ${line} (com.apple.dt.CoreDeviceError error 1000 (0x3E8))\n       DeviceName = ${UDID}\n`,
})

describe('parseInstalledApp', () => {
  // Mutation: drop the version. The warning for a simulator build could then not say which build is being tested.
  it('finds the app by bundle identifier, with its version and build', () => {
    expect(parseInstalledApp(APPS, 'com.example.app')).toEqual({ version: '3.0.3 (4)' })
  })

  // devicectl answers success with an empty `apps` for a bundle id that is not installed (measured).
  it('reads an empty list, or another app, as not installed', () => {
    expect(parseInstalledApp({ ...APPS, result: { ...APPS.result, apps: [] } }, 'com.example.app')).toBeNull()
    expect(parseInstalledApp(APPS, 'com.example.other')).toBeNull()
    expect(parseInstalledApp(null, 'com.example.app')).toBeNull()
  })
})

describe('parseAppBundleInfo', () => {
  // Mutation: read the platform from the bundle id or the path. Only Info.plist says what a build was built for.
  it('tells a device build from a simulator build by its supported platforms', () => {
    expect(parseAppBundleInfo({ CFBundleIdentifier: 'com.example.app', CFBundleSupportedPlatforms: ['iPhoneOS'] }))
      .toEqual({ bundleId: 'com.example.app', platform: 'device' })
    expect(parseAppBundleInfo({ CFBundleIdentifier: 'com.example.app', CFBundleSupportedPlatforms: ['iPhoneSimulator'] }))
      .toEqual({ bundleId: 'com.example.app', platform: 'simulator' })
  })

  it('falls back to the SDK name, and says unknown when neither is there', () => {
    expect(parseAppBundleInfo({ DTPlatformName: 'iphoneos' }).platform).toBe('device')
    expect(parseAppBundleInfo({ DTPlatformName: 'iphonesimulator' }).platform).toBe('simulator')
    expect(parseAppBundleInfo({})).toEqual({ platform: 'unknown' })
  })
})

describe('DevicectlWrapper apps', () => {
  // Mutation: drop `--include-all-apps`. devicectl then lists only apps a developer built, and one from TestFlight or
  // the App Store reads as not installed (measured: Safari is missing without the flag and present with it).
  it('asks for every app with that bundle id', async () => {
    const exec = vi.fn().mockResolvedValue(JSON.stringify(APPS))
    await expect(new DevicectlWrapper(exec).installedApp(UDID, 'com.example.app')).resolves.toEqual({ version: '3.0.3 (4)' })
    expect(exec).toHaveBeenCalledWith(['devicectl', 'device', 'info', 'apps', '--device', UDID, '--bundle-id', 'com.example.app', '--include-all-apps', '-j', '-', '-q'])
  })

  // Mutation: answer false on a failure. A phone that is locked or unplugged would then be told to install an app it has.
  it('rejects with devicectl\'s own reason when it cannot list the apps', async () => {
    const exec = vi.fn().mockRejectedValue(devicectlError('The specified device was not found.'))
    await expect(new DevicectlWrapper(exec).installedApp(UDID, 'com.example.app')).rejects.toThrow(
      `could not list the apps on ${UDID}: The specified device was not found. (com.apple.dt.CoreDeviceError error 1000 (0x3E8))`,
    )
  })

  // Mutation: install with the default 15 s timeout. A build of a few hundred MB over USB outlasts it.
  it('installs an app with a timeout an install can meet, and uninstalls by bundle id', async () => {
    const exec = vi.fn().mockResolvedValue('')
    const devicectl = new DevicectlWrapper(exec)
    await devicectl.installApp(UDID, '/tmp/x/Payload/Example.app')
    await devicectl.uninstallApp(UDID, 'com.example.app')
    expect(exec.mock.calls).toEqual([
      [['devicectl', 'device', 'install', 'app', '--device', UDID, '/tmp/x/Payload/Example.app', '-q'], 600_000],
      [['devicectl', 'device', 'uninstall', 'app', '--device', UDID, 'com.example.app', '-q']],
    ])
  })

  it('names the failure with devicectl\'s reason when an install is refused', async () => {
    const exec = vi.fn().mockRejectedValue(devicectlError('Unable to install "Example".'))
    const install = new DevicectlWrapper(exec).installApp(UDID, '/tmp/Example.app')
    await expect(install).rejects.toThrow(/^install failed: Unable to install "Example"\./)
    await expect(install).rejects.not.toBeInstanceOf(AppIdentityMismatchError)
  })

  // Mutation: call every refused install a mismatch, or none. Every failure would then remove the tester's copy
  // before failing again — or a build signed for another team could never replace the TestFlight one.
  it('tells an install refused only because the installed copy is signed differently', async () => {
    const mismatch = {
      ...devicectlError('Unable to install "Example".'),
      stderr: 'ERROR: Unable to install "Example". (com.apple.dt.CoreDeviceError error 3002 (0xBBA))\n'
        + '       NSUnderlyingError = Error Domain=MIInstallerErrorDomain Code=13 "Failed to verify code signature" '
        + 'UserInfo={LegacyErrorString=MismatchedApplicationIdentifierEntitlement}\n',
    }
    await expect(new DevicectlWrapper(vi.fn().mockRejectedValue(mismatch)).installApp(UDID, '/tmp/Example.app'))
      .rejects.toBeInstanceOf(AppIdentityMismatchError)
    expect(isIdentityMismatch(new Error("Upgrade's application-identifier entitlement string (A.com.example.app) does not match installed application's application-identifier string (B.com.example.app); rejecting upgrade."))).toBe(true)
    expect(isIdentityMismatch(new Error('A valid provisioning profile for this executable was not found.'))).toBe(false)
  })

  // Mutation: read Info.plist from somewhere else, or let a read failure through. An unreadable bundle is `unknown`,
  // which the caller treats with care rather than failing the install outright.
  it('reads a bundle\'s Info.plist, and calls an unreadable one unknown', async () => {
    const readPlist = vi.fn().mockResolvedValueOnce({ CFBundleIdentifier: 'com.example.app', CFBundleSupportedPlatforms: ['iPhoneOS'] })
      .mockRejectedValueOnce(new Error('plutil: file does not exist'))
    const devicectl = new DevicectlWrapper(vi.fn(), readPlist)
    await expect(devicectl.appBundleInfo('/tmp/Example.app')).resolves.toEqual({ bundleId: 'com.example.app', platform: 'device' })
    expect(readPlist).toHaveBeenCalledWith('/tmp/Example.app/Info.plist')
    await expect(devicectl.appBundleInfo('/tmp/Gone.app')).resolves.toEqual({ platform: 'unknown' })
  })
})

describe('DevicectlWrapper.launchApp', () => {
  // Mutation: always pass --terminate-existing. A plain launch of an app already open would restart it and lose the
  // screen the tester was on; simctl leaves it running too.
  it('launches a bare app without ending a running instance', async () => {
    const exec = vi.fn().mockResolvedValue('')
    await new DevicectlWrapper(exec).launchApp(UDID, 'com.example.app')
    expect(exec).toHaveBeenCalledWith(['devicectl', 'device', 'process', 'launch', '--device', UDID, '-q', '--', 'com.example.app'])
  })

  // Mutations: drop the `--` (devicectl rejects `-Mode` as `Unknown option '-M'`, measured), drop the restart (the
  // options are read only at process start), or pass env through DEVICECTL_CHILD_ (any -e would override it).
  it('passes arguments after the bundle id and env as JSON, restarting the app', async () => {
    const exec = vi.fn().mockResolvedValue('')
    await new DevicectlWrapper(exec).launchApp(UDID, 'com.example.app', { arguments: { Mode: 'qa' }, env: { API_URL: 'https://x' } })
    expect(exec).toHaveBeenCalledWith([
      'devicectl', 'device', 'process', 'launch', '--device', UDID, '-q',
      '--terminate-existing', '--environment-variables', '{"API_URL":"https://x"}',
      '--', 'com.example.app', '-Mode', '"qa"',
    ])
  })

  it('names the failure with devicectl\'s reason', async () => {
    const exec = vi.fn().mockRejectedValue(devicectlError('The application could not be launched.'))
    await expect(new DevicectlWrapper(exec).launchApp(UDID, 'com.example.app')).rejects.toThrow(/^could not launch com\.example\.app: The application could not be launched\./)
  })
})
