import { describe, it, expect, vi, afterEach } from 'vitest'
import { render } from '@testing-library/react'

/**
 * #908: on Firefox for macOS the screen's rounded corners are dropped while frames flow, unless the
 * canvas carries an opaque `mask-image` (see `roundedClipMask`). Two canvases are shown: the mirror
 * the viewer renders, and the decoder's surface, mounted over it and styled from the mirror. Both
 * need the mask — a rounded surface over a square mirror still shows the mirror's corners.
 *
 * Mutations, both caught by the first test: drop the `maskImage` copy in `onDecoderReady` (the
 * surface — the canvas actually painting the stream — goes unmasked), or drop it from the mirror.
 */

type DecoderReady = (d: { surface: HTMLCanvasElement; size: { width: number; height: number } | null }) => unknown
const captured = vi.hoisted(() => ({ onDecoderReady: null as DecoderReady | null }))

vi.mock('@/hooks/useDecoderStream', () => ({
  useDecoderStream: (opts: { onDecoderReady: DecoderReady }) => { captured.onDecoderReady = opts.onDecoderReady },
}))
vi.mock('@/hooks/useClientRecording', () => ({
  useClientRecording: () => ({
    recordState: 'idle', recordCanvasRef: { current: null },
    setComposeFrame: () => {}, startClientRecording: () => {}, stopClientRecording: () => {},
  }),
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }))

import { IOSViewer } from '@/components/device/IOSViewer'

const FIREFOX_MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:156.0) Gecko/20100101 Firefox/156.0'
const CHROME_MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'

const chrome = {
  framePng: 'data:image/png;base64,', bezelWidth: 600, bezelHeight: 1200,
  compositeWidth: 640, compositeHeight: 1240,
  padding: { left: 20, right: 20, top: 20, bottom: 20 },
  screenRect: { x: 40, y: 40, width: 560, height: 1160 },
  screenCornerRadius: 40, logicalWidth: 390, logicalHeight: 844, buttons: [],
}

function renderAs(userAgent: string) {
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(userAgent)
  const props = {
    sessionId: 's1', send: vi.fn(), openUrl: vi.fn(), launchApp: vi.fn(),
    connected: true, joined: true, deviceReady: true, installing: false, installed: true,
    installError: null, bootError: null, launching: false, chrome,
    binaryFrameHandlerRef: { current: undefined }, clipboardHandlerRef: { current: undefined },
    clipboardSupported: true, networkHandlerRef: { current: undefined }, networkSupported: false,
    swKeyboardVisible: false, swKeyboardPending: false, onKbdToggle: vi.fn(),
    rebootPending: false, onReboot: vi.fn(), restartButtonRef: { current: null },
  // The prop surface is wide and none of it is what this file is about.
  } as unknown as React.ComponentProps<typeof IOSViewer>
  const view = render(<IOSViewer {...props} />)
  // The viewer's own canvases: the hidden recorder canvas carries no radius and is not one of them.
  const mirror = [...view.container.querySelectorAll('canvas')].find((c) => c.style.borderRadius !== '')
  const surface = document.createElement('canvas')
  captured.onDecoderReady?.({ surface, size: null })
  return { mirror, surface }
}

describe('IOSViewer — rounded screen corners on Firefox for macOS (#908)', () => {
  afterEach(() => vi.restoreAllMocks())

  it('masks the mirror canvas and the decoder surface on Firefox for macOS', () => {
    const { mirror, surface } = renderAs(FIREFOX_MAC)
    expect(mirror?.style.maskImage).toMatch(/^linear-gradient/)
    expect(surface.style.maskImage).toMatch(/^linear-gradient/)
    expect(surface.style.borderRadius).toBe(mirror?.style.borderRadius)
  })

  it('adds no mask elsewhere', () => {
    const { mirror, surface } = renderAs(CHROME_MAC)
    expect(mirror).toBeDefined()
    expect(mirror?.style.maskImage).toBe('')
    expect(surface.style.maskImage).toBe('')
  })
})
