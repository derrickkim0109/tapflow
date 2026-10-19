import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { render, fireEvent } from '@testing-library/react'
import { AreaChartInner } from '@/src/pages/MacResources'

// **The series is clipped to the plot, and this is what says so.** The window runs `now - interval` to
// `now`, and the samples inside it are selected by the relay from *its* clock — two clocks that are only
// ever approximately equal. A relay running behind returns points older than the window's left edge, and
// `scaleTime` does not clamp: they map to a negative x and the area paints straight through the tick
// labels. It showed worst on RAM, which sits at ~57% right where "50%" and "25%" are.
//
// **This used to rest on the window reaching past the data rather than the other way round.** The right
// edge was rounded up to a clean tick (`ceil(now / step) * step`), which pushed the left edge a full step
// later than the oldest sample the relay returns. That round-up is gone — it also put the axis up to a
// step into the future, which is what the block below measures. The clip is still load-bearing; what
// reaches past the plot is now the data.
//
// Rendered directly rather than through the page: `ParentSize` measures 0 in jsdom, so `ChartCard` renders
// nothing there and a test of the page would assert against an empty div.

const AT = Date.parse('2026-08-18T02:55:00.000Z')

/** How far the relay's clock trails the dashboard's — the reason a sample can precede the window. */
const RELAY_LAG_MS = 5 * 60_000

/** One sample per minute across the relay's last hour, which begins before the dashboard's window does. */
const series = Array.from({ length: 60 }, (_, i) => {
  const t = AT - RELAY_LAG_MS - (59 - i) * 60_000
  return { time: new Date(t).toISOString(), cpu: 20, mem: 57 }
})

const paths = (c: HTMLElement) => [...c.querySelectorAll('path')].map((p) => p.getAttribute('d') ?? '')
const xs = (d: string) => [...d.matchAll(/[ML]\s*(-?[\d.]+)/g)].map((m) => Number(m[1]))

describe('the resource chart does not paint over its own axis', () => {
  it('has samples that fall left of the plot — the premise, measured', () => {
    // Without this the test below could pass on a chart that simply has nothing to clip.
    const before = series.filter((d) => Date.parse(d.time) < AT - 3_600_000)
    expect(before.length, 'no sample precedes the window — raise `RELAY_LAG_MS`').toBeGreaterThan(0)
  })

  it('draws the series inside a clip that starts at the axis', () => {
    const { container } = render(
      <AreaChartInner width={600} height={220} data={series} dataKey="cpu" hex="#60a5fa" range="1h" now={AT} label="CPU %" />,
    )

    const clipped = container.querySelector('g[clip-path]')
    expect(clipped, 'the series is not clipped').not.toBeNull()
    expect(clipped!.querySelectorAll('path').length, 'the area and the line are both inside the clip').toBe(2)

    const rect = container.querySelector('clipPath rect')!
    expect(rect.getAttribute('x'), 'the clip must start at the axis, not left of it').toBe('0')
    expect(Number(rect.getAttribute('width'))).toBeGreaterThan(0)
  })

  it('and the geometry it clips really does reach past the axis', () => {
    // The other half: if the scale ever started clamping, the clip would be inert and this file would go on
    // reporting success for a fix that no longer does anything.
    const { container } = render(
      <AreaChartInner width={600} height={220} data={series} dataKey="mem" hex="#a78bfa" range="1h" now={AT} label="RAM %" />,
    )
    const drawn = paths(container).flatMap(xs)
    expect(drawn.length, 'no path geometry was rendered').toBeGreaterThan(0)
    expect(Math.min(...drawn), 'nothing extends past the axis — the clip is guarding nothing').toBeLessThan(0)
  })
})

