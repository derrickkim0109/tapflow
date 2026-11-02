import { describe, it, expect, vi } from 'vitest'
import { render, screen, act, within } from '@testing-library/react'
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

describe('QASession — a USB-connected device (#152)', () => {
  /** Opens Connect Physical Device from the Mac screen, as a tester would. */
  async function openPicker(user: ReturnType<typeof userEvent.setup>) {
    await user.click(await screen.findByRole('button', { name: /Connect Physical Device/ }))
    return screen.findByRole('dialog')
  }

  // The issue's flow: phones are reached through their own button, not mixed in with a Mac's simulators. Mutations:
  // count the phone on the Mac card, or list it among the Mac's devices.
  it('keeps a plugged-in device off the Mac card and out of the Mac\'s device list', async () => {
    const user = await openDeviceList()
    const card = await screen.findByRole('button', { name: /studio-mac/ })
    expect(card.textContent).toContain('2 devices')
    expect(card.textContent).not.toContain('USB')
    await user.click(card)
    await screen.findByRole('button', { name: /iPhone 17/ })
    expect(screen.queryByRole('button', { name: /Test iPhone/ })).toBeNull()
  })

  // Mutations: list every device of the platform (the simulators come with it), or drop the Mac's name.
  it('lists the plugged-in devices of every Mac under Connect Physical Device, with the Mac each is on', async () => {
    const other: SessionInfo = {
      ...AGENTS[0]!, agentName: 'build-mac',
      devices: [{ id: '00008140-0000000000000002', name: 'QA iPhone', platform: 'ios', status: 'booted', osVersion: 'iOS 18.6', kind: 'physical', sessionId: 'sess-q', busy: false }],
    }
    const user = await openDeviceList([AGENTS[0]!, other])
    const dialog = await openPicker(user)
    const phones = within(dialog).getAllByRole('listitem').map((li) => li.textContent)
    expect(phones).toHaveLength(2)
    expect(phones[0]).toMatch(/Test iPhone.*iOS 26\.5\.2 · on studio-mac.*Connected/)
    expect(phones[1]).toMatch(/QA iPhone.*on build-mac/)
    expect(within(dialog).queryByText(/iPhone 17|iPhone SE/)).toBeNull()
  })

  // An iOS build cannot go on an Android phone. Mutation: drop the platform check.
  it('offers only the phones of the build\'s platform', async () => {
    const android: SessionInfo = {
      ...AGENTS[0]!, agentName: 'android-mac', platform: 'android',
      devices: [{ id: 'usb:R3CT', name: 'Galaxy', platform: 'android', status: 'booted', kind: 'physical', sessionId: 'sess-g', busy: false }],
    }
    const user = await openDeviceList([AGENTS[0]!, android])
    const dialog = await openPicker(user)
    expect(within(dialog).getAllByRole('listitem')).toHaveLength(1)
    expect(within(dialog).queryByText('Galaxy')).toBeNull()
  })

  it('says how to connect one when none is plugged in', async () => {
    const user = await openDeviceList(mac({ devices: AGENTS[0]!.devices.filter((d) => d.kind !== 'physical') }))
    const dialog = await openPicker(user)
    expect(dialog.textContent).toContain('No iPhone is connected')
    expect(within(dialog).getByRole('link', { name: /How to set one up/ })).toHaveAttribute('href', expect.stringContaining('/operate/usb-iphone'))
  })

  // Mutations: offer a busy phone (the relay refuses the join), or list a hidden one.
  it('greys out a phone in use and leaves out a hidden one', async () => {
    const devices = [
      ...AGENTS[0]!.devices.map((d) => d.kind === 'physical' ? { ...d, busy: true } : d),
      { id: '00008140-0000000000000003', name: 'Shelved iPhone', platform: 'ios', status: 'booted' as const, kind: 'physical' as const, sessionId: 'sess-s', busy: false, hidden: true as const },
    ]
    const user = await openDeviceList(mac({ devices }))
    const dialog = await openPicker(user)
    expect(within(dialog).getByRole('button', { name: /Test iPhone/ })).toBeDisabled()
    expect(within(dialog).queryByText('Shelved iPhone')).toBeNull()
  })

  // A phone runs nothing on the Mac, and the relay lets it in on a loaded one. Mutation: disable the phone when its
  // Mac is overloaded — the tester could not reach the phone at all, since the Mac card is closed.
  it('opens a phone on an overloaded Mac, whose card stays closed', async () => {
    const user = await openDeviceList(mac({ admission: { booting: false, overloaded: true, memoryRefuses: ['00008140-0000000000000001'] } }))
    expect(await screen.findByRole('button', { name: /studio-mac/ })).toBeDisabled()
    const dialog = await openPicker(user)
    await user.click(within(dialog).getByRole('button', { name: /Test iPhone/ }))
    expect(viewerProps.at(-1)).toMatchObject({ kind: 'physical' })
  })

  // Mutation: drop the `kind` prop from the page's `DeviceViewer` — the viewer offers a phone every simulator control.
  it('opens the picked phone on its Mac and tells the viewer it is a plugged-in device', async () => {
    const user = await openDeviceList(undefined, { crumbs: true })
    const dialog = await openPicker(user)
    await user.click(within(dialog).getByRole('button', { name: /Test iPhone/ }))
    expect(viewerProps.at(-1)).toMatchObject({ kind: 'physical' })
    expect(await screen.findByText(/studio-mac/)).toBeInTheDocument()
  })

  // Full reset is armed on a Mac's list and stays armed for the next pick, which may be a phone. Mutation: call
  // `consumeResetMode()` with no argument — the phone boots `full-erase`, which its agent refuses.
  it('boots a plugged-in device without erasing it even with Full reset on', async () => {
    const user = await openDeviceList(mac({ capabilities: ['full-reset'] }), { crumbs: true })
    await user.click(await screen.findByText('studio-mac'))
    await user.click(await screen.findByRole('switch'))
    expect(screen.getByRole('switch')).toBeChecked()
    await user.click(screen.getByRole('button', { name: '1.0 · build 1' }))
    const dialog = await openPicker(user)
    await user.click(within(dialog).getByRole('button', { name: /Test iPhone/ }))
    expect(viewerProps.at(-1)).toMatchObject({ kind: 'physical', resetMode: 'app-only' })
  })
})
