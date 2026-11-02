import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import type { DeviceBoot, BrowserToRelay } from '@tapflowio/protocol'
import type { BrowserInbound } from '@/lib/types'

// L5b′. The viewer mints a correlator for every `device:boot` it sends, and then treats the three
// lifecycle replies **differently from each other** — which is the whole content of this file.
//
// `device:ready` is correlated, but with a fallback and only past the first line: an absent correlator
// is accepted, because the relay replays a cached ready to a re-joining viewer and that replay is what
// clears "Starting device…" (#440). `device:boot-error` is not correlated at all, because Android sends
// it for a stream that died mid-session with no boot behind it, and this viewer is the only surface
// that reports it. Getting either of those the other way round reinstates a defect that has already
// shipped: a tab stuck on "Starting device…", or a picture that has simply stopped updating (#426).
const send = vi.fn<(msg: BrowserToRelay) => void>()
let deliver: ((msg: BrowserInbound) => void) | null = null
let frame: ((data: ArrayBuffer) => void) | undefined

vi.mock('@/hooks/useRelay', () => ({
  useRelay: (onMessage: (msg: BrowserInbound) => void, onBinaryFrame?: (data: ArrayBuffer) => void) => {
    deliver = onMessage
    frame = onBinaryFrame
    return { send, connected: true }
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

const boots = () =>
  send.mock.calls.map(([m]) => m).filter((m): m is DeviceBoot => m.type === 'device:boot')

const installs = () => send.mock.calls.filter(([m]) => m.type === 'app:install')

/** The correlator on the most recent boot. Read back rather than invented — a made-up id would only
 *  prove the gate rejects made-up ids, which is a different claim. */
const lastBootId = (): string => {
  const id = boots().at(-1)?.requestId
  expect(id, 'the viewer sent a device:boot with no correlator').toBeTruthy()
  return id!
}

const join = () => act(() => { deliver!({ type: 'session:joined', sessionId: 's1', capabilities: [] }) })

describe('DeviceViewer correlates the lifecycle replies, selectively', () => {
  beforeEach(() => { send.mockClear(); deliver = null })

  it('mints a correlator on the boot it sends after joining', () => {
    render(<DeviceViewer sessionId="s1" deviceId="dev-1" />)
    join()

    expect(boots()).toHaveLength(1)
    expect(typeof boots()[0]!.requestId).toBe('string')
    expect(boots()[0]!.requestId).not.toBe('')
  })

  it('mints a distinct correlator on the re-boot after an agent restart', () => {
    // The two boots are different requests and a rebind can leave the first still in flight, so
    // sharing one id would make the second's reply satisfy the first's record.
    render(<DeviceViewer sessionId="s1" deviceId="dev-1" />)
    join()
    act(() => { deliver!({ type: 'session:rebound', sessionId: 's1', capabilities: [] }) })

    const ids = boots().map((b) => b.requestId)
    expect(ids).toHaveLength(2)
    expect(ids[0]).not.toBe(ids[1])
  })

  it('clears "Starting device…" on a replayed ready that carries no session and no correlator', () => {
    // The relay's replay frame is `{ type, payload }` — no `sessionId`, no `requestId`. This is the
    // defect the replay exists to prevent (#440), so gating the spinner on the correlator would put it
    // straight back, and nothing else in the product would report it.
    render(<DeviceViewer sessionId="s1" deviceId="dev-1" />)
    join()
    expect(screen.getByText('Starting device…')).toBeTruthy()

    act(() => { deliver!({ type: 'device:ready', payload: { deviceId: 'dev-1' } }) })

    expect(screen.queryByText('Starting device…')).toBeNull()
  })

  it('reports an uncorrelated boot-error, because that is the only kind Android sends unsolicited', () => {
    // `AndroidAgent.restartVideoStream` sends this for a stream that died mid-session. There is no
    // `device:boot` behind it, so it can never carry an id — and this branch is the only surface that
    // reports it. Gate it on `bootIdsRef` and a dead stream becomes a picture that has stopped
    // updating with nothing said, which is what #426 was opened about.
    render(<DeviceViewer sessionId="s1" deviceId="dev-1" />)
    join()

    act(() => { deliver!({ type: 'device:boot-error', sessionId: 's1', message: 'scrcpy failed to restart' }) })

    expect(screen.getByText(/Boot failed: scrcpy failed to restart/)).toBeTruthy()
  })

  // Mutation: keep the report once frames arrive again. A phone that was locked and is unlocked streams again, and
  // the card would go on saying the device failed for the rest of the session.
  it('clears an uncorrelated report once frames arrive again, and only that kind', () => {
    render(<DeviceViewer sessionId="s1" deviceId="dev-1" />)
    join()
    act(() => { deliver!({ type: 'device:boot-error', sessionId: 's1', message: 'Screen capture: no screen capture device' }) })
    expect(screen.getByText(/Boot failed: Screen capture/)).toBeTruthy()
    act(() => { frame!(new Uint8Array([0, 0, 0, 1, 0x65]).buffer) })
    expect(screen.queryByText(/Boot failed/)).toBeNull()

    // A boot that failed did not start a stream, so a stray frame does not take its report away.
    join()
    act(() => { deliver!({ type: 'device:boot-error', sessionId: 's1', requestId: lastBootId(), message: 'simctl boot failed' }) })
    act(() => { frame!(new Uint8Array([0, 0, 0, 1, 0x65]).buffer) })
    expect(screen.getByText(/Boot failed: simctl boot failed/)).toBeTruthy()
  })

  // Mutation: let a stream failure outrank the install. The tester who just picked a build would read about the
  // screen while the install they are waiting on goes unmentioned.
  it('says an install is under way rather than an earlier stream failure', () => {
    render(<DeviceViewer sessionId="s1" deviceId="dev-1" buildId={7} />)
    join()
    act(() => { deliver!({ type: 'device:ready', sessionId: 's1', requestId: lastBootId(), payload: { deviceId: 'dev-1' } }) })
    expect(installs()).toHaveLength(1)
    act(() => { deliver!({ type: 'device:boot-error', sessionId: 's1', message: 'Screen capture: no screen capture device' }) })
    expect(screen.getByText('Installing app…')).toBeTruthy()
    expect(screen.queryByText(/Boot failed/)).toBeNull()
  })

  it('says nothing about a boot it has already replaced', () => {
    // **This assertion used to run the other way, and #526 is what turned it.** It read "reports a
    // boot-error whose correlator matches nothing this viewer sent", stated so the rule would fail under a
    // correlating gate and not only under a presence check. What made that safe was that the only
    // correlated boot-errors came from boots this viewer was still waiting on: an agent that abandoned one
    // sent nothing at all. Both agents now answer an abandoned boot, so the id of a boot this viewer
    // *replaced* arrives as a failure — and reporting it puts "Boot failed" on screen while the boot that
    // replaced it is running normally.
    //
    // The prohibition it was defending is untouched and sits in the test above: an **uncorrelated**
    // boot-error is still reported, which is the only kind #426 is about.
    render(<DeviceViewer sessionId="s1" deviceId="dev-1" />)
    join()

    act(() => {
      deliver!({ type: 'device:boot-error', sessionId: 's1', requestId: 'not-ours', message: 'agent offline' })
    })

    expect(screen.queryByText(/Boot failed/)).toBeNull()
  })

  it('still says nothing when the replaced boot is one this viewer sent', () => {
    // **Why the gate reads the latest id and not `bootIdsRef` membership**, which is the shape that looks
    // equivalent and is the one to reach for. A rebind adds its boot to that set *without clearing it*, so
    // both ids are members — and the superseded one is exactly the id an agent now answers. Membership
    // then says "mine, report it" and puts "Boot failed" on screen while the rebind's own boot is running.
    //
    // Its twin is the reconnect, where the set is cleared and the still-running boot's id falls *out* of
    // it: membership drops that one for the wrong reason and happens to agree. One case each way is what
    // makes the two rules distinguishable, so this is the one that has to be here.
    render(<DeviceViewer sessionId="s1" deviceId="dev-1" />)
    join()
    const first = lastBootId()
    act(() => { deliver!({ type: 'session:rebound', sessionId: 's1', capabilities: [] }) })
    expect(lastBootId(), 'the rebind did not send its own boot').not.toBe(first)

    act(() => {
      deliver!({ type: 'device:boot-error', sessionId: 's1', requestId: first, message: 'superseded' })
    })

    expect(screen.queryByText(/Boot failed/)).toBeNull()
  })

  it('reports the failure of the boot it is actually waiting on', () => {
    // The other half, and the one that keeps the gate from being a mute button: the latest boot's own
    // failure is what the tester needs, and it is what `setBootError` is for.
    render(<DeviceViewer sessionId="s1" deviceId="dev-1" />)
    join()

    act(() => {
      deliver!({ type: 'device:boot-error', sessionId: 's1', requestId: lastBootId(), message: 'agent offline' })
    })

    expect(screen.getByText(/Boot failed: agent offline/)).toBeTruthy()
  })

  it('acts on a ready that answers its own boot', () => {
    render(<DeviceViewer sessionId="s1" deviceId="dev-1" buildId={7} />)
    join()

    act(() => {
      deliver!({ type: 'device:ready', sessionId: 's1', requestId: lastBootId(), payload: { deviceId: 'dev-1' } })
    })

    expect(installs()).toHaveLength(1)
  })

  it('installs after the agent\'s real boot sequence — booting, then the correlated ready', () => {
    // **The production ordering, which no other test here exercises.** Both agents send `device:booting`
    // before the `device:ready` that answers the same boot (`IOSAgent.ts:560` → `:639`,
    // `AndroidAgent.ts:863` → `:916`), so the boot id has to survive that message. Adding
    // `bootIdsRef.current.clear()` to that branch — which the comment above it invites, since it is where
    // every other per-cycle record is dropped — rejects every real ready. And the failure is silent:
    // `setDeviceReady(true)` runs ahead of the gate, so the spinner clears and the device looks healthy
    // while the app is never installed and the Launch control never appears.
    render(<DeviceViewer sessionId="s1" deviceId="dev-1" buildId={7} />)
    join()
    const id = lastBootId()

    act(() => { deliver!({ type: 'device:booting', sessionId: 's1' }) })
    act(() => { deliver!({ type: 'device:ready', sessionId: 's1', requestId: id, payload: { deviceId: 'dev-1' } }) })

    expect(installs()).toHaveLength(1)
  })

  it('releases the rebind on the re-boot\'s own reply', () => {
    // The sibling test compares the two minted ids by reading `send`, so it cannot see whether the second
    // was ever *recorded*. Drop `bootIdsRef.current.add(rebootId)` and every assertion there still passes
    // while #426's recovery stops working: the new agent's ready is rejected as a straggler,
    // `rebindRef.pending` never falls, and the viewer keeps the picture but loses its controls.
    //
    // Staged as a rebind landing mid-install, so `appInstalled` is false and the reply falls through to a
    // reinstall — an observable second `app:install` rather than a flag with no surface here.
    render(<DeviceViewer sessionId="s1" deviceId="dev-1" buildId={7} />)
    join()
    act(() => {
      deliver!({ type: 'device:ready', sessionId: 's1', requestId: lastBootId(), payload: { deviceId: 'dev-1' } })
    })
    expect(installs()).toHaveLength(1)

    act(() => { deliver!({ type: 'session:rebound', sessionId: 's1', capabilities: [] }) })
    act(() => {
      deliver!({ type: 'device:ready', sessionId: 's1', requestId: lastBootId(), payload: { deviceId: 'dev-1' } })
    })

    expect(installs()).toHaveLength(2)
  })

  it('stops accepting an earlier cycle\'s ready once a new join has started one', () => {
    // `session:joined` arrives again on every socket reconnect, and it clears the set for the same reason
    // it resets `rebindRef`: a boot from the cycle that just ended will never be answered now. Without
    // the clear, that cycle's straggling ready passes the gate after the new join and fires a second
    // `app:install` on top of one already in flight.
    render(<DeviceViewer sessionId="s1" deviceId="dev-1" buildId={7} />)
    join()
    const stale = lastBootId()

    join() // a reconnect: same mount, new cycle, new boot
    expect(lastBootId()).not.toBe(stale)

    act(() => { deliver!({ type: 'device:ready', sessionId: 's1', requestId: stale, payload: { deviceId: 'dev-1' } }) })

    expect(installs()).toHaveLength(0)
  })

  it('ignores a ready carrying a correlator from some other boot', () => {
    // A straggler from an earlier boot cycle: without this it releases the current rebind and installs
    // on top of an install already in flight. Only a *mismatched* id is rejected — absent is still
    // accepted (the test below), so the relay's replayed ready is **not** covered by this and the
    // duplicate-install-on-re-join case the `device:booting` comment describes is unchanged.
    render(<DeviceViewer sessionId="s1" deviceId="dev-1" buildId={7} />)
    join()

    act(() => {
      deliver!({ type: 'device:ready', sessionId: 's1', requestId: 'stale-cycle', payload: { deviceId: 'dev-1' } })
    })

    expect(installs()).toHaveLength(0)
    // The spinner still clears: that line sits ahead of the correlator on purpose, so a stale ready is
    // ignored without leaving the tester staring at a device that is in fact up.
    expect(screen.queryByText('Starting device…')).toBeNull()
  })

  it('accepts a ready with no correlator at all, so an agent predating the echo still works', () => {
    render(<DeviceViewer sessionId="s1" deviceId="dev-1" buildId={7} />)
    join()

    act(() => { deliver!({ type: 'device:ready', sessionId: 's1', payload: { deviceId: 'dev-1' } }) })

    expect(installs()).toHaveLength(1)
  })

  it('answers only once when the same boot is answered twice', () => {
    // The correlator is consumed by the reply that matches it — `delete`, not `has` — so a duplicate
    // carrying the same id is rejected by the second lookup. Distinct from the replay case: that one is
    // id-less and still gets through, which the two tests above this one hold in place.
    render(<DeviceViewer sessionId="s1" deviceId="dev-1" buildId={7} />)
    join()
    const id = lastBootId()

    act(() => { deliver!({ type: 'device:ready', sessionId: 's1', requestId: id, payload: { deviceId: 'dev-1' } }) })
    act(() => { deliver!({ type: 'device:ready', sessionId: 's1', requestId: id, payload: { deviceId: 'dev-1' } }) })

    expect(installs()).toHaveLength(1)
  })
})

// L2 S2-c. The relay holds a person's boot while another device on the same Mac is starting, and says so with
// `device:boot-waiting`. Correlated strictly: there is no unsolicited producer, and a reconnect re-sends the boot,
// so the waiting notice of a boot this viewer replaced must not be shown.
describe('DeviceViewer says when its boot is waiting for another device on the Mac', () => {
  beforeEach(() => { send.mockClear(); deliver = null })
  const WAITING = 'Another device is starting on this Mac. Yours starts next…'

  it('shows the wait for its own boot, and drops it when the boot starts', () => {
    render(<DeviceViewer sessionId="s1" deviceId="dev-1" />)
    join()
    act(() => { deliver!({ type: 'device:boot-waiting', sessionId: 's1', requestId: lastBootId(), until: Date.now() + 60_000 }) })
    expect(screen.getByText(WAITING)).toBeTruthy()

    act(() => { deliver!({ type: 'device:booting', sessionId: 's1' }) })
    expect(screen.queryByText(WAITING)).toBeNull()
    expect(screen.getByText('Starting device…')).toBeTruthy()
  })

  // A restart: the device was up, the viewer re-boots it, and the relay holds that boot. The wait must show even
  // though the last cycle left the viewer ready.
  it('shows the wait for a re-boot of a device that was up', () => {
    render(<DeviceViewer sessionId="s1" deviceId="dev-1" />)
    join()
    act(() => { deliver!({ type: 'device:ready', sessionId: 's1', requestId: lastBootId(), payload: { deviceId: 'dev-1' } }) })
    expect(screen.queryByText('Starting device…')).toBeNull()
    join() // re-boot with a new correlator
    act(() => { deliver!({ type: 'device:boot-waiting', sessionId: 's1', requestId: lastBootId(), until: Date.now() + 60_000 }) })
    expect(screen.getByText(WAITING)).toBeTruthy()
  })

  it('drops the last cycle\'s failure when a new boot starts waiting', () => {
    render(<DeviceViewer sessionId="s1" deviceId="dev-1" />)
    join()
    act(() => { deliver!({ type: 'device:boot-error', sessionId: 's1', message: 'scrcpy failed to restart' }) })
    join() // the tester restarts: a new boot, held behind another device
    act(() => { deliver!({ type: 'device:boot-waiting', sessionId: 's1', requestId: lastBootId(), until: Date.now() + 60_000 }) })
    expect(screen.queryByText(/Boot failed/)).toBeNull()
    expect(screen.getByText(WAITING)).toBeTruthy()
  })

  it('ignores the wait of a boot it has replaced', () => {
    render(<DeviceViewer sessionId="s1" deviceId="dev-1" />)
    join()
    const replaced = lastBootId()
    join()
    expect(lastBootId()).not.toBe(replaced)
    act(() => { deliver!({ type: 'device:boot-waiting', sessionId: 's1', requestId: replaced, until: Date.now() + 60_000 }) })
    expect(screen.queryByText(WAITING)).toBeNull()
  })

  it('lets a failure replace the wait', () => {
    render(<DeviceViewer sessionId="s1" deviceId="dev-1" />)
    join()
    const id = lastBootId()
    act(() => { deliver!({ type: 'device:boot-waiting', sessionId: 's1', requestId: id, until: Date.now() + 60_000 }) })
    act(() => { deliver!({ type: 'device:boot-error', sessionId: 's1', requestId: id, message: 'agent offline' }) })
    expect(screen.queryByText(WAITING)).toBeNull()
    expect(screen.getByText(/Boot failed: agent offline/)).toBeTruthy()
  })

  // The relay's memory safety valve holds a person's boot too, and says why, so the tester is not told a device is
  // starting when none is. A later notice for the same boot replaces the reason: a held boot can move from one wait
  // to the other.
  it('says the Mac is low on memory when that is what the boot waits for', () => {
    const LOW = 'This Mac is low on memory. Yours starts when it frees up…'
    render(<DeviceViewer sessionId="s1" deviceId="dev-1" />)
    join()
    const id = lastBootId()
    act(() => { deliver!({ type: 'device:boot-waiting', sessionId: 's1', requestId: id, until: Date.now() + 60_000, reason: 'host-memory-critical' }) })
    expect(screen.getByText(LOW)).toBeTruthy()
    expect(screen.queryByText(WAITING)).toBeNull()

    act(() => { deliver!({ type: 'device:boot-waiting', sessionId: 's1', requestId: id, until: Date.now() + 60_000, reason: 'host-booting' }) })
    expect(screen.getByText(WAITING)).toBeTruthy()
    expect(screen.queryByText(LOW)).toBeNull()
  })
})

// L2 S2b-2. A run's `--service-tier slim` stays on the device until it restarts; a person who picks it is told.
describe('DeviceViewer says when a device came up with most services off', () => {
  beforeEach(() => { send.mockClear(); deliver = null })
  const NOTE = /most background services off/

  it('says so from the ready, keeps it through a replay, and drops it when the device boots again', () => {
    render(<DeviceViewer sessionId="s1" deviceId="dev-1" />)
    join()
    act(() => { deliver!({ type: 'device:ready', sessionId: 's1', requestId: lastBootId(), payload: { deviceId: 'dev-1', serviceTier: { name: 'slim', keep: [] } } }) })
    expect(screen.getByText(NOTE)).toBeTruthy()
    act(() => { deliver!({ type: 'device:ready', payload: { deviceId: 'dev-1' } }) }) // the relay's replay: no tier
    expect(screen.getByText(NOTE)).toBeTruthy()
    act(() => { deliver!({ type: 'device:booting', sessionId: 's1' }) })
    expect(screen.queryByText(NOTE)).toBeNull()
  })

  it('ignores the tier on a late ready from a boot it has replaced', () => {
    render(<DeviceViewer sessionId="s1" deviceId="dev-1" />)
    join()
    const replaced = lastBootId()
    join()
    act(() => { deliver!({ type: 'device:ready', sessionId: 's1', requestId: lastBootId(), payload: { deviceId: 'dev-1', serviceTier: { name: 'lean', keep: [] } } }) })
    act(() => { deliver!({ type: 'device:ready', sessionId: 's1', requestId: replaced, payload: { deviceId: 'dev-1', serviceTier: { name: 'slim', keep: [] } } }) })
    expect(screen.queryByText(NOTE)).toBeNull()
  })

  it('says nothing for a device on its usual services', () => {
    render(<DeviceViewer sessionId="s1" deviceId="dev-1" />)
    join()
    act(() => { deliver!({ type: 'device:ready', sessionId: 's1', requestId: lastBootId(), payload: { deviceId: 'dev-1', serviceTier: { name: 'lean', keep: [] } } }) })
    expect(screen.queryByText(NOTE)).toBeNull()
  })
})
