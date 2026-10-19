// Which physical side button a press lands on. The defect this covers was found by hand on a real
// simulator (2026-09-11): on an iPhone 15 Pro the upper half of Volume Up pressed the **Action**
// button — the tooltip said Action and the press followed it.
//
// Two things were wrong together, and the fixtures below separate them because fixing only the
// first leaves the second:
//
//   1. catchment was a fixed radius around each button's *centre*, so a tall button's own pixels
//      could sit nearer a short neighbour's centre;
//   2. the *first* button within range won, not the nearest — so the whole overlap band went to
//      whichever button `chrome.buttons` happened to list earlier.
//
// Every case names the mutation that kills it.
import type { ChromeButton } from '@tapflowio/protocol'
import { describe, expect, it } from 'vitest'
import { buttonHitRect, buttonTargets, buttonTitles, type Rect } from '../../lib/buttonHit'

/** The frame's composite box, where a test does not name its own. */
const BOX = { width: 1000, height: 2000 }

/**
 * 2× composite px, shaped like an iPhone 15 Pro's left edge: Action above a much taller Volume Up.
 *
 * **The two offsets differ on purpose.** A first version set `rolloverOffset` equal to
 * `normalOffset` — the ternary even had two identical branches — and that made the two places
 * `buttonHitRect` deliberately reads the rollover pair invisible: pointing both of them at
 * `normalOffset` left all ten cases green. `DeviceChromeLoader` fills them from different plist
 * offsets, and the gap between them *is* the hover slide the renderer animates, so a fixture where
 * they agree is a fixture that cannot see the axis this change moved.
 */
const button = (name: string, centreY: number, h: number, anchor = 'left'): ChromeButton => ({
  name,
  accessibilityTitle: name,
  anchor,
  onTop: false,
  normalOffset: { x: 40, y: centreY },
  rolloverOffset: { x: 32, y: anchor === 'top' ? centreY - 30 : centreY },
  buttonW: 24,
  buttonH: h,
  usagePage: 0,
  usage: 0,
})

//                        rect
const ACTION = button('action', 620, 110)      // 565 … 675
const VOLUME_UP = button('volume_up', 850, 280) // 710 … 990
const BUTTONS = [ACTION, VOLUME_UP] as const    // Action first — the order that used to decide

/** A left-edge button as `DeviceChromeLoader` measures one: rectangle x, y … y2. */
const side = (name: string, x: number, y: number, y2: number): ChromeButton => ({
  ...button(name, (y + y2) / 2, y2 - y), rolloverOffset: { x: x + 16, y: (y + y2) / 2 }, buttonW: 32,
})
/** A top-edge button: rectangle x … x2, y 0 … 32. */
const top = (name: string, x: number, x2: number): ChromeButton => ({
  ...button(name, 0, 32, 'top'), rolloverOffset: { x: (x + x2) / 2, y: 0 }, buttonW: x2 - x,
})

describe('buttonHitRect', () => {
  // **Horizontally from the rollover pair, vertically from the normal one** — which is what the
  // renderer draws at rest, and the asymmetry is the whole reason this function exists rather than
  // the caller doing the arithmetic.
  //
  // Mutation: `left = normalOffset.x - halfW`. Gives 28 instead of 20, so the target sits a slide's
  // width away from the pixels the user is aiming at.
  it('places a side button around its rollover x and its normal y', () => {
    expect(buttonHitRect(ACTION)).toEqual({ left: 20, top: 565, right: 44, bottom: 675 })
  })

  // A top-edge button — an iPad's power button. Mutation: measure every anchor from
  // `normalOffset.y`. The rect moves to 1355 and stops matching the pixels it is drawn on.
  it('measures a top-anchored button from its rollover offset', () => {
    const power = button('power', 1400, 90, 'top')
    expect(buttonHitRect(power).top).toBe(1370)
  })
})

