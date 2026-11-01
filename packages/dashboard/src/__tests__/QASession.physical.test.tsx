import { describe, it, expect, vi } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { BreadcrumbProvider, useBreadcrumb } from '@/hooks/useBreadcrumb'
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
  BUILD: { id: 7, app_id: 3, name: 'Demo', platform: 'ios', status_label: null, version_name: '1.0', build_number: '1' },
}))
vi.mock('@/hooks/useBuildLoader', () => ({ useBuildLoader: () => ({ build: BUILD }) }))
vi.mock('@/components/SessionPanel', () => ({ SessionPanel: () => <div /> }))
// Records what the page hands the viewer: the device's kind and the reset it boots with.
const { viewerProps } = vi.hoisted(() => ({ viewerProps: [] as Array<{ kind?: string; resetMode?: string }> }))
vi.mock('@/components/DeviceViewer', () => ({
  DeviceViewer: (props: { kind?: string; resetMode?: string }) => { viewerProps.push({ kind: props.kind, resetMode: props.resetMode }); return <div /> },
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }))
// Signed out unless a test signs an Admin in: only an Admin is offered hidden devices.
const { auth } = vi.hoisted(() => ({ auth: { role: undefined as string | undefined } }))
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: auth.role ? { role: auth.role } : null, loading: false }) }))
/** The page's breadcrumb, which the layout renders in the app: its build entry is the way back to the Macs. */
function Crumbs() { return <>{useBreadcrumb().node}</> }

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

async function openDeviceList(agents: SessionInfo[] = AGENTS, { crumbs = false } = {}) {
  viewerProps.length = 0
  const user = userEvent.setup()
  render(withQuery(
    <MemoryRouter initialEntries={['/qa?id=7']}>
      <BreadcrumbProvider>{crumbs && <Crumbs />}<QASession /></BreadcrumbProvider>
    </MemoryRouter>,
  ))
  await vi.waitFor(() => expect(deliver).not.toBeNull())
  await act(async () => { deliver!({ type: 'agents:listed', sessions: agents }) })
  return user
}

