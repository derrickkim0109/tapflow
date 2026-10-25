import { describe, it, expect, vi } from 'vitest'
import { resetApps, runResetSteps, RESETTABLE_APP_ID } from '../utils/runReset'

describe('runResetSteps', () => {
  it('runs every step, reports each as done or failed, and goes on past a failure', async () => {
    const onError = vi.fn()
    const report = await runResetSteps([
      { item: 'keychain', run: async () => { throw new Error('busy') } },
      { item: 'location', run: async () => {} },
    ], () => false, onError)
    expect(report).toEqual({ done: ['location'], failed: ['keychain'] })
    expect(onError).toHaveBeenCalledWith('keychain', expect.any(Error))
  })

  it('stops when the boot went stale, claiming nothing it did not run', async () => {
    let stale = false
    const later = vi.fn(async () => {})
    const report = await runResetSteps([
      { item: 'keychain', run: async () => { stale = true } },
      { item: 'location', run: later },
    ], () => stale)
    expect(report).toEqual({ done: ['keychain'], failed: [] })
    expect(later).not.toHaveBeenCalled()
  })
})

describe('runResetSteps — the budget', () => {
  // It runs before `device:ready`, so an unbounded reset would outlive the client waiting on the boot.
  it('fails what has not started once the deadline has passed, without running it', async () => {
    const late = vi.fn(async () => {})
    let now = 0
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now)
    try {
      const report = await runResetSteps([
        { item: 'keychain', run: async () => { now = 61_000 } },
        { item: 'location', run: late },
      ], () => false, undefined, 60_000)
      expect(report).toEqual({ done: ['keychain'], failed: ['location'] })
      expect(late).not.toHaveBeenCalled()
    } finally {
      clock.mockRestore()
    }
  })
})

describe('resetApps', () => {
  it('acts on every valid id, and fails the item for one that is not an app id without passing it on', async () => {
    const act = vi.fn(async (_id: string) => {})
    await expect(resetApps(['com.example.app', 'x;reboot', 'com.example.other'], act)).rejects.toThrow('not an app id')
    expect(act.mock.calls.map(([id]) => id)).toEqual(['com.example.app', 'com.example.other'])
  })

  it('stops at the next app once the boot went stale, failing the item', async () => {
    let stale = false
    const act = vi.fn(async (_id: string) => { stale = true })
    await expect(resetApps(['com.a', 'com.b'], act, () => stale)).rejects.toThrow('superseded')
    expect(act).toHaveBeenCalledTimes(1)
  })

  it('accepts the ids both platforms use and nothing a shell would read', () => {
    for (const ok of ['com.example.app', 'com.example.app.debug', 'org.my-app_1']) expect(RESETTABLE_APP_ID.test(ok)).toBe(true)
    for (const bad of ['', 'a b', 'a;b', '$(id)', 'a|b', 'a\nb', '`x`', '-a', '--user', '.hidden']) expect(RESETTABLE_APP_ID.test(bad)).toBe(false)
  })
})