// The targets the viewer renders as elements for the browser to hit-test (#785). What `pickButton`
// used to decide per pointer event is now a layout fact, and both #783 defects — a neighbour's reach
// covering a button, and listing order deciding the overlap — are gone by construction: a target is
// as long as its button, so two never overlap.
describe('buttonTargets', () => {
  // Fixture side buttons sit at x 20…44, centred on 32.
  //
  // Mutations: grow along the edge (any margin on `top`/`bottom`); stop at the button's own outer
  // edge rather than the box (`left` 20); reach on to the button's far edge (`right` 44).
  it('is the button\'s length along the edge, and runs from the box to the centre line across it', () => {
    expect(buttonTargets([ACTION], BOX)).toEqual([{ left: 0, top: 565, right: 32, bottom: 675 }])
  })

  // The #783 position: y=715 is inside Volume Up and nearer Action's centre. With no growth along the
  // edge it is Volume Up's whatever the order, and the gap between them is nobody's.
  //
  // Mutation: any growth along the edge. Action's target then reaches y=715 or the two overlap.
  it('never overlaps a neighbour, in either order', () => {
    for (const order of [BUTTONS, [VOLUME_UP, ACTION]] as const) {
      const byName = Object.fromEntries(buttonTargets(order, BOX).map((t, i) => [order[i].name, t]))
      expect(byName.action.bottom).toBe(675)
      expect(byName.volume_up.top).toBe(710)
    }
  })

  // Mutation: drop the `right` case. The power button's target is then its bare rectangle, reaching
  // over the bezel to x 890 and stopping short of the box.
  it('mirrors on the right edge: centre line to the box', () => {
    const power = { ...button('power', 900, 200, 'right'), rolloverOffset: { x: 878, y: 900 } } // x 866 … 890
    expect(buttonTargets([power], { width: 900, height: 2000 })[0]).toEqual({ left: 878, top: 800, right: 900, bottom: 1000 })
  })

  // An iPad's top edge. This button lies wholly left of x 40 — where a screen would start — as a
  // button near a corner can, so a test of position against the screen would read it as a left-edge
  // button and cut it on the wrong axis.
  //
  // Mutation: decide the side from position. `right` is then cut to 12 and `bottom` left at 32.
  it('takes the side facing the device from the anchor, not from position', () => {
    const corner = top('power', 0, 24)
    expect(buttonTargets([corner], BOX)[0]).toEqual({ left: 0, top: 0, right: 24, bottom: 16 })
  })

  // Mutation: drop the `bottom` case.
  it('runs a bottom-edge button from its centre line to the box', () => {
    const b = { ...button('b', 1900, 40, 'bottom'), rolloverOffset: { x: 500, y: 1900 } } // y 1880 … 1920
    expect(buttonTargets([b], BOX)[0]).toEqual({ left: 488, top: 1900, right: 512, bottom: 2000 })
  })

  // The iPhone SE home button sits on the device's face, which is bezel all round — no body edge to
  // reach to, and the box is far below it.
  //
  // Mutation: treat it like an edge button. Its target then reaches down to the bottom of the box.
  it('keeps a button on the device face (the SE home button) to its own rectangle', () => {
    const home = { ...button('home', 1700, 130, 'bottom'), onTop: true } // y 1635 … 1765
    expect(buttonTargets([home], { width: 914, height: 1778 })[0]).toEqual(buttonHitRect(home))
  })

  // WCAG 2.5.8 accepts a target under 24 × 24 CSS px when a 24 px circle centred on it touches no
  // other target and no other such circle. A side target is about 13 CSS px across on an iPhone and
  // about 5 on an iPad's top edge, so the spacing exception is the one it meets. Checked on layouts
  // measured from real chrome on 2026-10-01: an iPhone 15 Pro's left edge (display scale ≈ 0.42 CSS
  // px per composite px, so the circle is 58 composite px across) and an iPad mini's top edge, where
  // three buttons share it (≈ 0.29, so 83).
  //
  // Mutation: grow targets along the edge by half the gap or more. Neighbours then meet, and a
  // circle lands on another target.
  it.each([
    ['iPhone 15 Pro, left edge', 58, { width: 910, height: 1776 }, [
      side('action', 16, 286, 354), side('volume-up', 16, 378, 506), side('volume-down', 16, 536, 664),
    ]],
    ['iPad mini (A17 Pro), top edge', 83, { width: 1728, height: 2516 }, [
      top('volume-down', 154, 284), top('volume-up', 306, 436), top('power', 1333, 1555),
    ]],
  ] as const)('meets the 24 px spacing exception on %s', (_name, circle, box, buttons) => {
    const targets = buttonTargets(buttons, box)
    const r = circle / 2
    const centre = (t: Rect) => ({ x: (t.left + t.right) / 2, y: (t.top + t.bottom) / 2 })
    const distTo = (p: { x: number; y: number }, t: Rect) =>
      Math.hypot(Math.max(t.left - p.x, 0, p.x - t.right), Math.max(t.top - p.y, 0, p.y - t.bottom))
    targets.forEach((a, i) => targets.forEach((b, j) => {
      if (i === j) return
      expect(distTo(centre(a), b), `${buttons[i].name} circle reaches ${buttons[j].name}`).toBeGreaterThanOrEqual(r)
      expect(Math.hypot(centre(a).x - centre(b).x, centre(a).y - centre(b).y)).toBeGreaterThanOrEqual(circle)
    }))
  })

  it('answers nothing for a device with no buttons', () => {
    expect(buttonTargets([], BOX)).toEqual([])
  })
})

