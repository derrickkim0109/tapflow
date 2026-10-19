import { describe, it, expect, afterEach } from 'vitest'
import { localTicks, formatTick, flowIntervalMs, liveHeadFor, RANGE_MS, type Range } from '@/lib/resource-chart'
import type { AgentResources, SessionInfo } from '@/lib/types'

// **The timezone is part of the input here, so every test names one.** Ticks are placed on the reader's
// local boundaries (#749), and a suite that inherits the machine's zone passes or fails depending on where
// it runs — which is how the UTC alignment stayed invisible: every zone the authors sat in was a whole
// number of hours, and the steps divide an hour. Node reads `process.env.TZ` on every local-time call, so
// switching it inside a test takes effect immediately (measured under this package's vitest).
const ORIGINAL_TZ = process.env.TZ
afterEach(() => {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ
  else process.env.TZ = ORIGINAL_TZ
})
const inZone = (tz: string) => { process.env.TZ = tz }

const ticksFor = (now: number, range: Range) => localTicks(now - RANGE_MS[range], now, range)
const gaps = (ticks: Date[]) => ticks.slice(1).map((t, i) => t.getTime() - ticks[i]!.getTime())
const HOUR = 3_600_000

// Off every step boundary: 02:56:01Z. On a boundary, rounding up and rounding down agree.
const NOW = Date.parse('2026-08-18T02:56:01.000Z')

describe('ticks sit on the reader\'s local boundaries', () => {
  it('lands on the ten-minute marks in a whole-hour zone', () => {
    inZone('Asia/Seoul')
    const ticks = ticksFor(NOW, '1h')
    expect(ticks).toHaveLength(6)
    for (const t of ticks) {
      expect(t.getMinutes() % 10, `${t.toString()} is not a ten-minute mark`).toBe(0)
      expect(t.getSeconds() * 1000 + t.getMilliseconds()).toBe(0)
      expect(t.getTime()).toBeGreaterThanOrEqual(NOW - RANGE_MS['1h'])
      expect(t.getTime()).toBeLessThanOrEqual(NOW)
    }
  })

  it('lands on the ten-minute marks in a 45-minute zone, which UTC alignment put on :45', () => {
    // The #749 reproduction. Aligned in UTC, the labels read 07:45, 07:55, 08:05 here.
    inZone('Asia/Kathmandu')
    const ticks = ticksFor(NOW, '1h')
    expect(ticks).toHaveLength(6)
    for (const t of ticks) expect(t.getMinutes() % 10, formatTick(t, '1h')).toBe(0)
  })

  it('lands on the hour in a 12:45 zone', () => {
    inZone('Pacific/Chatham')
    const ticks = ticksFor(NOW, '6h')
    expect(ticks).toHaveLength(6)
    for (const t of ticks) expect(t.getMinutes(), formatTick(t, '6h')).toBe(0)
  })

  it('puts each 7d tick at local midnight and labels it with that local date', () => {
    // The other half of #749: a tick at UTC midnight is 17:00 the previous day in Los Angeles, so the
    // label named a date the tick did not sit on.
    inZone('America/Los_Angeles')
    const ticks = ticksFor(NOW, '7d')
    expect(ticks).toHaveLength(7)
    for (const t of ticks) expect([t.getHours(), t.getMinutes()], t.toString()).toEqual([0, 0])
    // NOW is 19:56 on 8/17 in Los Angeles, so the newest midnight is the start of 8/17.
    expect(formatTick(ticks[ticks.length - 1]!, '7d')).toBe('8/17')
  })

  it('keeps 7d ticks a whole day apart where there is no DST', () => {
    inZone('Asia/Seoul')
    const ticks = ticksFor(NOW, '7d')
    expect(ticks).toHaveLength(7)
    for (const g of gaps(ticks)) expect(g).toBe(24 * HOUR)
  })

  it('lets one 7d gap be 25 hours across the autumn DST change, without skipping or repeating a date', () => {
    // Decided, not tolerated: the axis is linear in real time, and the day the clocks go back has 25
    // hours in it. Holding the spacing at 24h instead would put every later tick at 23:00 and label it
    // with the wrong date — the defect this alignment exists to remove.
    inZone('America/New_York')
    const now = Date.parse('2026-11-04T17:00:00.000Z') // 12:00 EST
    const ticks = ticksFor(now, '7d')
    expect(ticks.map((t) => formatTick(t, '7d'))).toEqual(['10/29', '10/30', '10/31', '11/1', '11/2', '11/3', '11/4'])
    const g = gaps(ticks)
    expect(g.filter((x) => x === 25 * HOUR), 'the 25-hour day is not where the clocks changed').toHaveLength(1)
    expect(g.filter((x) => x === 24 * HOUR)).toHaveLength(g.length - 1)
  })

  it('lets one 24h gap be two hours across the spring DST change, on local multiples of three', () => {
    inZone('America/New_York')
    const now = Date.parse('2026-03-08T17:30:00.000Z') // 13:30 EDT
    const ticks = ticksFor(now, '24h')
    const labels = ticks.map((t) => formatTick(t, '24h'))
    expect(labels).toEqual(['15:00', '18:00', '21:00', '00:00', '03:00', '06:00', '09:00', '12:00'])
    expect(gaps(ticks).filter((x) => x === 2 * HOUR), '02:00 does not exist that night').toHaveLength(1)
  })

  it('includes both ends when now is exactly on a boundary, and invents nothing past them', () => {
    inZone('Asia/Seoul')
    const now = Date.parse('2026-08-18T03:00:00.000Z') // 12:00 KST
    const ticks = ticksFor(now, '1h')
    expect(ticks).toHaveLength(7)
    expect(ticks[0]!.getTime()).toBe(now - RANGE_MS['1h'])
    expect(ticks[ticks.length - 1]!.getTime()).toBe(now)
  })
})

