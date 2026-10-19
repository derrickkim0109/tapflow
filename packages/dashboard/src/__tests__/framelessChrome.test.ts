import { describe, it, expect } from 'vitest'
import { framelessChrome, isFramelessChrome } from '@/lib/framelessChrome'

describe('framelessChrome', () => {
  // A plain-HTTP LAN stream arrives scaled down; taken as-is, the viewer shrank to about two-thirds.
  it('is the same height whatever size the stream arrives at', () => {
    expect(framelessChrome({ width: 448, height: 992 }).compositeHeight).toBe(framelessChrome({ width: 1206, height: 2622 }).compositeHeight)
  })

  it('keeps the stream\'s shape', () => {
    const c = framelessChrome({ width: 1206, height: 2622 })
    expect(c.compositeWidth / c.compositeHeight).toBeCloseTo(1206 / 2622, 2)
    expect(c.screenRect).toEqual({ x: 0, y: 0, width: c.compositeWidth, height: c.compositeHeight })
  })

  // The viewer's effects follow the chrome's identity; a new object per render would rebuild them each time.
  it('is one object per shape', () => {
    expect(framelessChrome({ width: 603, height: 1311 })).toBe(framelessChrome({ width: 1206, height: 2622 }))
  })

  it('rounds an iPad\'s corners far less than a phone\'s', () => {
    const phone = framelessChrome({ width: 1206, height: 2622 })
    const pad = framelessChrome({ width: 1640, height: 2360 })
    expect(pad.screenCornerRadius / pad.compositeWidth).toBeLessThan(phone.screenCornerRadius / phone.compositeWidth / 2)
  })

  it('is told apart from a chrome the agent sent', () => {
    expect(isFramelessChrome(framelessChrome({ width: 1, height: 2 }))).toBe(true)
    expect(isFramelessChrome({ ...framelessChrome({ width: 1, height: 2 }) })).toBe(false)
  })
})
