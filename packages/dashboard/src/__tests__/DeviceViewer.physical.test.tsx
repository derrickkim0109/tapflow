import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, act, fireEvent } from '@testing-library/react'
import type { DeviceKind } from '@tapflowio/protocol'
import type { BrowserInbound } from '@/lib/types'

// A phone on USB is driven through the same viewer as a simulator, but the agent refuses what only a simulator or
// emulator can do — rotate, open a URL, fold, the software keyboard, the clipboard and network bridges. Those are
// left out of the toolbar rather than offered as buttons that fail. Android phones report `kind: 'physical'` too,
// so both viewers are held to it. The harness is `DeviceViewer.network.test.tsx`'s.
const send = vi.fn()
let deliver: ((msg: BrowserInbound) => void) | null = null

vi.mock('@/hooks/useRelay', () => ({
  useRelay: (onMessage: (msg: BrowserInbound) => void) => {
    deliver = onMessage
    return { send, connected: true }
  },
}))
vi.mock('@/hooks/usePerfMode', () => ({ usePerfMode: () => ({ perfMode: false, visible: false }) }))
vi.mock('@/hooks/useAudioPlayback', () => ({ useAudioPlayback: () => ({ pushFrame: vi.fn() }) }))
vi.mock('@/lib/decoders/pickDecoder', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/decoders/pickDecoder')>()),
  canDecodeH264: () => false,
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() } }))

const { DeviceViewer } = await import('@/components/DeviceViewer')

const IOS_CHROME = {
  framePng: 'iVBORw0KGgo=', bezelWidth: 10, bezelHeight: 10,
  compositeWidth: 100, compositeHeight: 200,
  padding: { left: 0, right: 0, top: 0, bottom: 0 },
  screenRect: { x: 0, y: 0, width: 100, height: 200 },
  screenCornerRadius: 0, logicalWidth: 50, logicalHeight: 100, buttons: [],
}
const ANDROID_CHROME = {
  buttons: [{ name: 'home', accessibilityTitle: 'Home', keycode: 3 }],
  streamType: 'h264', screenWidth: 1080, screenHeight: 2400,
}
const POSTURES = { postures: [{ id: 'closed', label: 'Closed' }, { id: 'open', label: 'Open' }], currentId: 'open' }

/** A viewer with a device on screen, on an agent that advertises every capability the toolbar gates on. */
function live(platform: 'ios' | 'android', kind: DeviceKind | undefined) {
  const view = render(<DeviceViewer sessionId="mine" deviceId="dev-1" platform={platform} kind={kind} />)
  act(() => { deliver!({ type: 'session:joined', sessionId: 'mine', capabilities: ['clipboard', 'network-control', 'full-reset'] }) })
  act(() => { deliver!({ type: 'device:ready', sessionId: 'mine', payload: { deviceId: 'dev-1' } }) })
  act(() => { deliver!({ type: 'session:chrome', sessionId: 'mine', payload: platform === 'ios' ? IOS_CHROME : ANDROID_CHROME } as BrowserInbound) })
  act(() => { deliver!({ type: 'device:postures', sessionId: 'mine', payload: POSTURES } as BrowserInbound) })
  return view
}

const control = (name: RegExp) => screen.queryByRole('button', { name })
const ROTATE = /^Rotate the device$/
const DEEPLINK = /^Open a deeplink$/
const NETWORK = /device (offline|online|network)$/
const FOLD = /^(Fold|Unfold):/
const KEYBOARD = /^Software keyboard/

/** Activate the device screen and paste onto it: what reaches the clipboard bridge. */
function pasteOnDevice(container: HTMLElement) {
  fireEvent.pointerDown(container.querySelector('canvas:not([style*="display: none"])')!, { pointerId: 1, button: 0 })
  const paste = new Event('paste', { bubbles: true, cancelable: true })
  Object.defineProperty(paste, 'clipboardData', { value: { getData: () => 'hello' } })
  act(() => { document.dispatchEvent(paste) })
}
const sent = (type: string) => send.mock.calls.map(([m]) => m).filter((m) => m.type === type)

