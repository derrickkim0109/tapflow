import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'

/**
 * **The device frame's physical buttons are pressed through elements the browser hit-tests (#785).**
 *
 * The container used to work out which button a pointer was over by hand — composite-space
 * arithmetic, a nearest-rectangle search, and an inverse of the landscape rotation. Each button now
 * has an element laid out by `buttonTargets`, so the browser does all three. `buttonHit.test.ts`
 * holds the geometry; jsdom has no layout, so this file holds what a press *sends*, and that the
 * targets stay out of the accessibility tree — the frame is part of the streamed device, which
 * this package deliberately leaves out of scope (AGENTS.md).
 */

vi.mock('@/hooks/useClientRecording', () => ({
  useClientRecording: () => ({
    recordState: 'idle', recordCanvasRef: { current: null },
    setComposeFrame: () => {}, startClientRecording: () => {}, stopClientRecording: () => {},
  }),
}))
vi.mock('@/hooks/useDecoderStream', () => ({ useDecoderStream: () => {} }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }))

import { IOSViewer } from '@/components/device/IOSViewer'

const sideButton = (name: string, title: string, y: number) => ({
  name, accessibilityTitle: title, anchor: 'left', onTop: false,
  normalOffset: { x: 10, y }, rolloverOffset: { x: 8, y },
  buttonW: 12, buttonH: 100, usagePage: 0, usage: 0, buttonPng: 'AA==',
})

const chrome = {
  framePng: '', bezelWidth: 600, bezelHeight: 1200,
  compositeWidth: 640, compositeHeight: 1240,
  padding: { left: 20, right: 20, top: 20, bottom: 20 },
  screenRect: { x: 40, y: 40, width: 560, height: 1160 },
  screenCornerRadius: 40, logicalWidth: 390, logicalHeight: 844,
  buttons: [sideButton('action', 'Action', 300), sideButton('volume_up', 'Volume Up', 500)],
}

function renderViewer(over: Record<string, unknown> = {}) {
  const send = vi.fn()
  const props = {
    sessionId: 's1', send, openUrl: vi.fn(), launchApp: vi.fn(),
    connected: true, joined: true, deviceReady: true, installing: false, installed: true,
    installError: null, bootError: null, launching: false, chrome,
    binaryFrameHandlerRef: { current: undefined }, clipboardHandlerRef: { current: undefined },
    clipboardSupported: true, networkHandlerRef: { current: undefined }, networkSupported: false,
    swKeyboardVisible: false, swKeyboardPending: false, onKbdToggle: vi.fn(),
    rebootPending: false, onReboot: vi.fn(), restartButtonRef: { current: null },
    ...over,
  // The prop surface is wide and none of it is what this file is about.
  } as unknown as React.ComponentProps<typeof IOSViewer>
  return { ...render(<IOSViewer {...props} />), send }
}

type Sent = { type: string; payload?: { name?: string; phase?: string } }
const sent = (send: ReturnType<typeof vi.fn>, type: string): Sent[] =>
  send.mock.calls.map(([m]) => m as Sent).filter((m) => m.type === type)
const phases = (send: ReturnType<typeof vi.fn>) =>
  sent(send, 'input:button').map((m) => `${m.payload?.name}:${m.payload?.phase}`)

const target = (container: HTMLElement, name: string) =>
  container.querySelector<HTMLElement>(`[data-frame-button="${name}"]`)!

// jsdom implements no pointer capture.
Element.prototype.setPointerCapture ??= () => {}

