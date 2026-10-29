import { describe, it, expect, vi } from 'vitest'
import { render, fireEvent, act } from '@testing-library/react'
import type { ReactNode } from 'react'

/**
 * **The device as it is drawn, apart from the controls that drive it.** `IOSDeviceScreen` /
 * `AndroidDeviceScreen` and their hooks are shared by the viewers and by a page that only watches, so
 * what they take from the caller — handlers, overlays, the press targets — is the seam a refactor can
 * quietly cut. The viewer tests exercise it through the viewers; four mutations of the seam survived
 * them (an overlay dropped on either platform, Android's pointer handlers dropped, a rotation in flight
 * ignored), so this file holds each one directly.
 */

type Size = { width: number; height: number }
const captured: { onResize?: (s: Size) => void } = {}
vi.mock('@/hooks/useDecoderStream', () => ({
  useDecoderStream: (opts: { onResize: (s: Size) => void }) => { captured.onResize = opts.onResize },
}))

import { useIOSScreen } from '@/hooks/useIOSScreen'
import { iosTurn } from '@/lib/coordinate-transform'
import { IOSDeviceScreen, type IOSFrameButtonControls } from '@/components/device/IOSDeviceScreen'
import { useAndroidScreen, type AndroidScreen } from '@/hooks/useAndroidScreen'
import { AndroidDeviceScreen } from '@/components/device/AndroidDeviceScreen'

// jsdom implements no pointer capture.
Element.prototype.setPointerCapture ??= () => {}

const sideButton = (name: string, y: number) => ({
  name, accessibilityTitle: name, anchor: 'left', onTop: false,
  normalOffset: { x: 10, y }, rolloverOffset: { x: 8, y },
  buttonW: 12, buttonH: 100, usagePage: 0, usage: 0, buttonPng: 'AA==',
})
const chrome = {
  framePng: '', bezelWidth: 600, bezelHeight: 1200,
  compositeWidth: 640, compositeHeight: 1240,
  padding: { left: 20, right: 20, top: 20, bottom: 20 },
  screenRect: { x: 40, y: 40, width: 560, height: 1160 },
  screenCornerRadius: 40, logicalWidth: 390, logicalHeight: 844,
  buttons: [sideButton('action', 300), sideButton('volume_up', 500)],
} as unknown as React.ComponentProps<typeof IOSDeviceScreen>['chrome']

function IOSHarness(props: {
  chrome?: typeof chrome
  isLandscape?: boolean
  buttons?: IOSFrameButtonControls
  onPointerDown?: () => void
  overlay?: ReactNode
  areaOverlay?: ReactNode
}) {
  const shown = props.chrome ?? chrome
  const screen = useIOSScreen({
    chrome: shown, binaryFrameHandlerRef: { current: undefined }, fps: 0, frameCount: { current: 0 },
  })
  return (
    <IOSDeviceScreen
      screen={screen} chrome={shown} turn={iosTurn(shown.streamRotation, props.isLandscape ?? false)} joined fps={0}
      containerHandlers={props.onPointerDown ? { onPointerDown: props.onPointerDown } : undefined}
      buttons={props.buttons} overlay={props.overlay} areaOverlay={props.areaOverlay}
    />
  )
}