describe('the axis advances at most a pixel per update', () => {
  it('re-renders often enough that a 2000px plot never jumps more than one pixel', () => {
    // The cadence is sized for the widest plot rather than measured from the real one: a narrower plot
    // then re-renders a little more often than it needs to, which on at most 1440 rows is nothing, and
    // no width has to be threaded from `ParentSize` up to the page.
    expect(flowIntervalMs('1h')).toBe(1_800)
    // Clamped at ten seconds. The live head's staleness is judged against this clock, and a slower one kept
    // a silent Mac's value up for over a minute on the long ranges; the agent list that carries the value
    // arrives every 10s anyway, so the cap adds no renders while it does.
    expect(flowIntervalMs('6h')).toBe(10_000)
    expect(flowIntervalMs('24h')).toBe(10_000)
    expect(flowIntervalMs('7d')).toBe(10_000)
    for (const r of Object.keys(RANGE_MS) as Range[]) {
      expect((flowIntervalMs(r) / RANGE_MS[r]) * 2000, `${r} moves more than a pixel per update`).toBeLessThanOrEqual(1)
    }
  })
})

describe('the live head is the newest fresh sample for the selected Mac', () => {
  const T = Date.parse('2026-08-18T03:00:00.000Z')
  const res = (over: Partial<AgentResources> = {}): AgentResources => ({
    cpuPercent: 42.34, memUsedMB: 8000, memTotalMB: 16000, slotsAvailable: 1, slotsTotal: 1, reportedAt: T - 5_000, ...over,
  })
  const entry = (agentName: string, resources?: AgentResources, platform = 'ios'): SessionInfo => ({
    agentName, platform, capabilities: [], devices: [], resources,
  })

  it('reads CPU and RAM from a fresh sample, rounded the way the history is', () => {
    expect(liveHeadFor([entry('studio-mac', res())], 'studio-mac', T)).toEqual({ cpu: 42.3, mem: 50 })
  })

  it('drops a sample older than the stale threshold, and keeps one exactly at it', () => {
    // The same boundary the QA Session cards use (`> 30_000`), so a Mac is not live on one page and
    // stale on the other.
    expect(liveHeadFor([entry('studio-mac', res({ reportedAt: T - 30_001 }))], 'studio-mac', T)).toBeNull()
    expect(liveHeadFor([entry('studio-mac', res({ reportedAt: T - 30_000 }))], 'studio-mac', T)).not.toBeNull()
  })

  it('has nothing for a Mac that is not listed, or listed without a sample', () => {
    expect(liveHeadFor([entry('other-mac', res())], 'studio-mac', T)).toBeNull()
    expect(liveHeadFor([entry('studio-mac')], 'studio-mac', T)).toBeNull()
  })

  it('takes the newest report when both agents on one Mac are listed under its hostname', () => {
    // Both agents send `agentName: os.hostname()`, so a Mac running iOS and Android lists twice. Taking
    // the first would freeze the head on whichever agent the relay happened to list first.
    const sessions = [
      entry('studio-mac', res({ cpuPercent: 10, reportedAt: T - 10_000 }), 'ios'),
      entry('studio-mac', res({ cpuPercent: 90, reportedAt: T - 3_000 }), 'android'),
    ]
    expect(liveHeadFor(sessions, 'studio-mac', T)?.cpu).toBe(90)
    expect(liveHeadFor([...sessions].reverse(), 'studio-mac', T)?.cpu).toBe(90)
  })

  it('leaves out a series it cannot compute rather than handing NaN to the chart', () => {
    expect(liveHeadFor([entry('studio-mac', res({ memTotalMB: 0 }))], 'studio-mac', T)).toEqual({ cpu: 42.3, mem: null })
    expect(liveHeadFor([entry('studio-mac', res({ cpuPercent: Number.NaN }))], 'studio-mac', T)).toEqual({ cpu: null, mem: 50 })
  })
})
