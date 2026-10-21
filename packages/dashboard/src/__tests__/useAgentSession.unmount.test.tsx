// The unmount teardown against the real `useRelay`, not a mock: what decides whether the shutdown is sent is the
// order of the two hooks' cleanups, and a mocked `useRelay` has no socket to close first. With the mock, the
// sibling test in useQASessionHooks.test.tsx passed while the shutdown never left the browser.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useAgentSession } from '@/hooks/useAgentSession'
import type { DeviceSummary } from '@/lib/types'

class FakeSocket {
  static OPEN = 1
  static CLOSING = 2
  static last: FakeSocket | null = null
  readyState = 0
  binaryType = ''
  sent: unknown[] = []
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onmessage: ((e: { data: unknown }) => void) | null = null
  constructor() { FakeSocket.last = this }
  send(data: string) { this.sent.push(JSON.parse(data)) }
  close() { this.readyState = FakeSocket.CLOSING }
  open() { this.readyState = FakeSocket.OPEN; this.onopen?.() }
}

beforeEach(() => { FakeSocket.last = null; vi.stubGlobal('WebSocket', FakeSocket) })
afterEach(() => vi.unstubAllGlobals())

const device: DeviceSummary = {
  id: 'avd:Pixel_7', name: 'Pixel 7', platform: 'android', status: 'booted', sessionId: 'sess-1', busy: false,
}

describe('useAgentSession — leaving the page', () => {
  it('sends device:shutdown before its socket closes', () => {
    const { result, unmount } = renderHook(() => useAgentSession('android'))
    const socket = FakeSocket.last!
    act(() => socket.open())
    act(() => result.current.startDevice(device))

    unmount()

    expect(socket.sent).toContainEqual({ type: 'device:shutdown', sessionId: 'sess-1', payload: { deviceId: 'avd:Pixel_7' } })
    expect(socket.readyState).toBe(FakeSocket.CLOSING)
  })

  it('sends nothing on leaving when no device was started', () => {
    const { unmount } = renderHook(() => useAgentSession('android'))
    const socket = FakeSocket.last!
    act(() => socket.open())
    unmount()
    expect(socket.sent.some((m) => (m as { type: string }).type === 'device:shutdown')).toBe(false)
  })
})
