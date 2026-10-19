import type { Point, WatchActionKind } from '@tapflowio/protocol'

/**
 * What a session's watchers are told the holder did (A2), derived from the input the relay passes on. Pure, so the
 * rules are tested apart from the socket plumbing.
 */

/** A touch that ends within this distance of where it began is a tap; further is a swipe. Normalised 0–1. */
const TAP_RADIUS = 0.02

/**
 * A key as watchers see it. **A key that types a character is not named**: watchers are the whole team, and the
 * keys pressed one by one are the text typed. Keep in step with flow-runner's `activityLabel` (`pressKey`), which
 * applies the same rule to a flow step's name.
 */
export function keyForWatchers(code: string): string {
  return /^(Key[A-Z]|Digit\d|Numpad\d|Numpad(Add|Subtract|Multiply|Divide|Decimal|Comma|Equal|ParenLeft|ParenRight|Hash|Star)|Space|Minus|Equal|Bracket(Left|Right)|Backslash|Semicolon|Quote|Backquote|Comma|Period|Slash|IntlBackslash|IntlRo|IntlYen)$/.test(code)
    || code.length === 1
    ? 'character'
    : code
}

/** The gesture a touch made, from where it began (if seen) to where it ended. Null when there is nothing to show. */
export function gestureAction(start: Point | null, end: Point | null): WatchActionKind | null {
  if (!start) return end ? { kind: 'tap', x: end.x, y: end.y } : null
  const to = end ?? start
  return Math.hypot(to.x - start.x, to.y - start.y) <= TAP_RADIUS
    ? { kind: 'tap', x: start.x, y: start.y }
    : { kind: 'swipe', from: [start.x, start.y], to: [to.x, to.y] }
}