describe('IOSViewer — frame buttons are pressed through their own elements', () => {
  afterEach(() => vi.restoreAllMocks())

  // Mutation: render no target. Nothing on the frame can be pressed any more.
  it('gives every frame button a target', () => {
    const { container } = renderViewer()
    expect(target(container, 'action')).toBeTruthy()
    expect(target(container, 'volume_up')).toBeTruthy()
  })

  // The recorded decision: the frame is the streamed device, so its controls are neither named nor
  // focusable. Keyboard access to volume and power belongs in the toolbar, as on Android.
  //
  // Mutation: render a `<button aria-label>`, the shape #785 first proposed.
  it('keeps the targets out of the accessibility tree and the tab order', () => {
    const { container } = renderViewer()
    expect(screen.queryByRole('button', { name: 'Volume Up' })).toBeNull()
    const t = target(container, 'volume_up')
    expect(t.getAttribute('aria-hidden')).toBe('true')
    expect(t.tabIndex).toBe(-1)
  })

  // The release is not the target's own handler: it bubbles to the container, which sends `up` for
  // the button it recorded. So this also holds that the press recorded it.
  //
  // Mutation: let the press bubble too. The container then also starts a screen touch.
  it('presses down and releases, without touching the screen', () => {
    const { send, container } = renderViewer()
    fireEvent.pointerDown(target(container, 'volume_up'), { pointerId: 1, button: 0 })
    fireEvent.pointerUp(target(container, 'volume_up'), { pointerId: 1, button: 0 })
    expect(phases(send)).toEqual(['volume_up:down', 'volume_up:up'])
    expect(sent(send, 'input:touch:start')).toHaveLength(0)
  })

  // Mutation: not recording `pressedButton`. The cancel path then has nothing to release and the
  // HID button stays down on the device.
  it('releases a held button when the pointer is cancelled', () => {
    const { send, container } = renderViewer()
    fireEvent.pointerDown(target(container, 'volume_up'), { pointerId: 1, button: 0 })
    fireEvent.pointerCancel(target(container, 'volume_up'), { pointerId: 1 })
    expect(phases(send)).toEqual(['volume_up:down', 'volume_up:up'])
  })

  // Two fingers on a touchscreen dashboard, power + volume being the screenshot chord. The slot holds
  // one button, and a second press used to overwrite it: the first button never got its `up` and
  // stayed held on the device. The second press is refused, and so is its release, whichever finger
  // lifts first — found by CodeRabbit on #909.
  //
  // Mutations: drop the occupancy check (a second `down` goes out); release without matching the
  // pointer (the refused finger releases the held button early); drop the refused set (its release
  // reaches the screen path as a stray `input:touch:end`).
  it.each([
    ['the holding finger lifts first', [1, 2]],
    ['the refused finger lifts first', [2, 1]],
  ] as const)('holds one button at a time when %s', (_case, liftOrder) => {
    const { send, container } = renderViewer()
    fireEvent.pointerDown(target(container, 'volume_up'), { pointerId: 1, button: 0 })
    fireEvent.pointerDown(target(container, 'action'), { pointerId: 2, button: 0 })
    const ids = { 1: 'volume_up', 2: 'action' } as const
    const released: string[] = []
    for (const id of liftOrder) {
      fireEvent.pointerUp(target(container, ids[id]), { pointerId: id, button: 0 })
      released.push(phases(send).join(','))
    }
    expect(phases(send)).toEqual(['volume_up:down', 'volume_up:up'])
    // The held button is released by its own finger, not by the other one lifting.
    expect(released[liftOrder.indexOf(1)]).toBe('volume_up:down,volume_up:up')
    expect(sent(send, 'input:touch:end')).toHaveLength(0)
  })

  // A screen touch by another finger while a button is held is the screen's: its release must not
  // release the button, which used to happen because the release path asked only "is a button held".
  //
  // Mutation: release the held button on any pointer's up.
  it('does not release a held button when another finger lifts off the screen', () => {
    const { send, container } = renderViewer()
    fireEvent.pointerDown(target(container, 'volume_up'), { pointerId: 1, button: 0 })
    const screenArea = target(container, 'volume_up').parentElement!
    fireEvent.pointerDown(screenArea, { pointerId: 2, button: 0 })
    fireEvent.pointerUp(screenArea, { pointerId: 2, button: 0 })
    expect(phases(send)).toEqual(['volume_up:down'])
    fireEvent.pointerUp(target(container, 'volume_up'), { pointerId: 1, button: 0 })
    expect(phases(send)).toEqual(['volume_up:down', 'volume_up:up'])
  })

  // Three fingers: one dragging on the screen, one holding a button, one refused on another button.
  // The refused finger's movement is nobody's — it used to reach the screen path and move the first
  // finger's drag to its own coordinates. Found by CodeRabbit on #909. jsdom has no layout, so the
  // container is given the box the composite draws at (640 × 1240 composite px at 2×).
  //
  // Mutation: drop the refused-pointer check at the top of the move handler.
  it('ignores movement from a refused button press', () => {
    const { send, container } = renderViewer()
    const area = target(container, 'volume_up').parentElement!
    vi.spyOn(area, 'getBoundingClientRect').mockReturnValue(
      { left: 0, top: 0, width: 320, height: 620, right: 320, bottom: 620, x: 0, y: 0, toJSON: () => ({}) } as DOMRect,
    )
    fireEvent.pointerDown(area, { pointerId: 1, button: 0, buttons: 1, clientX: 160, clientY: 300 })
    expect(sent(send, 'input:touch:start')).toHaveLength(1)
    fireEvent.pointerDown(target(container, 'volume_up'), { pointerId: 2, button: 0 })
    fireEvent.pointerDown(target(container, 'action'), { pointerId: 3, button: 0 })
    fireEvent.pointerMove(area, { pointerId: 3, buttons: 1, clientX: 250, clientY: 500 })
    expect(sent(send, 'input:touch:move')).toHaveLength(0)
  })

  // Option + drag is a pinch wherever it starts, as when the container decided everything.
  //
  // Mutation: drop the `isOptionHeld` early return. The button is pressed instead.
  it('lets a pinch start on a frame button while Option is held', () => {
    const { send, container } = renderViewer()
    fireEvent.keyDown(window, { key: 'Alt', code: 'AltLeft' })
    fireEvent.pointerDown(target(container, 'volume_up'), { pointerId: 1, button: 0 })
    expect(sent(send, 'input:button')).toHaveLength(0)
    fireEvent.keyUp(window, { key: 'Alt', code: 'AltLeft' })
  })

  // Hover is the target's now. The tooltip names the button the pointer is on, and leaving it
  // removes the tooltip rather than leaving the last one up.
  //
  // The pointer leaves onto the frame, still inside the viewer: leaving the viewer altogether is
  // cleared by the container's own handler, which would hide a target that never clears its hover.
  //
  // Mutation: make the target's leave handler a no-op. The tooltip stays up over the bare frame.
  it('shows the button name while the pointer is over its target', () => {
    const { container } = renderViewer()
    const t = target(container, 'volume_up')
    fireEvent.pointerEnter(t)
    expect(screen.getByText('Volume Up')).toBeTruthy()
    fireEvent.pointerLeave(t, { relatedTarget: t.parentElement })
    expect(screen.queryByText('Volume Up')).toBeNull()
  })

  // A released button keeps its pressed image for 100 ms. That timer outlived the component: it fired
  // after unmount, and once this file's environment was gone it threw `window is not defined` from
  // React, failing an unrelated PR's run (#912).
  describe('the pressed image after a release', () => {
    const pressed = (name: string, y: number) => ({
      ...sideButton(name, name, y), pressedPng: 'BB==', pressedRect: { width: 12, height: 100 },
    })
    const withPressed = { ...chrome, buttons: [pressed('volume_up', 500), pressed('volume_down', 700)] }
    const pressedImages = (container: HTMLElement) =>
      container.querySelectorAll('img[src="data:image/png;base64,BB=="]').length
    const press = (container: HTMLElement, name: string, pointerId: number) =>
      fireEvent.pointerDown(target(container, name), { pointerId, button: 0 })
    const release = (container: HTMLElement, name: string, pointerId: number) =>
      fireEvent.pointerUp(target(container, name), { pointerId, button: 0 })

    // Spies first: the outer `restoreAllMocks` runs after this one, and would put back the fake
    // `setTimeout` the spy was laid over, leaving every later test in the file on a frozen clock.
    afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })

    // Counting pending timers does not tell: the viewer has another that unmount clears, so the
    // count drops either way. This follows the one the release started.
    //
    // Mutation: drop the cleanup on unmount. The release's timer is never cleared.
    it('is not cleared by a timer that outlives the viewer', () => {
      vi.useFakeTimers()
      const setSpy = vi.spyOn(globalThis, 'setTimeout')
      const clearSpy = vi.spyOn(globalThis, 'clearTimeout')
      const { container, unmount } = renderViewer({ chrome: withPressed })
      press(container, 'volume_up', 1); release(container, 'volume_up', 1)
      expect(pressedImages(container)).toBe(1)
      const flash = setSpy.mock.results[setSpy.mock.calls.findLastIndex(([, ms]) => ms === 100)]?.value
      expect(flash).toBeDefined()
      unmount()
      expect(clearSpy).toHaveBeenCalledWith(flash)
    })

    // Mutation: leave the earlier release's timer running. It clears the image of the button that is
    // still held.
    it('stays on a button pressed again before the last release finished', () => {
      vi.useFakeTimers()
      const { container } = renderViewer({ chrome: withPressed })
      press(container, 'volume_up', 1); release(container, 'volume_up', 1)
      act(() => { vi.advanceTimersByTime(50) })
      press(container, 'volume_down', 2)
      act(() => { vi.advanceTimersByTime(100) })
      expect(pressedImages(container)).toBe(1)
      release(container, 'volume_down', 2)
      act(() => { vi.advanceTimersByTime(100) })
      expect(pressedImages(container)).toBe(0)
    })
  })

  // An iPad's volume follows orientation (iPadOS 15.4+): turned counter-clockwise, as this viewer
  // turns it, the right-edge pair ends up on top with Up on the left, so Up lowers the volume. The
  // tooltip says what the press does; the press still sends the physical button, which the device
  // remaps. `buttonHit.test.ts` holds the geometry on measured layouts; this holds the wiring.
  //
  // Mutations: render `accessibilityTitle` again (the landscape title stays "Volume Up"); send the
  // displayed title's button (the press goes out as `volume-down`).
  describe('an iPad turned to landscape', () => {
    const rightVolume = (name: string, title: string, usage: number, y: number) => ({
      ...sideButton(name, title, y), anchor: 'right', usagePage: 12, usage,
      normalOffset: { x: 630, y }, rolloverOffset: { x: 630, y },
    })
    const tablet = {
      ...chrome,
      buttons: [rightVolume('volume-up', 'Volume Up', 233, 200), rightVolume('volume-down', 'Volume Down', 234, 330)],
    }

    it('names the button by what it does, and still sends the physical one', async () => {
      const { send, container } = renderViewer({ chrome: tablet, formFactor: 'tablet' })
      fireEvent.pointerEnter(target(container, 'volume-up'))
      expect(screen.getByText('Volume Up')).toBeTruthy()
      fireEvent.pointerLeave(target(container, 'volume-up'), { relatedTarget: target(container, 'volume-up').parentElement })

      fireEvent.click(screen.getByRole('button', { name: /rotate the device/i }))
      fireEvent.pointerEnter(target(container, 'volume-up'))
      expect(screen.getByText('Volume Down')).toBeTruthy()

      fireEvent.pointerDown(target(container, 'volume-up'), { pointerId: 1, button: 0 })
      expect(phases(send)).toEqual(['volume-up:down'])
    })

    it('keeps the physical names for a device that is not a tablet', () => {
      const { container } = renderViewer({ chrome: tablet, formFactor: 'phone' })
      fireEvent.click(screen.getByRole('button', { name: /rotate the device/i }))
      fireEvent.pointerEnter(target(container, 'volume-up'))
      expect(screen.getByText('Volume Up')).toBeTruthy()
    })
  })
})
