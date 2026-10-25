import { describe, it, expect } from 'vitest'
import { retryAdmission, admissionRefusalOf, ADMISSION_BACKOFF } from '../admission.js'
import { AdmissionRefusedError, SessionJoinError } from '../RelayClient.js'

/** A clock that only moves when the retry sleeps, so a test runs in no time and reads every wait. */
function fakeTime() {
  let t = 0
  const waits: number[] = []
  return {
    now: () => t,
    sleep: async (ms: number) => { waits.push(ms); t += ms },
    random: () => 0.5, // no jitter
    waits,
  }
}

const refused = () => new AdmissionRefusedError('boot refused (host-booting): busy', 'host-booting')

describe('admissionRefusalOf', () => {
  it('names the two refusals worth waiting for and nothing else', () => {
    expect(admissionRefusalOf(refused())).toBe('host-booting')
    expect(admissionRefusalOf(new SessionJoinError('x', 'agent-resources-exhausted'))).toBe('agent-resources-exhausted')
    expect(admissionRefusalOf(new SessionJoinError('x', 'session-busy'))).toBeNull()
    expect(admissionRefusalOf(new Error('boot failed'))).toBeNull()
  })
})

describe('retryAdmission', () => {
  it('waits out refusals with a doubling backoff and returns what the attempt gave', async () => {
    const time = fakeTime()
    let calls = 0
    const result = await retryAdmission(async () => {
      if (++calls < 4) throw refused()
      return 'booted'
    }, { timeoutMs: 600_000, ...time })
    expect(result).toEqual({ value: 'booted', attempts: 4, waitedMs: 5_000 + 10_000 + 20_000 })
    expect(time.waits).toEqual([5_000, 10_000, 20_000])
  })

  it('stops doubling at the cap', async () => {
    const time = fakeTime()
    let calls = 0
    await retryAdmission(async () => { if (++calls < 6) throw refused() }, { timeoutMs: 600_000, ...time })
    expect(time.waits).toEqual([5_000, 10_000, 20_000, ADMISSION_BACKOFF.maxMs, ADMISSION_BACKOFF.maxMs])
  })

  it('spreads runners refused together', async () => {
    const low = fakeTime(); low.random = () => 0
    const high = fakeTime(); high.random = () => 1
    let a = 0, b = 0
    await retryAdmission(async () => { if (++a < 2) throw refused() }, { timeoutMs: 60_000, ...low })
    await retryAdmission(async () => { if (++b < 2) throw refused() }, { timeoutMs: 60_000, ...high })
    expect(low.waits).toEqual([4_000])
    expect(high.waits).toEqual([6_000])
  })

  it('rethrows any other failure at once', async () => {
    const time = fakeTime()
    await expect(retryAdmission(async () => { throw new Error('Device not found') }, { timeoutMs: 600_000, ...time }))
      .rejects.toThrow('Device not found')
    expect(time.waits).toEqual([])
  })

  it('gives up at the timeout with the refusal and how long it waited', async () => {
    const time = fakeTime()
    const onWait: string[] = []
    const failure = retryAdmission(async () => { throw refused() }, {
      timeoutMs: 20_000, ...time, onWait: (reason, ms) => onWait.push(`${reason} ${ms}`),
    })
    await expect(failure).rejects.toBeInstanceOf(AdmissionRefusedError)
    await expect(failure).rejects.toThrow(/still refused after 20s and 4 attempts/)
    // The last wait is cut to what is left, so the give-up lands on the timeout rather than past it.
    expect(onWait).toEqual(['host-booting 5000', 'host-booting 10000', 'host-booting 5000'])
  })
})