describe('IOSDeviceScreen', () => {
  // The device's container is what turns; the area around it takes the turned size.
  const container = (root: HTMLElement) => root.firstElementChild!.firstElementChild as HTMLElement

  // Mutation: keep turning by the viewer's own landscape when the agent reports a turn. The Duo's
  // unfolded panel arrives at 90, which the viewer's -90 would draw upside down.
  it('turns the device as far as the agent says, whatever the viewer last asked for', () => {
    for (const [streamRotation, isLandscape, deg] of [[90, false, 90], [180, false, 180], [270, false, 270], [0, true, 0]] as const) {
      const { container: root, unmount } = render(<IOSHarness chrome={{ ...chrome, streamRotation }} isLandscape={isLandscape} />)
      expect(container(root).style.transform, String(streamRotation)).toBe(`translate(-50%, -50%) rotate(${deg}deg)`)
      unmount()
    }
  })

  it('keeps its own landscape for a device that reports nothing', () => {
    const { container: root } = render(<IOSHarness isLandscape />)
    expect(container(root).style.transform).toBe('translate(-50%, -50%) rotate(270deg)')
    // The area takes the turned size: the device's height across.
    const area = root.firstElementChild as HTMLElement
    expect(parseFloat(area.style.width)).toBeGreaterThan(parseFloat(area.style.height))
  })

  // Mutation: take the turn mod 360 (270 → 0 animates three quarters the wrong way round).
  it('turns the short way round, and keeps the running angle', () => {
    const at = (streamRotation: 0 | 90 | 180 | 270) => ({ ...chrome, streamRotation })
    const { container: root, rerender } = render(<IOSHarness chrome={at(270)} />)
    const deg = () => Number(container(root).style.transform.match(/rotate\((-?\d+)deg\)/)![1])
    expect(deg()).toBe(270)
    rerender(<IOSHarness chrome={at(0)} />)
    expect(deg()).toBe(360)
    rerender(<IOSHarness chrome={at(90)} />)
    expect(deg()).toBe(450)
    rerender(<IOSHarness chrome={at(0)} />)
    expect(deg()).toBe(360)
  })

  // The Duo's unfolded panel is drawn a quarter round from its cover, so a fold changes the turn with no
  // turn of the device — and animating it spun a dark panel round. Mutation: animate whenever the turn changes.
  it('animates a turn, and not a fold that changes the turn with the frame', () => {
    const turns = (el: HTMLElement) => el.className.includes('transition-transform')
    const { container: root, rerender } = render(<IOSHarness chrome={{ ...chrome, streamRotation: 0 }} />)
    rerender(<IOSHarness chrome={{ ...chrome, streamRotation: 90 }} />)
    expect(turns(container(root))).toBe(true)
    rerender(<IOSHarness chrome={{ ...chrome, framePng: 'unfolded', streamRotation: 180 }} />)
    expect(container(root).style.transform).toBe('translate(-50%, -50%) rotate(180deg)')
    expect(turns(container(root))).toBe(false)
    rerender(<IOSHarness chrome={{ ...chrome, framePng: 'unfolded', streamRotation: 270 }} />)
    expect(turns(container(root))).toBe(true)
  })

  // The overlay is on the screen and turns with the device; its words must not. Mutation: drop the turn back.
  it('stands the waiting words upright on a turned device', () => {
    const { container: root } = render(<IOSHarness chrome={{ ...chrome, streamRotation: 90 }} />)
    const words = root.querySelector('[data-testid="screen-waiting"] span') as HTMLElement
    expect(words.style.transform).toBe('rotate(-90deg)')
  })

  // Mutation: drop `usePanelFade` from the screen (a fold would swap panels with no transition at all).
  it('fades the device in when it changes panel', () => {
    const animate = vi.fn(() => ({ cancel: vi.fn() }))
    Object.defineProperty(HTMLElement.prototype, 'animate', { configurable: true, value: animate })
    try {
      const { rerender } = render(<IOSHarness chrome={chrome} />)
      expect(animate).not.toHaveBeenCalled()
      rerender(<IOSHarness chrome={{ ...chrome, framePng: 'unfolded' }} />)
      expect(animate).toHaveBeenCalledWith([{ opacity: 0 }, { opacity: 1 }], expect.anything())
    } finally { delete (HTMLElement.prototype as { animate?: unknown }).animate }
  })

  // The Duo's cover is half the unfolded device in the hand; sized by its own frame, each panel filled the
  // same height. Mutation: ignore `scaleBasis`.
  it('sizes a panel by the device\'s largest panel when the agent says so', () => {
    const height = (c: typeof chrome) => {
      const { container: root, unmount } = render(<IOSHarness chrome={c} />)
      const h = parseFloat((root.firstElementChild as HTMLElement).style.height)
      unmount()
      return h
    }
    const alone = height(chrome)
    // 1500 pt against the 750 px the viewer allows: drawn at half, where this frame alone fits as it is.
    const inTwo = height({ ...chrome, scaleBasis: 3000 })
    expect(inTwo).toBeCloseTo(alone / 2, 0)
  })

  // Mutation: ignore `screenCornerRadii`. The Duo's cover would be rounded at the hinge.
  it('rounds each corner of the screen as the agent states it', () => {
    const radii = { topLeft: 16, topRight: 118, bottomRight: 118, bottomLeft: 16 }
    const { container: root } = render(<IOSHarness chrome={{ ...chrome, screenCornerRadius: 118, screenCornerRadii: radii }} />)
    const canvas = root.querySelector('canvas')!
    const [tl, tr, br, bl] = canvas.style.borderRadius.split(' ').map(parseFloat)
    expect(tl).toBe(bl)
    expect(tr).toBe(br)
    expect(tr).toBeGreaterThan(tl * 5)
  })

  // A page that only watches passes no button controls; a press target there would be an element
  // that looks pressable and leads nowhere.
  it('draws the frame buttons but no press targets when nobody can press', () => {
    const { container } = render(<IOSHarness />)
    expect(container.querySelectorAll('[data-frame-button]')).toHaveLength(0)
    expect(container.querySelectorAll('img[src="data:image/png;base64,AA=="]')).toHaveLength(2)
  })

  it('puts a press target on each button when the caller can press', () => {
    const onPress = vi.fn()
    const { container } = render(<IOSHarness buttons={{ hovered: null, flashed: null, onHoverChange: vi.fn(), onPress }} />)
    const targets = container.querySelectorAll<HTMLElement>('[data-frame-button]')
    expect(targets).toHaveLength(2)
    fireEvent.pointerDown(targets[1])
    expect(onPress).toHaveBeenCalledWith('volume_up', expect.anything())
  })

  // Mutation: drop the spread. Every tap on the screen goes nowhere.
  it('hands the device container the caller\'s pointer handlers', () => {
    const onPointerDown = vi.fn()
    const { container } = render(<IOSHarness onPointerDown={onPointerDown} />)
    fireEvent.pointerDown(container.querySelector('canvas')!)
    expect(onPointerDown).toHaveBeenCalledTimes(1)
  })

  // Mutation: drop either slot. The pinch hints and the live cursor vanish with no other symptom.
  it('draws the overlays, the device one inside the device and the area one beside it', () => {
    const { getByTestId } = render(
      <IOSHarness overlay={<i data-testid="inside" />} areaOverlay={<i data-testid="beside" />} />,
    )
    const canvas = document.querySelector('canvas')!
    expect(canvas.parentElement!.contains(getByTestId('inside'))).toBe(true)
    expect(canvas.parentElement!.contains(getByTestId('beside'))).toBe(false)
  })
})

