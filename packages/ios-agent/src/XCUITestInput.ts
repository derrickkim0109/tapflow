import { createLogger } from '@tapflowio/agent-core'
import type { InputChannel } from './InputChannel.js'
import type { RunnerInputClient } from './XCUITreeReader.js'

const logger = createLogger('ios-agent:xcuitest-input')

/** Farther than this (normalized to the screen) from where it started, a touch is a drag, not a tap. */
export const TAP_SLOP = 0.02
/** Held this long without moving, a touch is a long press: iOS's own threshold is about half a second. */
export const LONG_PRESS_MS = 450

const SHIFT = 0x02 | 0x20
const CTRL_ALT_META = 0x01 | 0x04 | 0x08 | 0x10 | 0x40 | 0x80

// Keyboard-page usages that type a character, with their unshifted and shifted forms (US layout, as KeyCodeMap).
const CHARS: Record<number, readonly [string, string]> = {
  0x1e: ['1', '!'], 0x1f: ['2', '@'], 0x20: ['3', '#'], 0x21: ['4', '$'], 0x22: ['5', '%'],
  0x23: ['6', '^'], 0x24: ['7', '&'], 0x25: ['8', '*'], 0x26: ['9', '('], 0x27: ['0', ')'],
  0x2c: [' ', ' '], 0x2d: ['-', '_'], 0x2e: ['=', '+'], 0x2f: ['[', '{'], 0x30: [']', '}'],
  0x31: ['\\', '|'], 0x33: [';', ':'], 0x34: ["'", '"'], 0x35: ['`', '~'], 0x36: [',', '<'],
  0x37: ['.', '>'], 0x38: ['/', '?'],
  0x54: ['/', '/'], 0x55: ['*', '*'], 0x56: ['-', '-'], 0x57: ['+', '+'], 0x63: ['.', '.'],
  0x59: ['1', '1'], 0x5a: ['2', '2'], 0x5b: ['3', '3'], 0x5c: ['4', '4'], 0x5d: ['5', '5'],
  0x5e: ['6', '6'], 0x5f: ['7', '7'], 0x60: ['8', '8'], 0x61: ['9', '9'], 0x62: ['0', '0'],
}
for (let u = 0x04; u <= 0x1d; u++) {
  const c = String.fromCharCode(0x61 + u - 0x04)
  CHARS[u] = [c, c.toUpperCase()]
}
// Keys the runner plays as named keys rather than typed text.
const NAMED_KEYS: Record<number, string> = { 0x28: 'return', 0x58: 'return', 0x2a: 'delete', 0x2b: 'tab' }

// Consumer page: Menu is home (as FoldableInput measured), volume up / down. Power has no XCUITest API.
const CONSUMER_PAGE = 0x0c
const CONSUMER_BUTTONS: Record<number, string> = { 0x40: 'home', 0xe9: 'volumeUp', 0xea: 'volumeDown' }

interface Touch {
  x: number
  y: number
  lastX: number
  lastY: number
  moved: boolean
  startedAt: number
}

export interface XCUITestInputDeps {
  /** The device's runner (`XCUITreeReader.inputClient(udid)`). */
  runner: RunnerInputClient
  /** The app in front, when known: the runner looks for the focused text field there first. */
  foregroundBundleId?: () => string | null
}

/**
 * `InputChannel` for a USB-connected iPhone, through the resident XCUITest runner on the device (TreeServer.swift).
 * SimulatorKit's HID injection, which both other channels build on, does not reach hardware.
 *
 * XCUITest synthesizes a whole gesture from one call, so a touch is not streamed: its frames are buffered and the
 * finished gesture is sent when it ends — a tap, a drag lasting as long as the touch did, or a long press. A drag
 * therefore plays out after the finger lifts, along a straight line from where it started to where it ended.
 *
 * Writes answer as the contract asks: synchronously, whether the channel took them. What the runner then refuses
 * (nothing focused for a key, a button it cannot press) is logged, the way FoldableInput logs its helper's refusals.
 * What XCUITest cannot do at all — a pinch, holding a button down, the side button — is refused with `false`.
 */
export class XCUITestInput implements InputChannel {
  private touch: Touch | null = null
  private stopped = true
  private queue: Promise<void> = Promise.resolve()

  constructor(private readonly deps: XCUITestInputDeps) {}

  start(): void {
    this.stopped = false
    this.deps.runner.warm()
  }

  stop(): void {
    this.stopped = true
    this.touch = null
  }