describe('DeviceViewer — controls a phone on USB cannot use', () => {
  beforeEach(() => { send.mockClear(); deliver = null })

  describe.each(['ios', 'android'] as const)('%s', (platform) => {
    // Mutation: pass `onRotate`, `onDeepLink` or `posture` to the toolbar regardless of `physical`, or drop the
    // `!physical` from `networkSupported` — the phone gets a button the agent refuses.
    it('leaves rotate, deeplink, fold and network out for a physical device', () => {
      live(platform, 'physical')
      expect(control(/^Take a screenshot$/), 'the harness renders the toolbar').toBeTruthy()
      expect(control(ROTATE)).toBeNull()
      expect(control(DEEPLINK)).toBeNull()
      expect(control(FOLD)).toBeNull()
      expect(control(NETWORK)).toBeNull()
    })

    // The other half: the same props on a simulator or emulator, and on an older agent that reports no kind.
    // Mutation: gate on anything but `kind === 'physical'`.
    it.each(['simulator', 'emulator', undefined] as const)('keeps them for kind %s', (kind) => {
      live(platform, kind)
      expect(control(ROTATE)).toBeTruthy()
      expect(control(DEEPLINK)).toBeTruthy()
      expect(control(FOLD)).toBeTruthy()
      expect(control(NETWORK)).toBeTruthy()
    })

    /** Press the deeplink and rotate shortcuts, and wait out the frame's turn: a rotate is sent once it has finished. */
    async function pressShortcuts() {
      // Rotate first: the dialog takes focus into its field, where the viewer's shortcuts stand down.
      act(() => { fireEvent.keyDown(window, { code: 'KeyO', metaKey: true, shiftKey: true }) })
      await act(async () => { await new Promise((r) => setTimeout(r, 500)) })
      act(() => { fireEvent.keyDown(window, { code: 'KeyK', metaKey: true }) })
      return { dialog: screen.queryByRole('dialog'), rotates: sent('input:rotate').length }
    }

    // Mutation: drop the `!physical` from the deeplink or rotate shortcut — the hidden control opens from the keyboard.
    it('does not open the deeplink dialog or rotate from the keyboard on a physical device', async () => {
      live(platform, 'physical')
      expect(await pressShortcuts()).toEqual({ dialog: null, rotates: 0 })
    })

    it('still does both from the keyboard on a simulator', async () => {
      live(platform, undefined)
      const { dialog, rotates } = await pressShortcuts()
      expect(dialog).toBeTruthy()
      expect(rotates).toBe(1)
    })
  })

  // One platform is enough: `clipboardSupported` is decided once in `DeviceViewer` for both viewers.
  // Mutation: drop the `!physical` from `clipboardSupported` — a paste becomes a `clipboard:write` the agent refuses.
  it('bridges the clipboard for a simulator and not for a physical device', () => {
    const sim = live('ios', undefined)
    pasteOnDevice(sim.container)
    expect(sent('clipboard:write')).toHaveLength(1)
    sim.unmount()
    send.mockClear()

    const phone = live('ios', 'physical')
    pasteOnDevice(phone.container)
    expect(sent('clipboard:write')).toHaveLength(0)
  })

  // iOS only: Android has no software keyboard control.
  // Mutation: pass `deviceSlot` regardless of `physical`, or drop the `!physical` from its shortcut.
  it('leaves the software keyboard toggle and its shortcut out on an iPhone, and keeps them on a simulator', () => {
    const phone = live('ios', 'physical')
    expect(control(KEYBOARD)).toBeNull()
    act(() => { fireEvent.keyDown(window, { code: 'KeyK', metaKey: true, shiftKey: true }) })
    expect(sent('input:keyboard:toggle')).toHaveLength(0)
    phone.unmount()

    live('ios', 'simulator')
    expect(control(KEYBOARD)).toBeTruthy()
  })
})
