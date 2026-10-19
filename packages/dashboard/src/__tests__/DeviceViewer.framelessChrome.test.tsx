import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import type { BrowserInbound } from '@/lib/types'

// An iOS agent that cannot build the device frame sends no `session:chrome`, and the viewer mounted
// only with one — so the stream ran behind a skeleton for the whole session. `device:ready` with no
// chrome means none is coming, and the screen is shown alone. Harness as in `DeviceViewer.reboot.test.tsx`.
let deliver: ((msg: BrowserInbound) => void) | null = null

vi.mock('@/hooks/useRelay', () => ({
  useRelay: (onMessage: (msg: BrowserInbound) => void) => {
    deliver = onMessage
    return { send: vi.fn(), connected: true }
  },
}))
vi.mock('@/hooks/usePerfMode', () => ({ usePerfMode: () => ({ perfMode: false, visible: false }) }))
vi.mock('@/hooks/useAudioPlayback', () => ({ useAudioPlayback: () => ({ pushFrame: vi.fn() }) }))
vi.mock('@/lib/decoders/pickDecoder', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/decoders/pickDecoder')>()),
  canDecodeH264: () => false,
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }))

const { DeviceViewer } = await import('@/components/DeviceViewer')

const CHROME = {
  framePng: 'iVBORw0KGgo=', bezelWidth: 10, bezelHeight: 10,
  compositeWidth: 100, compositeHeight: 200,
  padding: { left: 0, right: 0, top: 0, bottom: 0 },
  screenRect: { x: 10, y: 20, width: 80, height: 160 },
  screenCornerRadius: 0, logicalWidth: 50, logicalHeight: 100, buttons: [],
}

const NOTE = /side buttons \(lock, volume\) are unavailable/

function joined(platform: string) {
  const view = render(<DeviceViewer sessionId="s" deviceId="dev-1" platform={platform} />)
  act(() => { deliver!({ type: 'session:joined', sessionId: 's', capabilities: [] }) })
  return view
}
const ready = () => act(() => { deliver!({ type: 'device:ready', sessionId: 's', payload: { deviceId: 'dev-1' } }) })
const chrome = () => act(() => { deliver!({ type: 'session:chrome', sessionId: 's', payload: CHROME }) })
const skeleton = () => screen.queryByTestId('device-skeleton')
const restart = () => screen.queryByRole('button', { name: 'Restart the device' })

describe('DeviceViewer — a device with no chrome from the agent', () => {
  beforeEach(() => { deliver = null })

  it('shows the screen without a frame once the device is ready, and says the side buttons are gone', () => {
    joined('ios')
    ready()
    expect(skeleton(), 'the skeleton outlived a ready device').toBeNull()
    expect(restart(), 'no viewer was mounted').toBeTruthy()
    expect(screen.getByText(NOTE)).toBeTruthy()
  })

  // The control for the test above: an absence on Android proves nothing unless the same steps on iOS
  // produce the viewer, which they do.
  it('leaves an Android device on the skeleton, whose agent always sends its chrome first', () => {
    joined('android')
    ready()
    expect(skeleton()).toBeTruthy()
    expect(restart()).toBeNull()
  })

  it('waits for ready rather than guessing while a boot is still running', () => {
    joined('ios')
    expect(skeleton()).toBeTruthy()
  })

  it('uses the chrome the agent sent, with no note', () => {
    joined('ios')
    chrome()
    ready()
    expect(screen.queryByText(NOTE)).toBeNull()
  })

  // No agent sends chrome after ready today, so this is the defence the design asked for: if one ever
  // does, it replaces the frameless screen in the same viewer — no remount, so focus and the decoder stay.
  it('takes a chrome that arrives late, in the same viewer', () => {
    joined('ios')
    ready()
    const before = restart()
    chrome()
    expect(screen.queryByText(NOTE)).toBeNull()
    expect(restart(), 'the viewer was remounted').toBe(before)
  })

  it('goes back to the skeleton when the device boots again', () => {
    joined('ios')
    ready()
    act(() => { deliver!({ type: 'device:booting', sessionId: 's' }) })
    expect(skeleton()).toBeTruthy()
  })
})