  inputState(): 'ready' | 'starting' | 'unavailable' {
    return this.stopped ? 'unavailable' : this.deps.runner.state()
  }

  ownsGesture(): boolean {
    return this.touch !== null
  }

  touchStart(x: number, y: number): boolean {
    this.touch = null
    if (this.inputState() !== 'ready') return false
    this.touch = { x, y, lastX: x, lastY: y, moved: false, startedAt: Date.now() }
    return true
  }

  touchMove(x: number, y: number): boolean {
    const t = this.touch
    if (!t) return false
    t.lastX = x
    t.lastY = y
    // Once a drag, always a drag: a swipe that comes back to where it began is not a tap.
    if (Math.hypot(x - t.x, y - t.y) > TAP_SLOP) t.moved = true
    return true
  }

  touchEnd(): boolean {
    const t = this.touch
    if (!t) return false
    this.touch = null
    const ms = Date.now() - t.startedAt
    if (!t.moved && ms < LONG_PRESS_MS) {
      this.send(`/tap?x=${coord(t.x)}&y=${coord(t.y)}`)
    } else {
      const [x2, y2] = t.moved ? [t.lastX, t.lastY] : [t.x, t.y]
      this.send(`/drag?x1=${coord(t.x)}&y1=${coord(t.y)}&x2=${coord(x2)}&y2=${coord(y2)}&ms=${ms}`)
    }
    return true
  }

  /** XCUITest gives a tap its own contact time, so there is nothing to hold here. */
  touchEndAfterMinContact(): Promise<boolean> {
    return Promise.resolve(this.touchEnd())
  }

  pinchStart(_x1: number, _y1: number, _x2: number, _y2: number): boolean {
    this.touch = null
    return this.unsupported('a pinch')
  }

  pinchMove(_x1: number, _y1: number, _x2: number, _y2: number): boolean {
    return false
  }

  pinchEnd(): boolean {
    return false
  }

  sendKey(usage: number, modifiers = 0): boolean {
    // ⌘/⌃/⌥ chords are shortcuts, not text; XCUITest on iOS has no way to press them.
    if (modifiers & CTRL_ALT_META) return this.unsupported(`key 0x${usage.toString(16)} with modifiers 0x${modifiers.toString(16)}`)
    const named = NAMED_KEYS[usage]
    if (named) return this.key(named)
    const chars = CHARS[usage]
    if (!chars) return this.unsupported(`key 0x${usage.toString(16)}`)
    return this.typeText(chars[modifiers & SHIFT ? 1 : 0])
  }

  /** Types `text` into the focused element in one request — what `input:type` wants, rather than a key per character. */
  typeText(text: string): boolean {
    if (this.inputState() !== 'ready') return false
    this.send(this.withApp('/type'), text)
    return true
  }

  pressButton(usagePage: number, usage: number): boolean {
    const name = usagePage === CONSUMER_PAGE ? CONSUMER_BUTTONS[usage] : undefined
    return name ? this.key(name) : this.unsupported(`button 0x${usagePage.toString(16)}/0x${usage.toString(16)}`)
  }

  pressButtonDown(_usagePage: number, _usage: number): boolean {
    return this.unsupported('holding a button')
  }

  pressButtonUp(_usagePage: number, _usage: number): boolean {
    return false
  }

  /** 0 = home; 1 = lock, which XCUITest cannot press. */
  pressLegacyButton(code: number): boolean {
    return code === 0 ? this.key('home') : this.unsupported('the side button')
  }

  private key(name: string): boolean {
    if (this.inputState() !== 'ready') return false
    this.send(this.withApp(`/key?name=${name}`))
    return true
  }

  private withApp(path: string): string {
    const bundleId = this.deps.foregroundBundleId?.()
    if (!bundleId) return path
    return `${path}${path.includes('?') ? '&' : '?'}bundleId=${encodeURIComponent(bundleId)}`
  }

  // One at a time and in order: a tap that focuses a field must land before the text typed into it.
  private send(path: string, body?: string): void {
    this.queue = this.queue
      .then(() => this.deps.runner.request(path, body))
      .catch((e: unknown) => logger.warn(`runner did not take ${path.split('?')[0]}: ${e instanceof Error ? e.message : String(e)}`))
  }

  private unsupported(what: string): boolean {
    logger.warn(`${what} cannot be sent to a physical iPhone through XCUITest`)
    return false
  }
}

function coord(v: number): string {
  return String(Math.round(Math.min(1, Math.max(0, v)) * 10_000) / 10_000)
}
