import { timeDay, timeHour, timeMinute, type TimeInterval } from 'd3-time'
import { RESOURCE_STALE_MS } from '@/lib/resource-health'
import type { AgentResources, SessionInfo } from '@/lib/types'

export type Range = '1h' | '6h' | '24h' | '7d'

export const RANGE_MS: Record<Range, number> = { '1h': 3_600_000, '6h': 21_600_000, '24h': 86_400_000, '7d': 604_800_000 }

/** Tick spacing per range — 1h→10m, 6h→1h, 24h→3h, 7d→1d — as **local** calendar intervals (#749).
 *
 *  They were fixed millisecond steps counted from the epoch, which is UTC: round only where the offset is a
 *  whole multiple of the step, so a 45-minute zone read 07:45, 07:55, and a 7d tick at UTC midnight carried
 *  the previous day's date anywhere west of Greenwich. d3-time's intervals floor on the local fields.
 *
 *  **Across a DST change a gap is uneven, on purpose**: 23 or 25 hours on 7d, 2 or 4 on 24h. The axis is
 *  linear in real time and that day really is that long; holding the step at 24h instead would put every
 *  later tick at 23:00 under the next day's date. */
const TICK_INTERVAL: Record<Range, TimeInterval> = {
  '1h': timeMinute.every(10)!,
  '6h': timeHour,
  '24h': timeHour.every(3)!,
  '7d': timeDay,
}

/** Every tick boundary inside `[minT, maxT]`. `range` is half-open, so the `+ 1` keeps a tick that lands
 *  exactly on `now`. */
export function localTicks(minT: number, maxT: number, range: Range): Date[] {
  return TICK_INTERVAL[range].range(new Date(minT), new Date(maxT + 1))
}

export function formatTick(t: Date | number, range: Range): string {
  const d = new Date(t)
  if (range === '7d') return `${d.getMonth() + 1}/${d.getDate()}`
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** The widest plot the flow cadence is sized for. Sized rather than measured: a narrower plot re-renders a
 *  little more often than it moves, which costs little — every 1.8s on 1h's ~60 rows, and on the longer
 *  ranges no more often than the page's own 10s agent-list render — and no width has to travel from
 *  `ParentSize` up to the page that owns the clock. */
const FLOW_PLOT_PX = 2000

/** How often the axis re-reads the clock: often enough that it never jumps more than a pixel. Bounded below
 *  so a short range cannot spin, and above at ten seconds because the live head's staleness is judged
 *  against this clock: a minute-long tick kept a silent Mac's value up for ~90s on 7d. The agent list that
 *  carries the value arrives every 10s, so the cap adds no renders while it is arriving. */
export function flowIntervalMs(range: Range): number {
  return Math.min(10_000, Math.max(1_000, RANGE_MS[range] / FLOW_PLOT_PX))
}

/** How often the stored history is re-fetched. The relay writes one row a minute, so nothing refreshes
 *  faster than that. The long ranges re-send every row in the window to gain one — about 10,080 on 7d — and
 *  the live head already covers the recent end, so they refresh slowly. */
export const HISTORY_POLL_MS: Record<Range, number> = { '1h': 60_000, '6h': 60_000, '24h': 300_000, '7d': 900_000 }

export const roundPercent = (v: number) => Math.round(v * 10) / 10

export interface LiveHead {
  cpu: number | null
  mem: number | null
}

/** The selected Mac's newest report, if it is fresh — the point that carries each line from the last stored
 *  row to `now`.
 *
 *  **The newest across entries, not the first.** Both agents report `agentName: os.hostname()`, so a Mac
 *  running iOS and Android is listed twice, and the first entry is whichever agent the relay happened to
 *  list first. A series that cannot be computed is `null` rather than `NaN`, which the chart would draw. */
export function liveHeadFor(sessions: SessionInfo[], agentName: string, now: number): LiveHead | null {
  let newest: AgentResources | undefined
  for (const s of sessions) {
    const r = s.agentName === agentName ? s.resources : undefined
    if (r && (!newest || r.reportedAt > newest.reportedAt)) newest = r
  }
  if (!newest || now - newest.reportedAt > RESOURCE_STALE_MS) return null
  const percent = (v: number) => (Number.isFinite(v) ? roundPercent(v) : null)
  return {
    cpu: percent(newest.cpuPercent),
    // A zero total divides to Infinity or NaN, which `percent` already refuses.
    mem: percent((newest.memUsedMB / newest.memTotalMB) * 100),
  }
}
