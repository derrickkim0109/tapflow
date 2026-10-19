import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, act } from '@testing-library/react'
import { framelessChrome } from '@/lib/framelessChrome'

// What the viewer does around a chrome that can change under it — the frameless one the dashboard
// draws when the agent sent none, and the real one that may replace it — and the screen it shows while
// no frame is arriving. Harness as in `IOSViewer.roundedClip.test.tsx`.

type Size = { width: number; height: number }
type DecoderReady = (d: { surface: HTMLCanvasElement; size: Size | null }) => unknown
const captured = vi.hoisted(() => ({
  onDecoderReady: null as DecoderReady | null,
  onResize: null as ((size: Size) => void) | null,
}))

vi.mock('@/hooks/useDecoderStream', () => ({
  useDecoderStream: (opts: { onDecoderReady: DecoderReady; onResize: (size: Size) => void }) => {
    captured.onDecoderReady = opts.onDecoderReady
    captured.onResize = opts.onResize
  },
}))
vi.mock('@/hooks/useClientRecording', () => ({
  useClientRecording: () => ({
    recordState: 'idle', recordCanvasRef: { current: null },
    setComposeFrame: () => {}, startClientRecording: () => {}, stopClientRecording: () => {},
  }),
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }))

import { IOSViewer } from '@/components/device/IOSViewer'

const REAL = {
  framePng: 'iVBORw0KGgo=', bezelWidth: 600, bezelHeight: 1200,
  compositeWidth: 640, compositeHeight: 1240,
  padding: { left: 20, right: 20, top: 20, bottom: 20 },
  screenRect: { x: 40, y: 40, width: 560, height: 1160 },
  screenCornerRadius: 40, logicalWidth: 390, logicalHeight: 844, buttons: [],
}

function props(chrome: React.ComponentProps<typeof IOSViewer>['chrome'], onStreamSize?: (s: Size) => void) {
  return {
    sessionId: 's1', send: vi.fn(), openUrl: vi.fn(), launchApp: vi.fn(),
    connected: true, joined: true, deviceReady: true, installing: false, installed: true,
    installError: null, bootError: null, launching: false, chrome, onStreamSize,
    binaryFrameHandlerRef: { current: undefined }, clipboardHandlerRef: { current: undefined },
    clipboardSupported: true, networkHandlerRef: { current: undefined }, networkSupported: false,
    swKeyboardVisible: false, swKeyboardPending: false, onKbdToggle: vi.fn(),
    rebootPending: false, onReboot: vi.fn(), restartButtonRef: { current: null },
  // The prop surface is wide and none of it is what this file is about.
  } as unknown as React.ComponentProps<typeof IOSViewer>
}

const mirrorOf = (c: HTMLElement) => [...c.querySelectorAll('canvas')].find((el) => el.style.width !== '')!

describe('IOSViewer — a chrome that changes under a running decoder', () => {
  // The decoder surface took the canvas's place once, when it started. A real chrome replacing the
  // frameless one left it covering the whole canvas, frame and all.
  it('moves the decoder surface to the new screen', () => {
    const view = render(<IOSViewer {...props(framelessChrome({ width: 1000, height: 2000 }))} />)
    const surface = document.createElement('canvas')
    act(() => { captured.onDecoderReady?.({ surface, size: null }) })
    expect(surface.style.left).toBe('0%')
    view.rerender(<IOSViewer {...props(REAL)} />)
    expect(surface.style.left).toBe(mirrorOf(view.container).style.left)
    expect(surface.style.left).not.toBe('0%')
  })

  it('reports the size the stream arrives at', () => {
    const onStreamSize = vi.fn()
    render(<IOSViewer {...props(framelessChrome({ width: 1000, height: 2000 }), onStreamSize)} />)
    act(() => { captured.onResize?.({ width: 1206, height: 2622 }) })
    expect(onStreamSize).toHaveBeenCalledWith({ width: 1206, height: 2622 })
  })
})

describe('IOSViewer — waiting for a frame', () => {
  const waiting = (c: HTMLElement) => c.querySelector<HTMLElement>('[data-testid="screen-waiting"]')!

  afterEach(() => { vi.useRealTimers() })

  // White text over a picture already on screen was unreadable; over the skeleton it is not.
  it('dims a screen that already shows a picture, and not the skeleton', () => {
    vi.useFakeTimers()
    const view = render(<IOSViewer {...props(REAL)} />)
    expect(waiting(view.container).querySelector('[aria-hidden="true"]'), 'the skeleton was dimmed').toBeNull()
    act(() => { captured.onResize?.({ width: 1206, height: 2622 }) })
    act(() => { vi.advanceTimersByTime(3000) })
    expect(waiting(view.container).querySelector('[aria-hidden="true"]'), 'the picture was not dimmed').toBeTruthy()
  })

  // A still screen's keep-alive comes about every 1.03s, so a one-second fps window reads 0 every half
  // minute on a healthy stream. Over a picture that blink, now dimmed, must not show.
  it('says nothing over a picture until the stream has stayed quiet', () => {
    vi.useFakeTimers()
    const view = render(<IOSViewer {...props(REAL)} />)
    act(() => { captured.onResize?.({ width: 1206, height: 2622 }) })
    act(() => { vi.advanceTimersByTime(2000) })
    expect(view.container.querySelector('[data-testid="screen-waiting"]'), 'one quiet window was announced').toBeNull()
    act(() => { vi.advanceTimersByTime(600) })
    expect(view.container.querySelector('[data-testid="screen-waiting"]')).toBeTruthy()
  })

  // The quiet is measured from the picture: a first frame later than the delay must not arrive dimmed.
  it('does not dim a first frame that took longer than the delay', () => {
    vi.useFakeTimers()
    const view = render(<IOSViewer {...props(REAL)} />)
    act(() => { vi.advanceTimersByTime(3000) })
    act(() => { captured.onResize?.({ width: 1206, height: 2622 }) })
    expect(view.container.querySelector('[data-testid="screen-waiting"]'), 'the new picture was dimmed at once').toBeNull()
  })

  it('says "first frame" before any picture and "next frame" over one', () => {
    vi.useFakeTimers()
    const view = render(<IOSViewer {...props(REAL)} />)
    expect(waiting(view.container).textContent).toBe('Waiting for first frame...')
    act(() => { captured.onResize?.({ width: 1206, height: 2622 }) })
    act(() => { vi.advanceTimersByTime(3000) })
    expect(waiting(view.container).textContent).toBe('Waiting for next frame...')
  })

  // The dim is placed and rounded by the box it sits in, which is the screen's own geometry.
  it('sits in a box with the screen\'s place and corners, clipping what is inside', () => {
    const view = render(<IOSViewer {...props(REAL)} />)
    const box = waiting(view.container)
    const mirror = mirrorOf(view.container)
    for (const k of ['left', 'top', 'width', 'height', 'borderRadius'] as const) expect(box.style[k]).toBe(mirror.style[k])
    expect(box.className).toContain('overflow-hidden')
  })
})
