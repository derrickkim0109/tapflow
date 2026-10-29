import { describe, it, expect, vi } from 'vitest'
import type { ChromeData } from '@tapflowio/protocol'
import { TypePanels, panelFrame } from '../TypePanels.js'
import type { TypePanel } from '../panels.js'

const COVER: TypePanel = { deviceName: 'primary', chromeId: 'phone15', width: 1398, height: 2034, scale: 3, nativeOrientation: 0 }
const OPEN: TypePanel = { deviceName: 'primary-1', chromeId: 'phone14', width: 2007, height: 2853, scale: 3, nativeOrientation: 270 }
const COMPOSITE: Record<string, [number, number]> = { phone15: [1000, 1450], phone14: [2000, 1420] }

function setup(panels: () => Promise<TypePanel[]>) {
  const simctl = { typePanels: vi.fn(panels) }
  const chromeLoader = {
    load: vi.fn(async (_type: string, panel?: { chromeId: string }) => {
      const size = panel && COMPOSITE[panel.chromeId]
      return size ? ({ compositeWidth: size[0], compositeHeight: size[1] } as ChromeData) : null
    }),
  }
  return { simctl, chromeLoader, types: new TypePanels(simctl, chromeLoader) }
}

describe('panelFrame', () => {
  it('is the panel\'s chrome at its size in points', () => {
    expect(panelFrame(COVER)).toEqual({ chromeId: 'phone15', width: 466, height: 678 })
    expect(panelFrame({ ...COVER, chromeId: null })).toBeUndefined()
  })
})

describe('TypePanels', () => {
  // Mutations: the lit panel's own size; the height alone (the unfolded frame is drawn turned, so wide).
  it('scales by the longest side of the largest panel\'s frame', async () => {
    const { types } = setup(async () => [COVER, OPEN])
    await expect(types.scaleBasis('duo')).resolves.toBe(2000)
  })

  it('reads a type once', async () => {
    const { types, simctl, chromeLoader } = setup(async () => [COVER, OPEN])
    await types.scaleBasis('duo')
    await types.scaleBasis('duo')
    await types.load('duo')
    expect(simctl.typePanels).toHaveBeenCalledTimes(1)
    expect(chromeLoader.load).toHaveBeenCalledTimes(2)
  })

  // Mutation: keep a failure (a type whose plist was briefly unreadable would never get a scale).
  it('asks again after a read that failed', async () => {
    let fail = true
    const { types } = setup(async () => { if (fail) throw new Error('simctl wedged'); return [COVER, OPEN] })
    await expect(types.scaleBasis('duo')).resolves.toBeUndefined()
    fail = false
    await expect(types.scaleBasis('duo')).resolves.toBe(2000)
  })

  it('has no scale for a single panel, or a panel whose frame does not load', async () => {
    await expect(setup(async () => [COVER]).types.scaleBasis('pro')).resolves.toBeUndefined()
    await expect(setup(async () => [COVER, { ...OPEN, chromeId: 'missing' }]).types.scaleBasis('duo')).resolves.toBeUndefined()
  })

  // Mutation: read every panel as upright.
  it('knows each panel\'s native turn once the type has loaded, and 0 before', async () => {
    const { types } = setup(async () => [COVER, OPEN])
    expect(types.nativeOrientation('duo', 'primary-1')).toBe(0)
    await types.load('duo')
    expect(types.nativeOrientation('duo', 'primary-1')).toBe(270)
    expect(types.nativeOrientation('duo', 'primary')).toBe(0)
  })
})
