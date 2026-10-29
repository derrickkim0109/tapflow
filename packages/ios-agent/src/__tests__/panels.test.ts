import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { parseIntegratedScreens, countIntegratedPanels, typePanels } from '../panels.js'

const FIXTURES = join(import.meta.dirname, '..', '__fixtures__')
// `xcrun simctl io <udid> enumerate` on a booted iPhone Duo, Xcode 27.1 / iOS 27.1.
const ENUMERATE_DUO = readFileSync(join(FIXTURES, 'simctl-io-enumerate-duo.txt'), 'utf8')
// The `displays` of each device type's capabilities.plist, Xcode 27.1, converted with `plutil -convert json`.
const CAPABILITIES = JSON.parse(readFileSync(join(FIXTURES, 'capabilities-displays-xcode27.1.json'), 'utf8')) as Record<string, unknown>

describe('parseIntegratedScreens', () => {
  it('reads the Duo\'s two panels and nothing else', () => {
    expect(parseIntegratedScreens(ENUMERATE_DUO)).toEqual([
      { screenId: 1, uuid: '5910A758-D61E-4E25-A4D8-E9649B8933F2', deviceName: 'primary', width: 1398, height: 2034, scale: 3, chromeId: 'com.apple.dt.devicekit.chrome.phone15' },
      { screenId: 3, uuid: '65DE8371-8130-4B94-A099-135B1D917178', deviceName: 'primary-1', width: 2007, height: 2853, scale: 3, chromeId: 'com.apple.dt.devicekit.chrome.phone14' },
    ])
  })

  it('leaves out a screen whose block is missing a field rather than guessing it', () => {
    const broken = ENUMERATE_DUO.replace('Unique ID: 65DE8371-8130-4B94-A099-135B1D917178', '')
    expect(parseIntegratedScreens(broken).map((s) => s.screenId)).toEqual([1])
  })

  it('finds nothing in output with no connected screens', () => {
    expect(parseIntegratedScreens('Port:\n    UUID: X\n    Class: Display\n')).toEqual([])
  })
})

describe('countIntegratedPanels', () => {
  it('counts two for the Duo and one for a single-panel phone', () => {
    expect(countIntegratedPanels(CAPABILITIES['com.apple.CoreSimulator.SimDeviceType.iPhone-Duo'])).toBe(2)
    expect(countIntegratedPanels(CAPABILITIES['com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro'])).toBe(1)
  })

  it('reads a capabilities plist with no displays (Xcode 26) as one panel', () => {
    expect(countIntegratedPanels({ capabilities: { accelerometer: true } })).toBe(1)
    expect(countIntegratedPanels(null)).toBe(1)
  })
})

describe('typePanels', () => {
  // Mutations: read every panel as upright (the Duo's unfolded panel would be drawn a quarter off); drop the
  // frame or the size (the viewer's scale for the Duo comes from both panels' frames, before it boots).
  it('reads each Duo panel\'s frame, size and native turn from the device type', () => {
    expect(typePanels(CAPABILITIES['com.apple.CoreSimulator.SimDeviceType.iPhone-Duo'])).toEqual([
      { deviceName: 'primary', chromeId: 'com.apple.dt.devicekit.chrome.phone15', width: 1398, height: 2034, scale: 3, nativeOrientation: 0 },
      { deviceName: 'primary-1', chromeId: 'com.apple.dt.devicekit.chrome.phone14', width: 2007, height: 2853, scale: 3, nativeOrientation: 270 },
    ])
    expect(typePanels(CAPABILITIES['com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro']).map((p) => p.nativeOrientation)).toEqual([0])
  })

  it('lists none for a type that states no displays (Xcode 26)', () => {
    expect(typePanels({ capabilities: {} })).toEqual([])
    expect(typePanels(null)).toEqual([])
  })
})
