// #517. A software-keyboard toggle is answered only by `keyboard:toggled`, and iOS sends nothing when the
// toggle fails — its `simctl` call's `.catch` logs and returns, and a session it holds no state for drops
// the message. So the button, which says "changing it" while it waits, used to wait for the life of the
// mount. The rebind path is held by `DeviceViewer.rebind.test.tsx`; this holds the deadline, which is what
// covers a failure with no restart behind it — and which nothing held until now.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, act, fireEvent } from '@testing-library/react'
import type { BrowserToRelay } from '@tapflowio/protocol'
import type { BrowserInbound } from '@/lib/types'

const send = vi.fn<(msg: BrowserToRelay) => void>()
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
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }))
vi.mock('sonner', () => ({ toast }))

const { DeviceViewer } = await import('@/components/DeviceViewer')

/** Minimal iOS chrome — enough for the platform viewer, and with it the keyboard button, to mount. */
const CHROME = {
  framePng: 'iVBORw0KGgo=', bezelWidth: 10, bezelHeight: 10,
  compositeWidth: 100, compositeHeight: 200,
  padding: { left: 0, right: 0, top: 0, bottom: 0 },
  screenRect: { x: 0, y: 0, width: 100, height: 200 },
  screenCornerRadius: 0, logicalWidth: 50, logicalHeight: 100, buttons: [],
}

const DEADLINE_MS = 8_000

function live() {
  render(<DeviceViewer sessionId="s1" deviceId="dev-1" />)
  act(() => { deliver!({ type: 'session:joined', sessionId: 's1', capabilities: [] }) })
  act(() => { deliver!({ type: 'device:ready', sessionId: 's1', payload: { deviceId: 'dev-1' } }) })
  act(() => { deliver!({ type: 'session:chrome', sessionId: 's1', payload: CHROME }) })
}

const kbd = () => document.querySelector('button[data-active]') as HTMLButtonElement
const pending = () => kbd().getAttribute('aria-disabled') === 'true'
const toggled = (visible: boolean) =>
  act(() => { deliver!({ type: 'keyboard:toggled', sessionId: 's1', payload: { visible } }) })

describe('a keyboard toggle nobody answers (#517)', () => {
  beforeEach(() => {
    send.mockClear(); toast.error.mockClear(); deliver = null
    vi.useFakeTimers()
  })
  afterEach(() => { vi.useRealTimers() })

  it('stops waiting at the deadline and says the device did not answer', () => {
    live()
    fireEvent.click(kbd())
    expect(pending()).toBe(true)

    act(() => { vi.advanceTimersByTime(DEADLINE_MS - 1) })
    expect(pending(), 'gave up before the deadline').toBe(true)
    expect(toast.error).not.toHaveBeenCalled()

    act(() => { vi.advanceTimersByTime(1) })
    expect(pending(), 'the button stayed latched with nothing coming').toBe(false)
    expect(toast.error).toHaveBeenCalledOnce()
    // Where the keyboard is, is unknown, so the button keeps the last state the device confirmed rather
    // than guessing the toggle happened.
    expect(kbd().getAttribute('data-active')).toBe('false')
  })

  it('lets the toggle be tried again once the wait is over', () => {
    live()
    fireEvent.click(kbd())
    act(() => { vi.advanceTimersByTime(DEADLINE_MS) })

    const toggles = () => send.mock.calls.filter(([m]) => m.type === 'input:keyboard:toggle').length
    const before = toggles()
    fireEvent.click(kbd())
    expect(toggles()).toBe(before + 1)
  })

  it('says nothing when the device answers in time', () => {
    live()
    fireEvent.click(kbd())
    toggled(true)
    expect(pending()).toBe(false)

    act(() => { vi.advanceTimersByTime(DEADLINE_MS * 2) })
    expect(toast.error, 'the deadline fired for a toggle that was answered').not.toHaveBeenCalled()
    expect(kbd().getAttribute('data-active')).toBe('true')
  })
})