function AndroidHarness(props: {
  rotatePending?: boolean
  userWantsLandscape?: boolean
  onPointerDown?: () => void
  overlay?: ReactNode
  expose?: (s: AndroidScreen) => void
}) {
  const screen = useAndroidScreen({
    binaryFrameHandlerRef: { current: undefined }, frameCount: { current: 0 },
    screenWidth: 1080, screenHeight: 2400, streamRotation: 0,
    userWantsLandscape: props.userWantsLandscape ?? false, rotatePending: props.rotatePending ?? false,
  })
  props.expose?.(screen)
  return (
    <AndroidDeviceScreen
      screen={screen} deviceReady posturePending={false}
      surfaceHandlers={props.onPointerDown ? { onPointerDown: props.onPointerDown } : undefined}
      overlay={props.overlay}
    />
  )
}

describe('AndroidDeviceScreen', () => {
  // Mutation: drop the spread. The surface host takes the pointer, so every tap goes nowhere.
  it('hands the surface host the caller\'s pointer handlers', () => {
    const onPointerDown = vi.fn()
    let screen: AndroidScreen | null = null
    render(<AndroidHarness onPointerDown={onPointerDown} expose={(s) => { screen = s }} />)
    const host = screen!.surfaceHostRef.current
    expect(host).not.toBeNull()
    fireEvent.pointerDown(host!)
    expect(onPointerDown).toHaveBeenCalledTimes(1)
  })

  it('draws the overlay over the screen', () => {
    const { getByTestId } = render(<AndroidHarness overlay={<i data-testid="cursor" />} />)
    expect(getByTestId('cursor')).toBeTruthy()
  })

  // The viewer maps pointer events through this ref, outside any render — and it is written in the hook
  // and read in another file. Mutation: never raise it. A portrait-locked app turned by CSS then takes
  // every tap at unrotated coordinates.
  it('tells the pointer mapping a portrait app is being turned by CSS', () => {
    let screen: AndroidScreen | null = null
    const expose = (s: AndroidScreen) => { screen = s }
    const view = render(<AndroidHarness expose={expose} />)
    expect(screen!.needsCSSRotationRef.current).toBe(false)
    view.rerender(<AndroidHarness userWantsLandscape expose={expose} />)
    expect(screen!.needsCSSRotationRef.current).toBe(true)
  })

  // Mutation: stop reading `rotatePending`. A new correction angle is applied to the frame drawn
  // under the old one, and on an idle screen the picture stays turned.
  it('holds the picture back while a rotation is in flight, and shows it once it lands', () => {
    let screen: AndroidScreen | null = null
    const expose = (s: AndroidScreen) => { screen = s }
    const host = () => screen!.surfaceHostRef.current!
    const view = render(<AndroidHarness expose={expose} />)
    act(() => captured.onResize!({ width: 1080, height: 2400 }))
    expect(host().style.visibility).toBe('visible')
    view.rerender(<AndroidHarness rotatePending expose={expose} />)
    expect(host().style.visibility).toBe('hidden')
    view.rerender(<AndroidHarness expose={expose} />)
    expect(host().style.visibility).toBe('visible')
  })
})
