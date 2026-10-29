import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, act } from '@testing-library/react'
import type { Decoder } from '@/lib/decoders/types'

/**
 * The H.264 surface is mirrored into `canvasRef`, the canvas recording and screenshots read. It was drawn on every
 * animation frame whether or not a new picture had arrived — a full-resolution copy up to 120 times a second on a
 * ProMotion display for a 30 fps stream — and is now drawn once per presented frame.
 */

type Size = { width: number; height: number }
const captured: { onDecoderReady?: (d: Decoder) => void | (() => void); onResize?: (s: Size) => void } = {}
vi.mock('@/hooks/useDecoderStream', () => ({
  useDecoderStream: (opts: typeof captured) => { Object.assign(captured, opts) },
}))

import { useIOSScreen } from '@/hooks/useIOSScreen'
import { iosTurn } from '@/lib/coordinate-transform'
import { IOSDeviceScreen } from '@/components/device/IOSDeviceScreen'

const chrome = {
  framePng: '', bezelWidth: 600, bezelHeight: 1200,
  compositeWidth: 640, compositeHeight: 1240,
  padding: { left: 20, right: 20, top: 20, bottom: 20 },
  screenRect: { x: 40, y: 40, width: 560, height: 1160 },
  screenCornerRadius: 40, logicalWidth: 390, logicalHeight: 844, buttons: [],
} as unknown as React.ComponentProps<typeof IOSDeviceScreen>['chrome']

function Harness() {
  const screen = useIOSScreen({ chrome, binaryFrameHandlerRef: { current: undefined }, fps: 0, frameCount: { current: 0 } })
  return <IOSDeviceScreen screen={screen} chrome={chrome} turn={iosTurn(undefined, false)} joined fps={0} />
}

// Animation frames advance only when a test says so.
let frames: Map<number, FrameRequestCallback>
let nextId: number
const tick = (n = 1) => { for (let i = 0; i < n; i++) { const due = [...frames.values()]; frames.clear(); due.forEach((cb) => cb(0)) } }
const drawImage = vi.fn()

beforeEach(() => {
  frames = new Map(); nextId = 1; drawImage.mockClear()
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { frames.set(nextId, cb); return nextId++ })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id) })
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage } as unknown as CanvasRenderingContext2D)
})
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

function decoder(withPresented: boolean) {
  const listeners = new Set<() => void>()
  const d = {
    surface: document.createElement('canvas'),
    size: { width: 1206, height: 2622 },
    decode() {}, close() {}, onResize() {},
    ...(withPresented ? { onPresented: (cb: () => void) => { listeners.add(cb); return () => { listeners.delete(cb) } } } : {}),
  } as unknown as Decoder
  return { d, present: () => listeners.forEach((cb) => cb()), listeners }
}

function mount(withPresented: boolean) {
  const view = render(<Harness />)
  const dec = decoder(withPresented)
  let cleanup: void | (() => void)
  act(() => {
    captured.onResize?.({ width: 1206, height: 2622 })
    cleanup = captured.onDecoderReady?.(dec.d)
  })
  return { ...dec, view, cleanup: () => { if (typeof cleanup === 'function') cleanup() } }
}

describe('useIOSScreen — the recording/screenshot mirror', () => {
  it('draws nothing while no new frame arrives, however many animation frames pass', () => {
    mount(true)
    tick(10)
    expect(drawImage).not.toHaveBeenCalled()
  })

  it('draws once on the animation frame after a frame is presented, and folds several presents into one draw', () => {
    const { present } = mount(true)
    present()
    expect(drawImage).not.toHaveBeenCalled() // on the next animation frame, after onResize has sized the canvas
    tick()
    expect(drawImage).toHaveBeenCalledTimes(1)
    present(); present(); present()
    tick(3)
    expect(drawImage).toHaveBeenCalledTimes(2)
  })

  it('keeps drawing every animation frame for a decoder that cannot say when it presented', () => {
    mount(false)
    tick(4)
    expect(drawImage).toHaveBeenCalledTimes(4)
  })

  it('stops listening and drops a pending draw when the decoder goes', () => {
    const { present, listeners, cleanup } = mount(true)
    present()
    cleanup()
    tick()
    expect(listeners.size).toBe(0)
    expect(drawImage).not.toHaveBeenCalled()
  })
})
