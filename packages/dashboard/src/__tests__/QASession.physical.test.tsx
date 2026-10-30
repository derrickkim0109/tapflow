import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { BreadcrumbProvider } from '@/hooks/useBreadcrumb'
import type { BrowserInbound, SessionInfo } from '@/lib/types'
import { withQuery } from './withQuery'

// The mocks are `QASession.aiHolder.test.tsx`'s — the point here is the device list, not the socket.
const { send } = vi.hoisted(() => ({ send: vi.fn() }))
let deliver: ((msg: BrowserInbound) => void) | null = null
vi.mock('@/hooks/useRelay', () => ({
  useRelay: (onMessage: (msg: BrowserInbound) => void) => {
    deliver = onMessage
    return { send, connected: true }
  },
}))
const { BUILD } = vi.hoisted(() => ({
  BUILD: {
    id: 7, app_id: 3, name: 'Demo', platform: 'ios', status_label: null, version_name: '1.0', build_number: '1',
    target: 'simulator' as 'simulator' | 'device',
  },
}))
vi.mock('@/hooks/useBuildLoader', () => ({ useBuildLoader: () => ({ build: BUILD }) }))
vi.mock('@/components/SessionPanel', () => ({ SessionPanel: () => <div /> }))
vi.mock('@/components/DeviceViewer', () => ({ DeviceViewer: () => <div /> }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }))

const { QASession } = await import('../pages/QASession')

const AGENTS: SessionInfo[] = [{
  agentName: 'studio-mac', platform: 'ios', capabilities: [], admission: { booting: false, overloaded: false, memoryRefuses: [] },
  devices: [
    { id: '00008140-0000000000000001', name: 'Test iPhone', platform: 'ios', status: 'booted', osVersion: 'iOS 26.5.2', kind: 'physical', sessionId: 'sess-p', busy: false },
    { id: 'sim-a', name: 'iPhone 17', platform: 'ios', status: 'booted', osVersion: 'iOS 26.3', kind: 'simulator', sessionId: 'sess-a', busy: false },
    // An agent that predates `kind` reports none: it only ever offered simulators.
    { id: 'sim-b', name: 'iPhone SE', platform: 'ios', status: 'shutdown', osVersion: 'iOS 26.3', sessionId: 'sess-b', busy: false },
  ],
}]

async function openDeviceList() {
  const user = userEvent.setup()
  render(withQuery(
    <MemoryRouter initialEntries={['/qa?id=7']}>
      <BreadcrumbProvider><QASession /></BreadcrumbProvider>
    </MemoryRouter>,
  ))
  await vi.waitFor(() => expect(deliver).not.toBeNull())
  await act(async () => { deliver!({ type: 'agents:listed', sessions: AGENTS }) })
  return user
}

describe('QASession — a USB-connected device (#152)', () => {
  // A tester picks a real phone for what a simulator cannot do, so the Mac card says one is there before they open it.
  // Mutation: count every device, or drop the USB count.
  it('says on the Mac how many of its devices are plugged in', async () => {
    await openDeviceList()
    const mac = await screen.findByRole('button', { name: /studio-mac/ })
    expect(mac.textContent).toContain('3 devices')
    expect(mac.textContent).toContain('1 USB')
  })

  // Mutation: key the badge off anything but `kind === 'physical'`, and a simulator (or an older agent's device) gets it.
  it('marks the plugged-in device and no other', async () => {
    const user = await openDeviceList()
    await user.click(await screen.findByText('studio-mac'))
    expect((await screen.findByRole('button', { name: /Test iPhone/ })).textContent).toContain('USB')
    expect(screen.getByRole('button', { name: /iPhone 17/ }).textContent).not.toContain('USB')
    expect(screen.getByRole('button', { name: /iPhone SE/ }).textContent).not.toContain('USB')
  })

  // "Booted" is a simulator's word; a phone on the desk is connected, and nothing boots it.
  it('reads a free plugged-in device as connected, not booted', async () => {
    const user = await openDeviceList()
    await user.click(await screen.findByText('studio-mac'))
    const phone = await screen.findByRole('button', { name: /Test iPhone/ })
    expect(phone.textContent).toContain('Connected')
    expect(phone.textContent).not.toContain('Booted')
    expect(screen.getByRole('button', { name: /iPhone 17/ }).textContent).toContain('Booted')
  })
})

describe('QASession — a build for one target (#152)', () => {
  afterEach(() => { BUILD.target = 'simulator' })

  // Mutation: drop `needsPhone` from `disabled`, and a device build can be sent to a simulator that cannot install it.
  it('offers a device build only on the plugged-in phone', async () => {
    BUILD.target = 'device'
    const user = await openDeviceList()
    await user.click(await screen.findByText('studio-mac'))
    const phone = await screen.findByRole('button', { name: /Test iPhone/ })
    expect(phone).toBeEnabled()
    for (const name of [/iPhone 17/, /iPhone SE/]) {
      const sim = screen.getByRole('button', { name })
      expect(sim).toBeDisabled()
      expect(sim.textContent).toContain('needs a USB iPhone')
    }
  })

  // Mutation: gate on the target in both directions, and a phone that already holds the app can no longer launch it.
  it('leaves every device open to a simulator build, the phone included', async () => {
    const user = await openDeviceList()
    await user.click(await screen.findByText('studio-mac'))
    expect(await screen.findByRole('button', { name: /Test iPhone/ })).toBeEnabled()
    expect(screen.getByRole('button', { name: /iPhone 17/ })).toBeEnabled()
    expect(screen.getByRole('button', { name: /iPhone SE/ })).toBeEnabled()
  })
})
