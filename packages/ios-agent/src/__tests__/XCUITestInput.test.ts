import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { XCUITestInput, LONG_PRESS_MS } from '../XCUITestInput.js'
import type { RunnerInputClient } from '../XCUITreeReader.js'

// The runner seam, scripted. Its HTTP side is XCUITreeReader's tests'.
function make(opts: { state?: 'ready' | 'starting' | 'unavailable'; bundleId?: string | null } = {}) {
  const runner = {
    state: vi.fn(() => opts.state ?? 'ready'),
    warm: vi.fn(),
    request: vi.fn(async (_path: string, _body?: string) => {}),
  } satisfies RunnerInputClient
  const input = new XCUITestInput({ runner, foregroundBundleId: () => opts.bundleId ?? null })
  input.start()
  return { input, runner }
}

// Requests are chained; let the queue drain.
const flush = () => vi.advanceTimersByTimeAsync(0)

describe('XCUITestInput', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  describe('touches', () => {
    // Mutation: send a drag for every touch. A tap would then be a 0-length press-and-drag, which XCUITest plays
    // as a press that some controls (a UISwitch) do not take.
    it('sends a short touch that did not move as one tap', async () => {
      const { input, runner } = make()
      expect(input.touchStart(0.25, 0.5)).toBe(true)
      expect(input.touchMove(0.251, 0.5)).toBe(true)
      vi.advanceTimersByTime(80)
      expect(input.touchEnd()).toBe(true)
      await flush()
      expect(runner.request.mock.calls).toEqual([['/tap?x=0.25&y=0.5', undefined]])
    })

    // Mutation: send each touchMove as it arrives. XCUITest has no per-frame touch, so a swipe would become a run of taps.
    it('buffers a moving touch into one drag from start to end over its duration', async () => {
      const { input, runner } = make()
      input.touchStart(0.5, 0.8)
      vi.advanceTimersByTime(100)
      input.touchMove(0.5, 0.6)
      vi.advanceTimersByTime(200)
      input.touchMove(0.5, 0.2)
      input.touchEnd()
      await flush()
      expect(runner.request).toHaveBeenCalledTimes(1)
      expect(runner.request).toHaveBeenCalledWith('/drag?x1=0.5&y1=0.8&x2=0.5&y2=0.2&ms=300', undefined)
    })

    // Mutation: decide tap vs drag on the end point only. A swipe that came back to where it began would tap.
    it('keeps a touch that moved and came back a drag', async () => {
      const { input, runner } = make()
      input.touchStart(0.5, 0.5)
      input.touchMove(0.5, 0.7)
      input.touchMove(0.5, 0.5)
      input.touchEnd()
      await flush()
      expect(runner.request.mock.calls[0]![0]).toMatch(/^\/drag\?/)
    })

    // Mutation: drop the duration check. A long press would arrive as a tap and never open a context menu.
    it('sends a touch held still past the long-press threshold as a press in place', async () => {
      const { input, runner } = make()
      input.touchStart(0.4, 0.4)
      vi.advanceTimersByTime(LONG_PRESS_MS + 300)
      input.touchEnd()
      await flush()
      expect(runner.request).toHaveBeenCalledWith(`/drag?x1=0.4&y1=0.4&x2=0.4&y2=0.4&ms=${LONG_PRESS_MS + 300}`, undefined)
    })

    // Mutation: answer `true` while the runner is starting. IOSAgent would ack a touch the runner never gets.
    it('takes no touch until the runner is ready, and owns no gesture then', () => {
      const { input, runner } = make({ state: 'starting' })
      expect(input.touchStart(0.5, 0.5)).toBe(false)
      expect(input.ownsGesture()).toBe(false)
      expect(input.touchEnd()).toBe(false)
      expect(runner.request).not.toHaveBeenCalled()
    })

    // Mutation: forget to clear the touch on end. A second end would replay the gesture.
    it('ends a gesture once', async () => {
      const { input, runner } = make()
      input.touchStart(0.5, 0.5)
      expect(input.ownsGesture()).toBe(true)
      expect(input.touchEnd()).toBe(true)
      expect(input.touchEnd()).toBe(false)
      expect(input.ownsGesture()).toBe(false)
      await flush()
      expect(runner.request).toHaveBeenCalledTimes(1)
    })

    // Mutation: hold the end for MIN_CONTACT_MS as TouchHelper does. The runner times its own tap; the hold would only
    // delay the ack.
    it('ends at once when asked for minimum contact', async () => {
      const { input } = make()
      input.touchStart(0.5, 0.5)
      await expect(input.touchEndAfterMinContact()).resolves.toBe(true)
    })

    // Mutation: fire requests without chaining them. A tap that focuses a field could then land after the text.
    it('sends requests one at a time, in order', async () => {
      const { input, runner } = make()
      let release!: () => void
      runner.request.mockImplementationOnce(() => new Promise<void>((r) => { release = r }))
      input.touchStart(0.5, 0.5)
      input.touchEnd()
      input.sendKey(0x04)
      await flush()
      expect(runner.request).toHaveBeenCalledTimes(1)
      release()
      await flush()
      expect(runner.request.mock.calls.map((c) => c[0])).toEqual(['/tap?x=0.5&y=0.5', '/type'])
    })

    // Mutation: let a rejected request break the chain. Every later input would then be dropped silently.
    it('keeps sending after the runner refuses one', async () => {
      const { input, runner } = make()
      runner.request.mockRejectedValueOnce(new Error('no element has keyboard focus'))
      input.sendKey(0x28)
      input.touchStart(0.1, 0.1)
      input.touchEnd()
      await flush()
      expect(runner.request).toHaveBeenCalledTimes(2)
    })
  })

  describe('keys', () => {
    // Mutation: ignore the shift bit. Capitals and symbols would type as their unshifted keys.
    it('types a character, shifted when shift is held', async () => {
      const { input, runner } = make()
      expect(input.sendKey(0x04)).toBe(true)
      expect(input.sendKey(0x04, 0x02)).toBe(true)
      expect(input.sendKey(0x1e, 0x20)).toBe(true)
      expect(input.sendKey(0x2c)).toBe(true)
      await flush()
      expect(runner.request.mock.calls).toEqual([['/type', 'a'], ['/type', 'A'], ['/type', '!'], ['/type', ' ']])
    })

    // Mutation: type Enter as "\n" text. The runner's /key plays XCUIKeyboardKey.return, which a field's
    // return-key action needs; Backspace as text would type a literal control character.
    it('sends Enter, Backspace and Tab as named keys', async () => {
      const { input, runner } = make()
      input.sendKey(0x28)
      input.sendKey(0x2a)
      input.sendKey(0x2b)
      await flush()
      expect(runner.request.mock.calls.map((c) => c[0])).toEqual(['/key?name=return', '/key?name=delete', '/key?name=tab'])
    })

    // Mutation: drop `bundleId`. The runner would then look for the focused field in SpringBoard only.
    it('names the foreground app so the runner finds its focused field', async () => {
      const { input, runner } = make({ bundleId: 'com.example.app' })
      input.sendKey(0x05)
      input.sendKey(0x28)
      await flush()
      expect(runner.request.mock.calls).toEqual([
        ['/type?bundleId=com.example.app', 'b'],
        ['/key?name=return&bundleId=com.example.app', undefined],
      ])
    })

    // Mutation: type the character and drop the modifier. ⌘A would type "a" into the field.
    it('refuses a chord with command, control or option', () => {
      const { input, runner } = make()
      expect(input.sendKey(0x04, 0x08)).toBe(false)
      expect(input.sendKey(0x19, 0x01)).toBe(false)
      expect(runner.request).not.toHaveBeenCalled()
    })

    // Mutation: map unknown usages to an empty /type. The ack would say delivered for a key nothing pressed.
    it('refuses a key it has no mapping for', () => {
      const { input, runner } = make()
      expect(input.sendKey(0x4f)).toBe(false) // ArrowRight
      expect(input.sendKey(0x3a)).toBe(false) // F1
      expect(runner.request).not.toHaveBeenCalled()
    })

    // Mutation: send while not ready. A key would be acked and queued behind a runner that never starts.
    it('takes no key while the runner is unavailable', () => {
      const { input, runner } = make({ state: 'unavailable' })
      expect(input.sendKey(0x04)).toBe(false)
      expect(input.typeText('hello')).toBe(false)
      expect(runner.request).not.toHaveBeenCalled()
    })

    // Mutation: split typeText into a request per character. A sentence would then be dozens of round trips.
    it('types a whole string in one request', async () => {
      const { input, runner } = make()
      expect(input.typeText('hello world')).toBe(true)
      await flush()
      expect(runner.request.mock.calls).toEqual([['/type', 'hello world']])
    })
  })

  describe('buttons and unsupported input', () => {
    // Mutation: map legacy code 0 to lock. Home would lock the phone instead.
    it('presses home, and refuses the side button', async () => {
      const { input, runner } = make()
      expect(input.pressLegacyButton(0)).toBe(true)
      expect(input.pressLegacyButton(1)).toBe(false)
      await flush()
      expect(runner.request.mock.calls).toEqual([['/key?name=home', undefined]])
    })

    // Mutation: drop the consumer-page table. Volume keys from the dashboard would be refused.
    it('presses the consumer-page home and volume buttons, and refuses power', async () => {
      const { input, runner } = make()
      expect(input.pressButton(0x0c, 0x40)).toBe(true)
      expect(input.pressButton(0x0c, 0xe9)).toBe(true)
      expect(input.pressButton(0x0c, 0xea)).toBe(true)
      expect(input.pressButton(0x0c, 0x30)).toBe(false)
      await flush()
      expect(runner.request.mock.calls.map((c) => c[0])).toEqual(['/key?name=home', '/key?name=volumeUp', '/key?name=volumeDown'])
    })

    // Mutation: answer `true` for a pinch or a held button. IOSAgent would ack input that never reaches the device.
    it('refuses a pinch and a held button', () => {
      const { input, runner } = make()
      expect(input.pinchStart(0.4, 0.4, 0.6, 0.6)).toBe(false)
      expect(input.pinchMove(0.3, 0.3, 0.7, 0.7)).toBe(false)
      expect(input.pinchEnd()).toBe(false)
      expect(input.pressButtonDown(0x0c, 0x40)).toBe(false)
      expect(input.pressButtonUp(0x0c, 0x40)).toBe(false)
      expect(input.ownsGesture()).toBe(false)
      expect(runner.request).not.toHaveBeenCalled()
    })
  })

  describe('lifecycle', () => {
    // Mutation: skip the warm-up. The first tap would then wait out a cold runner start on the device.
    it('warms the runner on start and reports its state', () => {
      const { input, runner } = make({ state: 'starting' })
      expect(runner.warm).toHaveBeenCalledTimes(1)
      expect(input.inputState()).toBe('starting')
    })

    // Mutation: keep the touch across stop. A relay reconnect would leave a half gesture that the next end replays.
    it('is unavailable after stop and forgets the gesture in flight', () => {
      const { input } = make()
      input.touchStart(0.5, 0.5)
      input.stop()
      expect(input.inputState()).toBe('unavailable')
      expect(input.ownsGesture()).toBe(false)
      expect(input.touchEnd()).toBe(false)
    })
  })
})