describe('the chart does not draw time that has not arrived', () => {
  // `ceil(now / step) * step` ended the window at the *next* round tick, which left up to a full step of
  // axis in the future — an hour of empty 6h chart, ten hours of empty 7d. No sample can ever land there,
  // so the band read as missing data rather than as the edge of the window.
  //
  // Measured on the geometry, not the labels: the newest sample is at `now`, so it belongs at the plot's
  // right edge, and under the old window it stopped short of it by the size of the gap.
  // The plot's full width: the window's edges are the grid's edges, with no horizontal padding
  // between them. `INSET` is vertical headroom only.
  const RIGHT_EDGE = 600 - 40 - 24 // width - MARGIN.left - MARGIN.right
  /** How far past an edge a tick is still drawn: half a label, while some of it overlaps the plot. */
  const LABEL_HALF = 20
  const STEP: Record<string, number> = { '1h': 600_000, '6h': 3_600_000, '24h': 10_800_000, '7d': 86_400_000 }

  // **Pinned to a whole-hour zone with no DST**, so `span / STEP` ticks is exact and the anchor below has
  // one right answer. What happens in 45-minute zones and across DST is `resourceChart.test.ts`.
  const ORIGINAL_TZ = process.env.TZ
  beforeAll(() => { process.env.TZ = 'Asia/Seoul' })
  afterAll(() => {
    if (ORIGINAL_TZ === undefined) delete process.env.TZ
    else process.env.TZ = ORIGINAL_TZ
  })

  /** The last local step boundary at or before `t`, from `Date` setters — deliberately not `d3-time`, so
   *  the assertion does not share an implementation with the code it checks. */
  const lastLocalBoundary = (t: number, range: string) => {
    const d = new Date(t)
    d.setSeconds(0, 0)
    if (range === '1h') d.setMinutes(Math.floor(d.getMinutes() / 10) * 10)
    else {
      d.setMinutes(0)
      if (range === '24h') d.setHours(Math.floor(d.getHours() / 3) * 3)
      if (range === '7d') d.setHours(0)
    }
    return d.getTime()
  }

  // Off every step boundary. On one, `ceil` and `floor` agree and the defect hides.
  const NOW = Date.parse('2026-08-18T02:55:00.000Z') + 61_000

  /** Where a moment in the window lands on the axis — the mapping `scaleTime` is handed. */
  const xOf = (t: number, span: number) => ((t - (NOW - span)) / span) * RIGHT_EDGE
  const tickXs = (c: HTMLElement) =>
    [...c.querySelectorAll('.visx-axis-bottom text')].map((t) => Number(t.getAttribute('x')))

  it.each([
    ['1h', 3_600_000],
    ['6h', 21_600_000],
    ['24h', 86_400_000],
    ['7d', 604_800_000],
  ] as const)('reaches the right edge with the newest sample on %s', (range, span) => {
    const data = Array.from({ length: 12 }, (_, i) => ({
      time: new Date(NOW - (11 - i) * (span / 11)).toISOString(),
      cpu: 20,
      mem: 57,
    }))
    const { container } = render(
      <AreaChartInner width={600} height={220} data={data} dataKey="cpu" hex="#60a5fa" range={range} now={NOW} label="CPU %" />,
    )
    const drawn = paths(container).flatMap(xs)
    expect(drawn.length, 'no path geometry was rendered').toBeGreaterThan(0)
    expect(Math.max(...drawn), 'the newest sample stops short of the edge — the window runs past `now`')
      .toBeCloseTo(RIGHT_EDGE, 3)

    // **The tick arithmetic itself, which the label assertions cannot reach.** Every candidate tick is a
    // round step, so `tickCount ± 1` changes no label's shape and no format check can see it — measured,
    // `+ 2` and one fewer each left all 34 tests green.
    // A tick past either edge is drawn while its label still overlaps the plot, and no further: the axis
    // is masked to the plot's width, and a tick beyond that reach is one that once put a label at x = -34
    // across the y-axis labels.
    const tickX = tickXs(container)
    const inside = tickX.filter((x) => x >= 0 && x <= RIGHT_EDGE)
    expect(inside.length, 'a tick was invented or dropped').toBe(span / STEP[range])
    expect(Math.min(...tickX), 'a tick was drawn after its label left the plot').toBeGreaterThanOrEqual(-LABEL_HALF)
    expect(Math.max(...tickX), 'a tick was drawn before its label reached the plot').toBeLessThanOrEqual(RIGHT_EDGE + LABEL_HALF)
    expect(inside[inside.length - 1], 'the newest tick is not the last local boundary at or before `now`')
      .toBeCloseTo(xOf(lastLocalBoundary(NOW, range), span), 3)
  })

  it('fills the grid it is drawn in, at both ends', () => {
    // **What a tester saw: the dashed rows running past the data at each end.** The x scale was inset
    // by 16px on both sides while `GridRows` spanned the whole plot, so the grid framed a strip at each
    // edge that no sample can ever reach. Same reading as the axis running past `now` — empty because
    // nothing can go there, which looks like missing data — from the other cause.
    //
    // Measured **against the grid** rather than against a constant, because the defect was the two
    // disagreeing: an assertion on either one alone passes while they drift apart.
    const data = Array.from({ length: 12 }, (_, i) => ({
      time: new Date(NOW - (11 - i) * (3_600_000 / 11)).toISOString(),
      cpu: 20,
      mem: 57,
    }))
    const { container } = render(
      <AreaChartInner width={600} height={220} data={data} dataKey="cpu" hex="#60a5fa" range="1h" now={NOW} label="CPU %" />,
    )
    const grid = [...container.querySelectorAll('.visx-rows line')]
    expect(grid.length, 'no grid rows were drawn, so this compares nothing').toBeGreaterThan(0)
    const gridLeft = Math.min(...grid.map((l) => Number(l.getAttribute('x1'))))
    const gridRight = Math.max(...grid.map((l) => Number(l.getAttribute('x2'))))

    const drawn = paths(container).flatMap(xs)
    expect(Math.min(...drawn), 'the grid reaches left of anything the window can hold').toBeCloseTo(gridLeft, 3)
    expect(Math.max(...drawn), 'the grid reaches right of anything the window can hold').toBeCloseTo(gridRight, 3)
  })

  it('still spaces the ticks a whole step apart, which is what the round-up was for', () => {
    // The other half. Ending the window at `now` must not drag the ticks off the clean step with it —
    // dropping the round-up and letting the ticks fall where the window ends would trade this defect for
    // an axis reading 14:03, 14:13, 14:23.
    //
    // **Measured on the geometry, in a pinned zone.** The ticks used to be round in UTC, and asserting
    // digits made this file red on an unmodified checkout in Asia/Kathmandu — the machine's clock decided
    // the result. They are local now (#749), so the zone is part of the input and this block names one.
    const data = Array.from({ length: 12 }, (_, i) => ({
      time: new Date(NOW - (11 - i) * (3_600_000 / 11)).toISOString(),
      cpu: 20,
      mem: 57,
    }))
    const { container } = render(
      <AreaChartInner width={600} height={220} data={data} dataKey="cpu" hex="#60a5fa" range="1h" now={NOW} label="CPU %" />,
    )
    const tickX = tickXs(container)
    expect(tickX.length, 'no time labels were rendered').toBeGreaterThan(1)
    // One step of window, in pixels. Every gap is this, so no tick sits at an arbitrary offset.
    const perStep = (STEP['1h'] / 3_600_000) * RIGHT_EDGE
    for (const [i, x] of tickX.slice(1).entries()) {
      expect(x - tickX[i], 'the ticks are no longer a whole step apart').toBeCloseTo(perStep, 3)
    }
    expect(tickX[tickX.length - 1], 'the ticks are evenly spaced but off the round step')
      .toBeCloseTo(xOf(lastLocalBoundary(NOW, '1h'), 3_600_000), 3)
  })

  it('lets a label straddle either edge and fades the axis there, the same on both sides', () => {
    // The window advances, so a tick enters on the right and leaves on the left. The window's span is a
    // whole number of steps, so a tick just inside one edge always has a twin just *outside* the other:
    // drawing only the ticks inside the window showed a label fading at the right edge while its twin on
    // the left had already vanished — the left edge always looked empty.
    // So a tick is drawn while its label overlaps the plot, and the fade is a mask over the axis rather than
    // an opacity per label: a straddling label is cut and faded glyph by glyph, and nothing past the
    // plot's width can paint over the y-axis labels.
    const onBoundary = Date.parse('2026-08-18T03:00:00.000Z') // 12:00 KST
    const data = [{ time: new Date(onBoundary - 60_000).toISOString(), cpu: 20, mem: 57 }]
    const perMinute = RIGHT_EDGE / 60
    const labels = (now: number) => {
      const { container, unmount } = render(
        <AreaChartInner width={600} height={220} data={data} dataKey="cpu" hex="#60a5fa" range="1h" now={now} label="CPU %" />,
      )
      const out = [...container.querySelectorAll('.visx-axis-bottom text')].map((t) => ({
        text: t.textContent,
        x: Number(t.getAttribute('x')),
        anchor: t.getAttribute('text-anchor'),
      }))
      const masked = container.querySelector('.visx-axis-bottom')?.closest('g[mask]')?.getAttribute('mask') ?? ''
      const mask = container.querySelector(`mask#${/url\(#([^)]+)\)/.exec(masked)?.[1] ?? 'none'}`)
      // By id, not by `linearGradient`: jsdom's selector engine lowercases type selectors, and SVG's
      // mixed-case element names then match nothing — an empty list that would pass any `every` check.
      const gradientId = /url\(#([^)]+)\)/.exec(mask?.querySelector('rect')?.getAttribute('fill') ?? '')?.[1] ?? 'none'
      const stops = [...(container.querySelector(`[id="${gradientId}"]`)?.querySelectorAll('stop') ?? [])]
        .map((s) => Number(s.getAttribute('stop-opacity')))
      const region = mask?.querySelector('rect')
      unmount()
      return { out, mask, stops, region }
    }

    // A minute past 12:00: 11:00 has just left on the left, 12:00 has just arrived on the right.
    const { out, mask, stops, region } = labels(onBoundary + 60_000)
    const left = out.find((l) => l.text === '11:00')
    const right = out.find((l) => l.text === '12:00')
    expect(left, 'the label leaving on the left was not drawn').toBeDefined()
    expect(right, 'the label arriving on the right was not drawn').toBeDefined()
    expect(left!.x).toBeCloseTo(-perMinute, 3)
    expect(right!.x).toBeCloseTo(RIGHT_EDGE - perMinute, 3)
    for (const l of out) expect(l.anchor, 'an edge label is still anchored inward').toBe('middle')

    expect(mask, 'the axis is not masked').not.toBeNull()
    expect(region?.getAttribute('x'), 'the mask does not start at the plot').toBe('0')
    expect(Number(region?.getAttribute('width')), 'the mask is not the plot\'s width').toBe(RIGHT_EDGE)
    expect(stops, 'the mask does not fade out at both ends and stay clear between').toEqual([0, 1, 1, 0])

    // Three minutes past, 11:00 is ~25px outside — its whole label is off the plot, so it is not drawn.
    expect(labels(onBoundary + 180_000).out.find((l) => l.text === '11:00'), 'a label wholly off the plot was drawn').toBeUndefined()
  })
})

describe('the line reaches now through the live sample', () => {
  // The relay writes one averaged row a minute, so the newest stored row trails `now` by up to a minute —
  // ~8px on the 1h range. With the window's edge pinned to `now` that reads as a line that stops early
  // and catches up once a minute. The agent's latest report closes the gap without being stored.
  const RIGHT_EDGE = 600 - 40 - 24
  const NOW = AT + 61_000
  const flushed = Array.from({ length: 12 }, (_, i) => ({
    time: new Date(NOW - 45_000 - (11 - i) * 300_000).toISOString(),
    cpu: 20,
    mem: 57,
  }))
  type Props = Partial<Parameters<typeof AreaChartInner>[0]>
  const element = (props: Props = {}) =>
    <AreaChartInner width={600} height={220} data={flushed} dataKey="cpu" hex="#60a5fa" range="1h" now={NOW} label="CPU %" {...props} />
  const chart = (props: Props = {}) => render(element(props))
  /** Every segment's end x, `C` included — `xs` above reads `M`/`L` only, which a monotone line barely has. */
  const endXs = (d: string) =>
    [...d.matchAll(/[MLC]([^MLCZ]+)/g)].map((m) => {
      const n = m[1]!.trim().split(/[\s,]+/).map(Number)
      return n[n.length - 2]!
    })
  const lineOf = (c: HTMLElement) => c.querySelectorAll('g[clip-path] path')[1]?.getAttribute('d') ?? ''

  it('stops short of the edge without one — the premise', () => {
    const { container } = chart()
    expect(Math.max(...endXs(lineOf(container)))).toBeLessThan(RIGHT_EDGE - 1)
    expect(container.querySelector('.live-head')).toBeNull()
  })

  it('reaches the right edge with one, and marks where it ends', () => {
    const { container } = chart({ live: 42.3 })
    expect(Math.max(...endXs(lineOf(container)))).toBeCloseTo(RIGHT_EDGE, 3)
    expect(container.querySelector('.live-head circle'), 'no dot for the live value').not.toBeNull()
  })

  it('never draws the line backwards when the relay clock is ahead of the browser', () => {
    // The newest row carries the relay's clock and `now` is the browser's. A relay 30s ahead stores a row
    // "after" now, and a head placed at `now` would sit left of it — a monotone curve doubling back.
    const ahead = flushed.map((d) => ({ ...d, time: new Date(Date.parse(d.time) + 75_000).toISOString() }))
    const { container } = chart({ data: ahead, live: 50 })
    const x = endXs(lineOf(container))
    for (const [i, v] of x.slice(1).entries()) expect(v, 'the line turned back on itself').toBeGreaterThanOrEqual(x[i]!)
    const dot = container.querySelector('.live-head circle')
    expect(Number(dot?.getAttribute('cx')), 'the dot left the plot').toBeLessThanOrEqual(RIGHT_EDGE)
  })

  it('lets the pointer on the dot read the live value even when the relay clock is well ahead', () => {
    // The dot is drawn at the plot's edge, but a relay a minute ahead stamps its newest row later than any
    // time the pointer can reach. Nearest in time, that row won every hover and the dot under the pointer
    // could not be read; nearest in where the points are drawn, the dot does.
    const ahead = flushed.map((d) => ({ ...d, time: new Date(Date.parse(d.time) + 105_000).toISOString() }))
    const { container } = chart({ data: ahead, live: 50 })
    const surface = container.querySelector('rect[role="slider"]')!
    fireEvent.mouseMove(surface, { clientX: 40 + RIGHT_EDGE + 5, clientY: 50 })
    expect(surface.getAttribute('aria-valuenow'), 'the hover chose a stored row drawn under the dot').toBe(String(flushed.length))
  })

  it('prints the live value nowhere on the plot, and carries it in the reading instead', () => {
    // A value printed beside the dot is a second rendering of what hovering the dot shows, in a box that
    // looks like the tooltip without behaving like one. The dot marks now; the reading — the tooltip, and
    // the chart's name for AT — is the one place the value is written.
    const { container } = chart({ live: 57.4 })
    const head = container.querySelector('.live-head')!
    expect(head.getAttribute('aria-hidden')).toBe('true')
    expect(head.textContent, 'the live value is printed on the plot').toBe('')
    expect(container.querySelector('svg')!.getAttribute('aria-label')).toBe('CPU %, last 1h. Now 57.4%.')
  })

  describe('as the last stop of the reading', () => {
    // Pointer and keyboard share one cursor, and the live value is where both of them end. Left off, the
    // newest thing drawn was the one thing nobody could read: hovering the dot at the right edge snapped the
    // reading to a stored row up to a minute older than it.
    const surfaceOf = (c: HTMLElement) => c.querySelector('rect[role="slider"]')!
    const tooltipText = (c: HTMLElement) => c.querySelector('[class*="pointer-events-none"]')?.textContent ?? ''
    const newerRow = { time: new Date(NOW - 5_000).toISOString(), cpu: 30, mem: 57 }
    /** The reading's date, written out here rather than imported, so a change to the page's format is a
     *  change this file has to agree with. */
    const stampAt = (t: number) =>
      new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })

    it('is where the pointer lands at the right edge, dated at the moment it is drawn', () => {
      // Dated like every other point, at its own position — which is `now`. The newest stored row is 45s
      // older and in the previous minute, so a reading that borrowed its date would show here.
      const { container } = chart({ live: 57.4 })
      fireEvent.mouseMove(surfaceOf(container), { clientX: 40 + RIGHT_EDGE, clientY: 50 })
      expect(surfaceOf(container).getAttribute('aria-valuenow'), 'the pointer snapped to a stored row').toBe(String(flushed.length))
      expect(stampAt(NOW), 'the premise: now and the newest row fall in different minutes')
        .not.toBe(stampAt(Date.parse(flushed[flushed.length - 1]!.time)))
      expect(tooltipText(container)).toBe(`Date: ${stampAt(NOW)}CPU: 57.4%`)
    })

    it('answers the pointer over the whole dot, including the half past the plot edge', () => {
      // The dot is centred on the plot's right edge, so a hover surface that stops at the edge leaves half
      // of the one thing to hover unresponsive.
      const { container } = chart({ live: 57.4 })
      const surface = surfaceOf(container)
      expect(Number(surface.getAttribute('width')), 'the hover surface stops halfway across the dot')
        .toBeGreaterThanOrEqual(RIGHT_EDGE + Number(container.querySelector('.live-head circle')!.getAttribute('r')))
      fireEvent.mouseMove(surface, { clientX: 40 + RIGHT_EDGE + 5, clientY: 50 })
      expect(tooltipText(container)).toContain(`Date: ${stampAt(NOW)}`)
    })

    it('is where End lands, and what the slider announces there', () => {
      const { container } = chart({ live: 57.4 })
      const surface = surfaceOf(container)
      expect(surface.getAttribute('aria-valuemax')).toBe(String(flushed.length))
      fireEvent.focus(surface)
      fireEvent.keyDown(surface, { key: 'Home' })
      fireEvent.keyDown(surface, { key: 'End' })
      // "latest" for AT only. The newest stored row is often in the same minute, and what tells them apart
      // for a sighted reader — the dot at the edge — is `aria-hidden`.
      expect(surface.getAttribute('aria-valuetext')).toBe(`CPU, ${stampAt(NOW)}, latest, 57.4%`)
    })

    it('keeps a reader on now as rows arrive, and tells AT nothing new until the reader acts', () => {
      // The live value changes with every report, about every 10s, and a screen reader speaks every change
      // to a focused slider's value — with no key pressed, for as long as focus stays. So what AT was told
      // holds until the reader acts. The drawn tooltip keeps up; the cursor stays on the live value.
      const { container, rerender } = chart({ live: 57.4 })
      fireEvent.focus(surfaceOf(container))
      fireEvent.keyDown(surfaceOf(container), { key: 'End' })
      const told = () => [surfaceOf(container).getAttribute('aria-valuetext'), surfaceOf(container).getAttribute('aria-valuenow')]
      const before = told()

      rerender(element({ data: [...flushed, newerRow], live: 60.1, now: NOW + 60_000 }))
      expect(told(), 'the focused slider changed what it announces on its own').toEqual(before)
      expect(tooltipText(container), 'the drawn reading stopped following the live value').toContain('CPU: 60.1%')

      // ArrowRight, not End: from the live value it stays there, and from a stored row it would not.
      fireEvent.keyDown(surfaceOf(container), { key: 'ArrowRight' })
      expect(surfaceOf(container).getAttribute('aria-valuetext'), 'a stored row pulled the reader off now')
        .toBe(`CPU, ${stampAt(NOW + 60_000)}, latest, 60.1%`)
      expect(surfaceOf(container).getAttribute('aria-valuenow')).toBe(String(flushed.length + 1))
    })

    it('resumes from the newest stored row when the live value goes away', () => {
      const { container, rerender } = chart({ live: 57.4 })
      fireEvent.focus(surfaceOf(container))
      fireEvent.keyDown(surfaceOf(container), { key: 'End' })

      rerender(element({ live: null }))
      fireEvent.keyDown(surfaceOf(container), { key: 'ArrowRight' })
      const after = surfaceOf(container)
      expect(after.getAttribute('aria-valuenow')).toBe(String(flushed.length - 1))
      expect(after.getAttribute('aria-valuetext')).toBe(`CPU, ${stampAt(Date.parse(flushed[flushed.length - 1]!.time))}, 20%`)
    })

    it('lets go of what it told AT once focus leaves, so the chart is described as it is now', () => {
      // Held only while focused, where a change would be spoken. Held past blur, a screen reader's virtual
      // cursor passing over the chart later would read a value minutes old.
      const { container, rerender } = chart({ live: 57.4 })
      fireEvent.focus(surfaceOf(container))
      fireEvent.keyDown(surfaceOf(container), { key: 'End' })
      fireEvent.blur(surfaceOf(container))

      rerender(element({ live: 60.1 }))
      expect(surfaceOf(container).getAttribute('aria-valuetext'), 'an unfocused chart still reads an old value')
        .toBe(`CPU, ${stampAt(NOW)}, latest, 60.1%`)
    })

    it('does not hold a hovered reading for a chart that never had focus', () => {
      // A hover goes through the same path as the keyboard, so it would record what AT is told too — but
      // nothing is spoken for an unfocused chart, and holding the hovered reading there leaves a virtual
      // cursor a value minutes old, the same as holding it past blur.
      const { container, rerender } = chart({ live: 57.4 })
      fireEvent.mouseMove(surfaceOf(container), { clientX: 40 + RIGHT_EDGE, clientY: 50 })
      fireEvent.mouseLeave(surfaceOf(container))

      rerender(element({ live: 60.1 }))
      expect(surfaceOf(container).getAttribute('aria-valuetext'), 'an unfocused chart reads the value it was hovered at')
        .toBe(`CPU, ${stampAt(NOW)}, latest, 60.1%`)
    })

    it('leaves a reader on a stored row where they are while the live value comes and goes', () => {
      const { container, rerender } = chart({ live: 57.4 })
      fireEvent.focus(surfaceOf(container))
      fireEvent.keyDown(surfaceOf(container), { key: 'Home' })

      rerender(element({ live: 70 }))
      expect(surfaceOf(container).getAttribute('aria-valuenow')).toBe('0')
      rerender(element({ live: null }))
      expect(surfaceOf(container).getAttribute('aria-valuenow')).toBe('0')
    })
  })
})

