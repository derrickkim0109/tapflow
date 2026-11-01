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
 * Writes answer as the contract asks: synchronously, whether the channel took them. What the runner then answers
 * arrives later, so the request a write sent is handed to whoever acks it (`takeLastWrite`): a refusal there (nothing
 * focused for a key) must not be answered as delivered. What XCUITest cannot do at all — a pinch, holding a button
 * down, the side button, a ⌘ chord — is refused with `false`, and `unsupportedReason` says which, so the refusal can
 * be told apart from a runner that is not up yet.
 */
export class XCUITestInput implements InputChannel {
  private touch: Touch | null = null
  private stopped = true
  private queue: Promise<void> = Promise.resolve()
  // What the last write was refused for, when it can never be sent; cleared by every write.
  private refusal: string | null = null
  // The request the last write queued, until its ack takes it.
  private lastWrite: Promise<void> | null = null

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
    this.beginWrite()
    this.touch = null
    if (!this.ready()) return false
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
    this.beginWrite()
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

  // Every frame of a pinch is refused as one, the end included: that end is what gets an answer, and it must say
  // "never" rather than "no gesture in progress", which would send the caller to start another pinch.
  pinchStart(_x1: number, _y1: number, _x2: number, _y2: number): boolean {
    this.beginWrite()
    this.touch = null
    return this.unsupported('A pinch')
  }

  pinchMove(_x1: number, _y1: number, _x2: number, _y2: number): boolean {
    this.beginWrite()
    return this.unsupported('A pinch', false)
  }

  pinchEnd(): boolean {
    this.beginWrite()
    return this.unsupported('A pinch')
  }

  sendKey(usage: number, modifiers = 0): boolean {
    this.beginWrite()
    // ⌘/⌃/⌥ chords are shortcuts, not text; XCUITest on iOS has no way to press them.
    if (modifiers & CTRL_ALT_META) return this.unsupported('A keyboard shortcut (⌘, ⌃ or ⌥ with a key)')
    const named = NAMED_KEYS[usage]
    if (named) return this.key(named)
    const chars = CHARS[usage]
    if (!chars) return this.unsupported(`Key 0x${usage.toString(16)}`)
    return this.typeText(chars[modifiers & SHIFT ? 1 : 0])
  }

  /** Types `text` into the focused element in one request — what `input:type` wants, rather than a key per character. */
  typeText(text: string): boolean {
    this.beginWrite()
    if (!this.ready()) return false
    this.send(this.withApp('/type'), text, true)
    return true
  }

  pressButton(usagePage: number, usage: number): boolean {
    this.beginWrite()
    const name = usagePage === CONSUMER_PAGE ? CONSUMER_BUTTONS[usage] : undefined
    return name ? this.key(name) : this.unsupported(`Button 0x${usagePage.toString(16)}/0x${usage.toString(16)}`)
  }

  pressButtonDown(_usagePage: number, _usage: number): boolean {
    this.beginWrite()
    return this.unsupported('Holding a button down')
  }

  pressButtonUp(_usagePage: number, _usage: number): boolean {
    this.beginWrite()
    return this.unsupported('Holding a button down')
  }

  /** 0 = home; 1 = lock, which XCUITest cannot press. */
  pressLegacyButton(code: number): boolean {
    this.beginWrite()
    return code === 0 ? this.key('home') : this.unsupported('The side button')
  }

  /** Why the last write was refused, when it was refused because it can never be sent from here; null otherwise. */
  unsupportedReason(): string | null {
    return this.refusal
  }

  /**
   * The runner's answer to the request the last write sent — resolves when it took it, rejects with its reason — or
   * null when that write sent nothing, or sent a tap or drag (acked without waiting, see `send`). Taken once, by the write's ack: a key typed with nothing focused is refused by
   * the runner (409), and answering it as delivered is a success the tester never got.
   */
  takeLastWrite(): Promise<void> | null {
    const write = this.lastWrite
    this.lastWrite = null
    return write
  }

  /** Why the runner could not be started, when its last start failed. */
  runnerFailure(): string | null {
    return this.deps.runner.lastError?.() ?? null
  }

  private key(name: string): boolean {
    if (!this.ready()) return false
    this.send(this.withApp(`/key?name=${name}`), undefined, true)
    return true
  }

  // A runner that died after it was ready, or whose last start failed, is not restarted by anything else: the
  // write that finds it down asks for a new one (warm is a no-op while a start is under way).
  private ready(): boolean {
    if (this.inputState() === 'ready') return true
    if (!this.stopped) this.deps.runner.warm()
    return false
  }

  private withApp(path: string): string {
    const bundleId = this.deps.foregroundBundleId?.()
    if (!bundleId) return path
    return `${path}${path.includes('?') ? '&' : '?'}bundleId=${encodeURIComponent(bundleId)}`
  }

  private beginWrite(): void {
    this.refusal = null
    this.lastWrite = null
  }

  // One at a time and in order: a tap that focuses a field must land before the text typed into it. `answered`: the
  // write's ack waits for the runner (`takeLastWrite`) — a key, text or button, which the runner can refuse. A tap or
  // drag is acked at once, as on a simulator: the runner plays it out before it answers, which can outlast a client's
  // ack deadline. The cost: a tap sent to a runner that has just died (ready a moment ago, its process gone) is acked
  // as delivered though it never landed — the failure is only logged, and the next write restarts the runner.
  private send(path: string, body?: string, answered = false): void {
    // A write queued before stop() must not reach (or restart) the runner after it.
    const write = this.queue.then(() => (this.stopped ? undefined : this.deps.runner.request(path, body)))
    // Nobody may take it (a write whose ack is not waited on), so its rejection is handled here as well.
    write.catch(() => { /* logged below */ })
    if (answered) this.lastWrite = write
    this.queue = write
      .catch((e: unknown) => logger.warn(`runner did not take ${path.split('?')[0]}: ${e instanceof Error ? e.message : String(e)}`))
  }

  // `log` is off for a pinch's moves, which arrive dozens a second and are refused for the reason its start was.
  private unsupported(what: string, log = true): boolean {
    this.refusal = `${what} cannot be sent to a USB-connected device: XCUITest has no way to send it`
    if (log) logger.warn(this.refusal)
    return false
  }
}

function coord(v: number): string {
  return String(Math.round(Math.min(1, Math.max(0, v)) * 10_000) / 10_000)
}
