import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { DevicectlWrapper, parsePhysicalDevices } from '../DevicectlWrapper.js'

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

  // A Mac without devicectl (no Xcode 15+) or one where it fails must still list its simulators: the caller merges
  // this list into the simulator one. Mutation: let the error through, and `agent:register` never goes out.
  it('lists no devices when devicectl fails', async () => {
    const exec = vi.fn().mockRejectedValue(new Error('xcrun: error: unable to find utility "devicectl"'))
    await expect(new DevicectlWrapper(exec).listPhysicalDevices()).resolves.toEqual([])
  })
})