// The tooltip names what a press *does*. On an iPad that is not always the physical button's name:
// iPadOS (15.4+) raises the volume with whichever button is on the right or on top as the device is
// held, and current iPads cannot turn that off. The press itself still sends the physical button's
// HID usage — the device does the remapping — so only the title moves. Layouts are measured from the
// real chrome (2× composite px); the viewer's landscape is `rotate(-90deg)`, counter-clockwise.
describe('buttonTitles', () => {
  const vol = (name: string, title: string, usage: number, anchor: string, x: number, y: number, w: number, h: number): ChromeButton => ({
    ...button(name, y, h, anchor), accessibilityTitle: title, usagePage: 12, usage,
    rolloverOffset: { x, y: anchor === 'top' ? 0 : y }, normalOffset: { x, y }, buttonW: w,
  })
  // iPad Pro 13 (M5): both on the right edge, Up above Down.
  const PRO = { box: { width: 2274, height: 2946 }, buttons: [
    vol('volume-up', 'Volume Up', 233, 'right', 2242, 210, 32, 104),
    vol('volume-down', 'Volume Down', 234, 'right', 2242, 336, 32, 104),
  ] }
  // iPad mini (A17 Pro): both on the top edge, Down left of Up.
  const MINI = { box: { width: 1728, height: 2516 }, buttons: [
    vol('volume-up', 'Volume Up', 233, 'top', 371, 16, 130, 32),
    vol('volume-down', 'Volume Down', 234, 'top', 219, 16, 130, 32),
  ] }

  it('names the physical buttons in portrait, on both layouts', () => {
    expect(buttonTitles(PRO.buttons, PRO.box, false, 'tablet')).toEqual(['Volume Up', 'Volume Down'])
    expect(buttonTitles(MINI.buttons, MINI.box, false, 'tablet')).toEqual(['Volume Up', 'Volume Down'])
  })

  // The pair that pins the rotation's direction. Turned counter-clockwise, the Pro's right edge
  // becomes the top with Up on the left — so Down is the one raising the volume, as the maintainer
  // saw. The mini's top edge becomes the left with Up on top, so its names stay. Turned clockwise it
  // would be the other way round, which is why both are here.
  //
  // Mutations: rotate the other way (both cases flip); swap whenever landscape (the mini fails).
  it('follows the effect in landscape: the Pro swaps, the mini does not', () => {
    expect(buttonTitles(PRO.buttons, PRO.box, true, 'tablet')).toEqual(['Volume Down', 'Volume Up'])
    expect(buttonTitles(MINI.buttons, MINI.box, true, 'tablet')).toEqual(['Volume Up', 'Volume Down'])
  })

  // An iPhone's volume does not follow orientation. Mutation: drop the form-factor gate.
  it('leaves a phone, or a device that did not say, with its physical names', () => {
    expect(buttonTitles(PRO.buttons, PRO.box, true, 'phone')).toEqual(['Volume Up', 'Volume Down'])
    expect(buttonTitles(PRO.buttons, PRO.box, true, undefined)).toEqual(['Volume Up', 'Volume Down'])
  })

  // The pair is found by HID usage — Consumer page 12, Volume Increment 233 / Decrement 234, which
  // Apple's chrome states for each input — not by the `name` string. Mutation: match on name.
  it('finds the volume pair by HID usage, not by name', () => {
    const renamed = PRO.buttons.map((b, i) => ({ ...b, name: `vol-${i}` }))
    expect(buttonTitles(renamed, PRO.box, true, 'tablet')).toEqual(['Volume Down', 'Volume Up'])
  })

  it('leaves a tablet with no volume pair alone', () => {
    const power = { ...button('power', 0, 32, 'top'), accessibilityTitle: 'Sleep/Wake', usagePage: 12, usage: 48 }
    expect(buttonTitles([power], PRO.box, true, 'tablet')).toEqual(['Sleep/Wake'])
  })
})
