import type { WatchActionKind } from '@tapflowio/protocol'

/** A holder's action as the watch page keeps it (A2): when the relay saw it, and an id for lists and timers. */
export interface WatchedAction {
  id: number
  at: number
  action: WatchActionKind
}

/** The list keeps this many; older ones fall off. Nothing is stored anywhere — a reload starts empty. */
export const MAX_ACTIONS = 100
/** How long the trail of a move stays drawn on the device; the cursor itself stays. */
export const MARK_MS = 900

/**
 * The agent's pointer on the device, as the watch page draws it — the way computer-use views do: a cursor that stays
 * at the last tap and glides to the next, leaving a short-lived trail of where it came from.
 */
export interface WatchMarks {
  cursor: { x: number; y: number } | null
  trails: Trail[]
}
/** A move to show for a moment: a tap's path from the previous cursor, or a swipe's from its start. */
export interface Trail { id: number; kind: 'tap' | 'swipe'; from: [number, number] | null; to: [number, number] }

export const NO_MARKS: WatchMarks = { cursor: null, trails: [] }

/** The trail an action leaves, given where the cursor was. */
export function trailOf(id: number, a: Extract<WatchActionKind, { kind: 'tap' | 'swipe' }>, cursor: WatchMarks['cursor']): Trail {
  return a.kind === 'tap'
    ? { id, kind: 'tap', from: cursor ? [cursor.x, cursor.y] : null, to: [a.x, a.y] }
    : { id, kind: 'swipe', from: a.from, to: a.to }
}

/** A line for the Actions list. Positions as percentages of the screen, which is what they are on the wire. */
export function actionText(a: WatchActionKind): string {
  const pct = (n: number) => `${Math.round(n * 100)}%`
  switch (a.kind) {
    case 'label': return a.label
    case 'tap': return `Tap at ${pct(a.x)}, ${pct(a.y)}`
    case 'swipe': return `Swipe ${direction(a.from, a.to)}`
    case 'key': return a.key === 'character' ? 'Key (a character)' : `Key ${a.key}`
    case 'button': return `Button ${a.button}`
    case 'type': return `Typed ${a.chars} ${a.chars === 1 ? 'character' : 'characters'}`
    case 'pinch': return 'Pinch'
    case 'launch': return 'Launched the app'
    case 'install': return 'Installed a build'
    case 'clear-state': return 'Cleared the app\'s data'
    case 'open-url': return 'Opened a link'
  }
}

function direction(from: [number, number], to: [number, number]): string {
  const dx = to[0] - from[0]
  const dy = to[1] - from[1]
  if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? 'right' : 'left'
  return dy > 0 ? 'down' : 'up'
}

/** Whether an action is drawn on the device. */
export function isMark(a: WatchActionKind): a is Extract<WatchActionKind, { kind: 'tap' | 'swipe' }> {
  return a.kind === 'tap' || a.kind === 'swipe'
}

/**
 * A point on an iOS screen (0–1) as a position in the whole device frame, which is the box the iOS screen's overlay
 * spans — the same conversion as the QA viewer's pinch hints. `layout` is `iosScreenLayout(chrome)`.
 */
export function placeOnIosFrame(layout: { screenPctLeft: number; screenPctTop: number; screenPctW: number; screenPctH: number }) {
  return (x: number, y: number) => ({
    left: (layout.screenPctLeft + x * layout.screenPctW) / 100,
    top: (layout.screenPctTop + y * layout.screenPctH) / 100,
  })
}