/** The fixture's Mac, changed as given. */
const mac = (over: Partial<SessionInfo>): SessionInfo[] => [{ ...AGENTS[0]!, ...over }]
const PHONE_ONLY = mac({ capabilities: ['full-reset'], devices: AGENTS[0]!.devices.filter((d) => d.kind === 'physical') })

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

  // A relay from before the phone exemption lists every device it has not brought up, phones included.
  // Mutation: drop `!isPhysical` from `needsMemory` — the phone is greyed out as "Not enough memory to start".
  it('never refuses a plugged-in device for memory, even when the relay lists it', async () => {
    const user = await openDeviceList(mac({ admission: { booting: false, overloaded: false, memoryRefuses: ['00008140-0000000000000001', 'sim-b'] } }))
    await user.click(await screen.findByText('studio-mac'))
    const phone = await screen.findByRole('button', { name: /Test iPhone/ })
    expect(phone).toBeEnabled()
    expect(phone.textContent).toContain('Connected')
    // The simulator it names is still refused: the exemption is the phone's alone.
    expect(screen.getByRole('button', { name: /iPhone SE/ })).toBeDisabled()
  })

  // The relay's `overloaded` says the Mac's simulators would be refused; its phone would not be. Mutations: disable the
  // card whatever is attached (the phone cannot be reached), or let the card open without greying out the simulators
  // (they look available and the relay refuses each one).
  it('opens an overloaded Mac for its plugged-in device and greys out only its simulators', async () => {
    const user = await openDeviceList(mac({ admission: { booting: false, overloaded: true, memoryRefuses: [] } }))
    const card = await screen.findByRole('button', { name: /studio-mac/ })
    expect(card).toBeEnabled()
    await user.click(card)
    const phone = await screen.findByRole('button', { name: /Test iPhone/ })
    expect(phone).toBeEnabled()
    for (const name of [/iPhone 17/, /iPhone SE/]) {
      const sim = screen.getByRole('button', { name })
      expect(sim).toBeDisabled()
      expect(sim.textContent).toContain('This Mac is overloaded')
    }
  })
  // Mutation: open the card for any phone — one that is hidden or busy opens a card where nothing can be picked.
  it.each([
    { name: 'hidden', patch: { hidden: true as const } },
    { name: 'busy', patch: { busy: true } },
  ])('keeps an overloaded Mac closed when its only plugged-in device is $name', async ({ patch }) => {
    const devices = AGENTS[0]!.devices.map((d) => d.kind === 'physical' ? { ...d, ...patch } : d)
    await openDeviceList(mac({ admission: { booting: false, overloaded: true, memoryRefuses: [] }, devices }))
    expect(await screen.findByRole('button', { name: /studio-mac/ })).toBeDisabled()
  })
  // An Admin showing hidden devices sees the hidden phone in the list, so the card opens for it. Mutation: count a
  // hidden phone as unpickable whatever the switch says — the Admin cannot reach a phone the list would show them.
  it('opens an overloaded Mac for its hidden plugged-in device while an Admin shows hidden devices', async () => {
    auth.role = 'Admin'
    try {
      const devices = AGENTS[0]!.devices.map((d) => d.kind === 'physical' ? { ...d, hidden: true as const } : d)
      const other: SessionInfo = {
        ...AGENTS[0]!, agentName: 'build-mac',
        devices: [{ id: 'sim-h', name: 'iPhone 16', platform: 'ios', status: 'shutdown', osVersion: 'iOS 26.3', kind: 'simulator', sessionId: 'sess-h', busy: false, hidden: true }],
      }
      const user = await openDeviceList([{ ...AGENTS[0]!, admission: { booting: false, overloaded: true, memoryRefuses: [] }, devices }, other], { crumbs: true })
      expect(await screen.findByRole('button', { name: /studio-mac/ })).toBeDisabled()
      await user.click(screen.getByRole('button', { name: /build-mac/ }))
      await user.click(await screen.findByRole('switch'))
      await user.click(screen.getByRole('button', { name: '1.0 · build 1' }))
      expect(await screen.findByRole('button', { name: /studio-mac/ })).toBeEnabled()
    } finally {
      auth.role = undefined
    }
  })
  it('keeps an overloaded Mac with no plugged-in device closed', async () => {
    await openDeviceList(mac({ admission: { booting: false, overloaded: true, memoryRefuses: [] }, devices: AGENTS[0]!.devices.filter((d) => d.kind !== 'physical') }))
    expect(await screen.findByRole('button', { name: /studio-mac/ })).toBeDisabled()
  })

  // Mutation: drop the `kind` prop from the page's `DeviceViewer` — the viewer offers a phone every simulator control.
  it('tells the viewer it is driving a plugged-in device', async () => {
    const user = await openDeviceList()
    await user.click(await screen.findByText('studio-mac'))
    await user.click(await screen.findByRole('button', { name: /Test iPhone/ }))
    expect(viewerProps.at(-1)).toMatchObject({ kind: 'physical' })
  })

  // Nothing on a Mac of phones can be erased. Mutation: drop the `filteredDevices.some(...)` clause.
  it('offers no Full reset on a Mac with only plugged-in devices', async () => {
    const user = await openDeviceList(PHONE_ONLY)
    await user.click(await screen.findByText('studio-mac'))
    await screen.findByRole('button', { name: /Test iPhone/ })
    expect(screen.queryByRole('switch')).toBeNull()
  })
  it('offers Full reset on a Mac that also has a simulator', async () => {
    const user = await openDeviceList(mac({ capabilities: ['full-reset'] }))
    await user.click(await screen.findByText('studio-mac'))
    expect(await screen.findByRole('switch')).toBeTruthy()
  })

  // The switch is armed for the next pick, and the next pick is a phone. Mutation: call `consumeResetMode()` with
  // no argument — the phone boots `full-erase`, which its agent refuses.
  it('boots a plugged-in device without erasing it even with Full reset on', async () => {
    const user = await openDeviceList(mac({ capabilities: ['full-reset'] }))
    await user.click(await screen.findByText('studio-mac'))
    await user.click(await screen.findByRole('switch'))
    expect(screen.getByRole('switch')).toBeChecked()
    await user.click(screen.getByRole('button', { name: /Test iPhone/ }))
    expect(viewerProps.at(-1)).toMatchObject({ kind: 'physical', resetMode: 'app-only' })
  })
})
