import { describe, it, expect, vi, beforeEach } from 'vitest'

const execFile = vi.fn()
const execFileSync = vi.fn()
vi.mock('child_process', async (orig) => ({ ...(await orig<typeof import('child_process')>()), execFile, execFileSync }))
const launchMuteOnlyTap = vi.fn()
vi.mock('@tapflowio/audiotap-helper', () => ({
  isAudioSupported: () => true,
  ensureHelperApp: () => '/tmp/audiotap-helper.app',
  launchMuteOnlyTap,
}))
vi.mock('../EmulatorLauncher.js', async (orig) => ({
  ...(await orig<typeof import('../EmulatorLauncher.js')>()),
  findEmulatorPid: () => 4242,
}))

const { AndroidAgent } = await import('../AndroidAgent')

type MuteState = { deviceId: string; audioMuteQemuPid: number | null; bootSeq?: number }
type HostMute = {
  startHostMute(state: MuteState): Promise<void>
  stopHostMute(state: MuteState): void
}
const agentFor = () => new AndroidAgent({}, {} as never) as unknown as HostMute

describe('host mute (#341)', () => {
  beforeEach(() => { execFile.mockReset(); execFileSync.mockReset(); launchMuteOnlyTap.mockReset() })

  // A synchronous pkill held the event loop on every device cleanup and relay loss.
  it('stops the mute helper without a synchronous call, and forgets the pid at once', () => {
    const agent = agentFor()
    const state = { deviceId: 'avd:Pixel', audioMuteQemuPid: 4242 }
    agent.stopHostMute(state)
    expect(execFileSync).not.toHaveBeenCalled()
    expect(execFile).toHaveBeenCalledWith('pkill', ['-f', 'audiotap-helper.*--mute-only 4242$'], expect.any(Function))
    expect(state.audioMuteQemuPid).toBeNull()
  })

  // A re-boot of the same emulator keeps its qemu pid, and pkill matches by it: a mute started before the
  // stop finished would be killed by that stop, leaving the Mac's speakers on for the whole session.
  it('waits for a pending stop of the same qemu pid before muting again', async () => {
    let finishStop: () => void = () => {}
    execFile.mockImplementation((_cmd: string, _args: string[], cb: () => void) => { finishStop = cb })
    const agent = agentFor()
    agent.stopHostMute({ deviceId: 'avd:Pixel', audioMuteQemuPid: 4242 })
    const next = { deviceId: 'avd:Pixel', audioMuteQemuPid: null as number | null }
    const started = agent.startHostMute(next)
    await new Promise((r) => setTimeout(r, 20))
    expect(launchMuteOnlyTap).not.toHaveBeenCalled()
    finishStop()
    await started
    expect(launchMuteOnlyTap).toHaveBeenCalledWith('/tmp/audiotap-helper.app', [4242])
    expect(next.audioMuteQemuPid).toBe(4242)
  })

  // While a start waits for the old stop, the session can be shut down or lose the relay; its cleanup finds
  // nothing to stop, so a start that went ahead would mute a device nobody holds.
  it('does not mute after the session moved on while it waited', async () => {
    let finishStop: () => void = () => {}
    execFile.mockImplementation((_cmd: string, _args: string[], cb: () => void) => { finishStop = cb })
    const agent = agentFor()
    agent.stopHostMute({ deviceId: 'avd:Pixel', audioMuteQemuPid: 4242 })
    const next: MuteState = { deviceId: 'avd:Pixel', audioMuteQemuPid: null, bootSeq: 1 }
    const started = agent.startHostMute(next)
    await new Promise((r) => setTimeout(r, 20))
    next.bootSeq = 2 // torn down: shutdown, relay loss or a newer boot
    finishStop()
    await started
    expect(launchMuteOnlyTap).not.toHaveBeenCalled()
    expect(next.audioMuteQemuPid).toBeNull()
  })
})