describe('the chart can be read without a mouse', () => {
  // The tooltip is the only place a reading is written down, and it opened on `mousemove` alone — so the
  // page was unreadable to a keyboard user, which is what the a11y gate blocked this change on. Held here
  // rather than left to the gate: the gate reads a diff, and nothing would fail once the file stops changing.
  const setup = () =>
    render(
      <AreaChartInner width={600} height={220} data={series} dataKey="cpu" hex="#60a5fa" range="1h" now={AT} label="CPU %" />,
    )
  const surfaceOf = (c: HTMLElement) => c.querySelector('rect[role="slider"]')!

  it('exposes the cursor as a slider, which is the role whose key model is the arrow keys', () => {
    // **Not `img` or `application`.** A non-widget role leaves NVDA and JAWS in browse mode, where the
    // virtual cursor takes the arrow keys before `onKeyDown` ever runs — the keyboard path would exist and
    // be unreachable for the users it was built for. The reading rides on `aria-valuetext`, so there is no
    // live region to keep in step with it.
    const { container } = setup()
    const surface = surfaceOf(container)
    expect(surface.getAttribute('tabindex')).toBe('0')
    expect(surface.getAttribute('aria-valuemax')).toBe(String(series.length - 1))
    expect(surface.getAttribute('aria-valuetext')).toMatch(/^CPU, /)
  })

  it('the arrows walk the series and Escape dismisses the reading', () => {
    const { container } = setup()
    const surface = surfaceOf(container)

    fireEvent.focus(surface)
    const atFocus = surface.getAttribute('aria-valuenow')
    expect(surface.getAttribute('aria-valuetext')).toMatch(/\d+%/)

    fireEvent.keyDown(surface, { key: 'ArrowLeft' })
    expect(surface.getAttribute('aria-valuenow'), 'ArrowLeft did not move the cursor').not.toBe(atFocus)

    fireEvent.keyDown(surface, { key: 'Home' })
    expect(surface.getAttribute('aria-valuenow')).toBe('0')

    // Dismissible without moving focus (WCAG 1.4.13) — the reading overlays the plot.
    fireEvent.keyDown(surface, { key: 'Escape' })
    expect(container.querySelector('[class*="pointer-events-none"]'), 'Escape left the reading up').toBeNull()
  })

  it('dismisses a hovered reading with Escape as well, which never had focus', () => {
    // WCAG 1.4.13 asks for a way to dismiss content shown on hover without moving the pointer. The slider's
    // own key handler runs only with focus, and hovering never gives it focus.
    const { container } = setup()
    fireEvent.mouseMove(surfaceOf(container), { clientX: 200, clientY: 50 })
    expect(container.querySelector('[class*="pointer-events-none"]'), 'hovering drew no reading').not.toBeNull()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(container.querySelector('[class*="pointer-events-none"]'), 'Escape left the hovered reading up').toBeNull()
  })

  it('names itself with the title the card shows', () => {
    // The page passes its visible card title (`CPU %`), not the legend key (`CPU`) — asserting the latter
    // would check a string the page never produces and would miss the name drifting from what is on screen.
    const { container } = setup()
    expect(container.querySelector('svg')?.getAttribute('aria-label')).toMatch(/^CPU %, last 1h/)
    expect(surfaceOf(container).getAttribute('aria-label')).toBe('CPU % samples')
  })

  it('keeps the cursor where the reader left it when the overlay is dismissed', () => {
    // Derived from `tooltipData`, every path that hid the reading — Escape, blur — snapped the announced
    // value back to the last sample: a change nobody made, and the next arrow key resumed from the end.
    const { container } = setup()
    const surface = surfaceOf(container)

    fireEvent.focus(surface)
    fireEvent.keyDown(surface, { key: 'Home' })
    expect(surface.getAttribute('aria-valuenow')).toBe('0')
    fireEvent.keyDown(surface, { key: 'Escape' })
    expect(surface.getAttribute('aria-valuenow'), 'Escape moved the cursor').toBe('0')
    fireEvent.blur(surface)
    expect(surface.getAttribute('aria-valuenow'), 'blur moved the cursor').toBe('0')
  })

  it('answers the vertical arrows too, which are half of the slider key set', () => {
    const { container } = setup()
    const surface = surfaceOf(container)
    fireEvent.focus(surface)
    fireEvent.keyDown(surface, { key: 'Home' })
    fireEvent.keyDown(surface, { key: 'ArrowUp' })
    expect(surface.getAttribute('aria-valuenow'), 'ArrowUp did not move the cursor').toBe('1')
    fireEvent.keyDown(surface, { key: 'ArrowDown' })
    expect(surface.getAttribute('aria-valuenow')).toBe('0')
  })

  it('keeps the announced value inside the series when the range shrinks under it', () => {
    // Switching 7d → 1h leaves a cursor that was valid pointing past the end. Unclamped, `aria-valuenow`
    // sat above `aria-valuemax` with no `aria-valuetext` at all — a slider announcing an index.
    const { container, rerender } = setup()
    const surface = surfaceOf(container)
    fireEvent.focus(surface)
    fireEvent.keyDown(surface, { key: 'End' })
    expect(surface.getAttribute('aria-valuenow')).toBe(String(series.length - 1))

    rerender(
      <AreaChartInner width={600} height={220} data={series.slice(0, 3)} dataKey="cpu" hex="#60a5fa" range="1h" now={AT} label="CPU %" />,
    )
    const after = surfaceOf(container)
    expect(Number(after.getAttribute('aria-valuenow'))).toBeLessThanOrEqual(Number(after.getAttribute('aria-valuemax')))
    expect(after.getAttribute('aria-valuetext'), 'the reading went missing').toMatch(/^CPU, /)
  })

  it('returns focus to where the reader left the cursor, not to the end', () => {
    // Focus used to select the newest sample every time, so Escape (or tabbing away) and coming back moved
    // the reader to the other end of the series without a keypress — and the next arrow stepped from there.
    const { container } = setup()
    const surface = surfaceOf(container)

    fireEvent.focus(surface)
    expect(surface.getAttribute('aria-valuenow'), 'the first focus should open at the newest sample')
      .toBe(String(series.length - 1))
    fireEvent.keyDown(surface, { key: 'Home' })
    fireEvent.keyDown(surface, { key: 'ArrowRight' })
    expect(surface.getAttribute('aria-valuenow')).toBe('1')

    fireEvent.blur(surface)
    fireEvent.focus(surface)
    expect(surface.getAttribute('aria-valuenow'), 'refocus jumped the reader to the end').toBe('1')
  })

  it('tells adjacent samples apart on every range', () => {
    // `formatTick` is the axis format: on 7d it is the date alone, so every sample in a day announced
    // identically and arrowing between neighbours sounded like nothing had moved. The visible tooltip is
    // `aria-hidden`, so this string is the only reading AT gets.
    const { container } = render(
      <AreaChartInner width={600} height={220} data={series} dataKey="cpu" hex="#60a5fa" range="7d" now={AT} label="CPU %" />,
    )
    const surface = surfaceOf(container)
    fireEvent.focus(surface)
    const first = surface.getAttribute('aria-valuetext')
    fireEvent.keyDown(surface, { key: 'ArrowLeft' })
    expect(surface.getAttribute('aria-valuetext'), 'two samples announce the same thing').not.toBe(first)
  })

  it('announces exactly what it draws', () => {
    // The tooltip is `aria-hidden`, so `aria-valuetext` is the only reading AT gets — and the two used to
    // be formatted separately, diverging first on the date and then on precision (57.4% drawn, "57%"
    // announced). One formatter, asserted against a fractional value so a rounding difference would show.
    const fractional = [{ time: series[0]!.time, cpu: 57.4, mem: 57.4 }, { time: series[1]!.time, cpu: 12.3, mem: 12.3 }]
    const { container } = render(
      <AreaChartInner width={600} height={220} data={fractional} dataKey="cpu" hex="#60a5fa" range="1h" now={AT} label="CPU %" />,
    )
    const surface = surfaceOf(container)
    fireEvent.focus(surface)
    fireEvent.keyDown(surface, { key: 'Home' })

    const announced = surface.getAttribute('aria-valuetext') ?? ''
    expect(announced).toContain('57.4%')
    const drawn = container.querySelector('[aria-hidden="true"]')?.textContent ?? ''
    expect(drawn, 'the drawn reading disagrees with the announced one').toContain('57.4%')
    // The unit once. The card title is "CPU %", so naming the reading with it printed "CPU %: 57.4%".
    expect(drawn, 'the reading names the series with its unit and then the value with it again').toContain('CPU: 57.4%')
    expect(announced).toMatch(/^CPU, .*, 57\.4%$/)

    // The third rendering of the same number: the chart's own summary name, which a reader hears on the
    // way in. It rounded to an integer while both of the above kept a digit.
    expect(container.querySelector('svg')?.getAttribute('aria-label')).toContain('12.3%')
  })

  it('does not paint an outline until focus asks for one', () => {
    // `outline-none` is a *transparent* 2px outline, so colouring it inline drew a black box around every
    // plot at rest — reported from a screenshot, not by any gate.
    const surface = surfaceOf(setup().container)
    expect(surface.getAttribute('style') ?? '', 'an inline outline colour is visible at rest').not.toMatch(/outline/i)
    expect(surface.getAttribute('class') ?? '').toMatch(/focus-visible:outline/)
  })

  describe('as the window advances under it', () => {
    // The chart re-renders with a moved window and refreshed rows while a reader is on it. An index cursor
    // moved the reading one sample newer for every row that aged out of the left edge — a change nobody
    // made, announced as though they had.
    const chart = (data = varied, now = AT) =>
      <AreaChartInner width={600} height={220} data={data} dataKey="cpu" hex="#60a5fa" range="1h" now={now} label="CPU %" />
    // Distinct values, so two samples cannot announce the same thing by coincidence.
    const varied = series.map((d, i) => ({ ...d, cpu: i }))

    it('stays on the sample the reader chose when an older row ages out', () => {
      const { container, rerender } = render(chart())
      const surface = surfaceOf(container)
      fireEvent.focus(surface)
      fireEvent.keyDown(surface, { key: 'Home' })
      fireEvent.keyDown(surface, { key: 'ArrowRight' })
      const reading = surface.getAttribute('aria-valuetext')

      rerender(chart(varied.slice(1)))
      expect(surfaceOf(container).getAttribute('aria-valuetext'), 'the focused slider changed its reading on its own').toBe(reading)
      // The next key steps from the sample the reader chose — index 0 now — not from where its index was.
      fireEvent.keyDown(surfaceOf(container), { key: 'ArrowRight' })
      expect(surfaceOf(container).getAttribute('aria-valuetext'), 'the reader lost their place when a row aged out').toMatch(/, 2%$/)
      expect(surfaceOf(container).getAttribute('aria-valuenow')).toBe('1')
    })

    it('resumes from the oldest remaining sample when the chosen one ages out, and says so only when asked', () => {
      const { container, rerender } = render(chart())
      fireEvent.focus(surfaceOf(container))
      fireEvent.keyDown(surfaceOf(container), { key: 'Home' })

      rerender(chart(varied.slice(1)))
      expect(surfaceOf(container).getAttribute('aria-valuetext'), 'the reading changed with no key pressed').toMatch(/, 0%$/)
      fireEvent.keyDown(surfaceOf(container), { key: 'ArrowLeft' })
      const after = surfaceOf(container)
      expect(after.getAttribute('aria-valuenow')).toBe('0')
      expect(after.getAttribute('aria-valuetext'), 'the reading is not the oldest remaining sample').toMatch(/, 1%$/)
    })

    it('stays put when a newer row arrives', () => {
      const { container, rerender } = render(chart())
      const surface = surfaceOf(container)
      fireEvent.focus(surface)
      fireEvent.keyDown(surface, { key: 'Home' })
      for (let i = 0; i < 10; i++) fireEvent.keyDown(surface, { key: 'ArrowRight' })
      const reading = surface.getAttribute('aria-valuetext')

      rerender(chart([...varied, { time: new Date(AT).toISOString(), cpu: 99, mem: 57 }]))
      expect(surfaceOf(container).getAttribute('aria-valuetext')).toBe(reading)
      expect(surfaceOf(container).getAttribute('aria-valuenow')).toBe('10')
    })

    it('keeps the drawn reading on its sample while the window moves', () => {
      // The tooltip's position was stored when it opened, so an advancing axis slid the sample out from
      // under a guide line that stayed where it was.
      const { container, rerender } = render(chart())
      fireEvent.focus(surfaceOf(container))
      fireEvent.keyDown(surfaceOf(container), { key: 'End' })
      const guideX = () =>
        Number(/translateX\((-?[\d.e-]+)px\)/.exec(container.querySelector('g[style*="translateX"]')?.getAttribute('style') ?? '')?.[1])
      const before = guideX()
      expect(Number.isFinite(before), 'no guide line was drawn').toBe(true)

      rerender(chart(varied, AT + 600_000))
      expect(before - guideX(), 'the guide line did not move with its sample').toBeCloseTo((600_000 / 3_600_000) * (600 - 40 - 24), 3)
    })

    it('opens at the newest sample if the reader has not placed the cursor yet', () => {
      const { container, rerender } = render(chart())
      rerender(chart([...varied, { time: new Date(AT).toISOString(), cpu: 99, mem: 57 }]))
      fireEvent.focus(surfaceOf(container))
      expect(surfaceOf(container).getAttribute('aria-valuenow')).toBe(String(varied.length))
    })
  })
})
