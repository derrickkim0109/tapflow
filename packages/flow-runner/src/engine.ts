import type { UIElement } from '@tapflowio/agent-core'
import type { LaunchApplied, LaunchOptions } from '@tapflowio/protocol'
import type { Flow, Selector, Step, ScrollDirection } from './schema.js'
import { matchSelector } from './selector.js'
import { suggestSelectors, type SelectorSuggestion } from './suggest.js'
import { EnvironmentStepError, isEnvironmentStepFailure, TransientQueryError } from './errors.js'

// Transport-agnostic device surface the engine drives (DIP): the relay-backed
// implementation lives in RelayDriver, tests use fakes, and mcp-server adapts
// its own client. All coordinates are normalized 0-1.
export interface FlowDriver {
  // Optional AbortSignal so a stalled query can't block the poll loop past the step deadline.
  queryUITree(signal?: AbortSignal): Promise<UIElement[]>
  tap(x: number, y: number): Promise<void>
  swipe(from: [number, number], to: [number, number], durationMs: number): Promise<void>
  inputText(text: string): Promise<void>
  pressKey(code: string): Promise<void>
  openUrl(url: string): Promise<void>
  /**
   * With options, the app is started fresh with them, or the launch fails; they are never dropped (#1047). Resolves to
   * the names applied, which can include the relay's per-app defaults; `void` keeps a driver that predates it valid.
   */
  launchApp(options?: LaunchOptions): Promise<LaunchApplied | void>
  clearState(appId: string): Promise<void>
  screenshot(signal?: AbortSignal): Promise<Buffer>
}

export interface EngineOptions {
  defaultTimeoutMs?: number
  pollIntervalMs?: number
  /**
   * Capture the screen a passed flow ends on (`lastScreenshot`): the evidence that "passed" means what it says — a
   * login flow that passed shows the screen it logged in to. Off by default, because it costs a screenshot per flow;
   * the CLI turns it on while it is recording the run.
   */
  captureLastScreen?: boolean
  /** Told as each step starts and ends — the run's video marks its timeline with them. Must not throw. */
  /** `label`, on a step's start, is its name as watchers may see it (`activityLabel`). */
  onStep?: (mark: { index: number; name: string; phase: 'start' | 'end'; status?: 'passed' | 'failed'; label?: string }) => void
}

export interface StepResult {
  index: number
  name: string
  status: 'passed' | 'failed' | 'skipped'
  durationMs: number
  message?: string
  /** A `tapOn` that matched nothing or several: lines to try instead, from the screen it failed on (B2). Each taps
   *  exactly the element it names on that screen. Absent when nothing on it was close. */
  suggestions?: SelectorSuggestion[]
}

export type { SelectorSuggestion }

export interface FlowResult {
  name: string
  file?: string
  status: 'passed' | 'failed'
  steps: StepResult[]
  durationMs: number
  failureMessage?: string
  failureScreenshot?: Buffer
  /** The screen a passed flow ended on, when `captureLastScreen` asked for it and it could be taken. */
  lastScreenshot?: Buffer
  /**
   * Which side failed: 'environment' for relay/agent/session-level causes (the CLI
   * exits 2), 'product' for selector, assertion and other failures (exit 1). Present
   * exactly when status is 'failed'. The engine is what classifies, so consumers
   * (CLI, MCP) never branch on prose.
   */
  failureKind?: 'environment' | 'product'
}

const DEFAULT_TIMEOUT_MS = 10_000
const DEFAULT_POLL_INTERVAL_MS = 500
const FAILURE_SCREENSHOT_TIMEOUT_MS = 10_000
/** Shorter than a failure's: a passed flow is waited on by the next one, and this is evidence, not diagnosis. */
const LAST_SCREEN_TIMEOUT_MS = 5_000
const MAX_TIMER_MS = 2_147_483_647

// scroll direction = where the user wants to reveal more content, so the
// finger gesture goes the opposite way (scroll down → swipe up).
const SCROLL_GESTURES: Record<ScrollDirection, { from: [number, number]; to: [number, number] }> = {
  down: { from: [0.5, 0.7], to: [0.5, 0.3] },
  up: { from: [0.5, 0.3], to: [0.5, 0.7] },
  right: { from: [0.8, 0.5], to: [0.2, 0.5] },
  left: { from: [0.2, 0.5], to: [0.8, 0.5] },
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
const round4 = (n: number): number => Math.round(n * 10000) / 10000

async function captureScreenshot(driver: FlowDriver, timeoutMs: number): Promise<Buffer | undefined> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      driver.screenshot(controller.signal),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => {
          controller.abort()
          resolve(undefined)
        }, timeoutMs)
      }),
    ])
  } catch {
    return undefined
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

function describeSelector(sel: Selector): string {
  if (sel.text !== undefined) return `"${sel.text}"`
  const parts: string[] = []
  if (sel.id !== undefined) parts.push(`id="${sel.id}"`)
  if (sel.label !== undefined) parts.push(`label="${sel.label}"`)
  if (sel.role !== undefined) parts.push(`role=${sel.role}`)
  if (sel.index !== undefined) parts.push(`index=${sel.index}`)
  return parts.join(', ')
}

// What a run record and a failure message show. Argument values are shown, since they are what makes this launch
// differ from a plain one; env values never are, because env is where a flow is told to put a secret.
function describeLaunchOptions(opts: LaunchOptions): string {
  const args = Object.entries(opts.arguments ?? {}).map(([k, v]) => `${k}=${JSON.stringify(v)}`)
  const env = Object.keys(opts.env ?? {}).map((k) => `${k}=***`)
  return [...args, ...(env.length > 0 ? [`env ${env.join(', ')}`] : [])].join(', ')
}

// The step's own options, then the keys the relay's per-app defaults added (names only: their values are not sent
// back, and a run record must not depend on reading the relay's config to be understood). The relay keeps a step name
// to 500 characters, so a launch with dozens of long keys loses the last of them there.
function describeLaunch(options: LaunchOptions | undefined, applied: LaunchApplied | void): string {
  const own = options ? describeLaunchOptions(options) : ''
  const args = applied ? applied.arguments.filter((k) => !Object.hasOwn(options?.arguments ?? {}, k)) : []
  const env = applied ? applied.env.filter((k) => !Object.hasOwn(options?.env ?? {}, k)) : []
  const config = [...args, ...(env.length > 0 ? [`env ${env.join(', ')}`] : [])].join(', ')
  const parts = [own, config ? `config: ${config}` : ''].filter(Boolean).join('; ')
  return parts ? `launchApp(${parts})` : 'launchApp'
}

function describeStep(step: Step): string {
  switch (step.type) {
    case 'clearState': return step.appId ? `clearState(${step.appId})` : 'clearState'
    case 'launchApp': return describeLaunch(step.options, undefined)
    case 'tapOn': return `tapOn(${describeSelector(step.selector)})`
    case 'inputText': return `inputText("${step.text}")`
    case 'pressKey': return `pressKey(${step.code})`
    case 'swipe': return `swipe(${step.from} → ${step.to})`
    case 'scroll': return `scroll(${step.direction})`
    case 'openUrl': return `openUrl(${step.url})`
    case 'assertVisible': return `assertVisible(${describeSelector(step.selector)})`
    case 'assertNotVisible': return `assertNotVisible(${describeSelector(step.selector)})`
  }
}

/**
 * A step's name as the watchers of a session may see it (A2) — the whole team, live. Unlike `describeStep`, which
 * JUnit, video marks and `run_flow`'s results keep using, it drops what a flow types (`inputText`), the URL it opens
 * (a deep link can carry a token) and a key that types a character. Keep the key rule in step with the relay's
 * `keyForWatchers`.
 */
export function activityLabel(step: Step): string {
  switch (step.type) {
    case 'inputText': return `inputText (${[...step.text].length} chars)`
    case 'openUrl': return 'openUrl'
    case 'pressKey': return `pressKey(${typesCharacter(step.code) ? 'character' : step.code})`
    default: return describeStep(step)
  }
}

function typesCharacter(code: string): boolean {
  return /^(Key[A-Z]|Digit\d|Numpad\d|Numpad(Add|Subtract|Multiply|Divide|Decimal|Comma|Equal|ParenLeft|ParenRight|Hash|Star)|Space|Minus|Equal|Bracket(Left|Right)|Backslash|Semicolon|Quote|Backquote|Comma|Period|Slash|IntlBackslash|IntlRo|IntlYen)$/.test(code)
    || code.length === 1
}

function normalizeTimeoutMs(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0 || value > MAX_TIMER_MS) {
    throw new EnvironmentStepError(`${label} must be a positive finite duration no greater than ${MAX_TIMER_MS}ms`)
  }
  const rounded = Math.round(value)
  if (rounded <= 0) {
    throw new EnvironmentStepError(`${label} must be at least 1ms (got ${value}ms, which rounds to 0ms)`)
  }
  return rounded
}

export { matchSelector } from './selector.js'

class StepFailure extends Error {
  suggestions?: SelectorSuggestion[]
}

// Query the tree, surfacing a transient failure (foreground race, idle timeout, agent/network blip)
// so the polling caller keeps waiting until its deadline. Permanent failures propagate and fail now.
// The query is bounded by an AbortSignal set to the remaining deadline so a stalled response can't
// block the loop past the step's timeout.
async function queryOrRetry(
  driver: FlowDriver,
  deadline: number,
): Promise<{ tree: UIElement[] } | { transient: TransientQueryError }> {
  const signal = AbortSignal.timeout(Math.max(1, deadline - Date.now()))
  try {
    return { tree: await driver.queryUITree(signal) }
  } catch (e) {
    if (e instanceof TransientQueryError) {
      if (signal.aborted) cutAtDeadline.add(e)
      return { transient: e }
    }
    throw e
  }
}

/** Queries this runner cut off itself because the step's deadline came, not because anything failed. */
const cutAtDeadline = new WeakSet<TransientQueryError>()

/** A query cut off at the deadline does not replace a real error seen before it. */
function latestError(prev: TransientQueryError | undefined, next: TransientQueryError): TransientQueryError {
  return prev && cutAtDeadline.has(next) ? prev : next
}

function withLastError(base: string, lastError: TransientQueryError | undefined): string {
  return lastError ? `${base} (last query error: ${lastError.message})` : base
}

function queryDeadlineFailure(base: string, lastError: TransientQueryError | undefined): Error {
  const message = withLastError(base, lastError)
  return lastError
    ? new EnvironmentStepError(message, { cause: lastError })
    : new StepFailure(message)
}

// The single place a poll loop gives up at its deadline. A trailing transient
// blip must not turn a product miss into an environment failure: when a tree
// was seen, the element genuinely never matched, so the deadline stays a
// StepFailure (product). Both exits — the direct check and the wait below —
// go through here, since timing decides which one fires and they must agree.
//
// A query this runner cut off at the deadline is left out of a product failure's message: it names nothing that went
// wrong, and read as `last query error: … aborted due to timeout` it sent people after the agent when the selector
// simply never matched. With no tree seen it stays: then the query never answering is the finding.
function deadlineError(base: string, lastError: TransientQueryError | undefined, sawTree: boolean): Error {
  if (!sawTree) return queryDeadlineFailure(base, lastError)
  return new StepFailure(withLastError(base, lastError && cutAtDeadline.has(lastError) ? undefined : lastError))
}

async function waitForNextPoll(deadline: number, pollIntervalMs: number, base: string, lastError: TransientQueryError | undefined, sawTree: boolean): Promise<void> {
  const remaining = deadline - Date.now()
  if (remaining <= 0) throw deadlineError(base, lastError, sawTree)
  await delay(Math.min(pollIntervalMs, remaining))
  if (Date.now() >= deadline) throw deadlineError(base, lastError, sawTree)
}

async function resolveOne(
  driver: FlowDriver,
  sel: Selector,
  timeoutMs: number,
  pollIntervalMs: number,
): Promise<UIElement> {
  const waitMs = normalizeTimeoutMs(sel.timeoutMs ?? timeoutMs, 'selector timeout')
  const deadline = Date.now() + waitMs
  let lastError: TransientQueryError | undefined
  let sawTree = false
  // The last screen seen, for suggestions if the step fails on it. A failure with no tree behind it is the
  // environment's, and has nothing to suggest from.
  let lastTree: UIElement[] | null = null
  try {
    for (;;) {
      const q = await queryOrRetry(driver, deadline)
      if ('tree' in q) {
        sawTree = true
        lastTree = q.tree
        lastError = undefined // a successful query clears any earlier transient error
        const matches = matchSelector(q.tree, sel)
        if (matches.length === 1) return matches[0]
        if (matches.length > 1) {
          const described = matches.slice(0, 5).map((m) => `${m.role} "${m.label}"${m.identifier ? ` id=${m.identifier}` : ''}${m.placeholder ? ` placeholder="${m.placeholder}"` : ''}`).join(' | ')
          throw new StepFailure(`${matches.length} elements match ${describeSelector(sel)} — add an index or a more specific role/label (candidates: ${described})`)
        }
      } else {
        lastError = latestError(lastError, q.transient)
      }
      const base = `no element matched ${describeSelector(sel)} within ${waitMs / 1000}s`
      if (Date.now() >= deadline) throw deadlineError(base, lastError, sawTree)
      await waitForNextPoll(deadline, pollIntervalMs, base, lastError, sawTree)
    }
  } catch (e) {
    if (e instanceof StepFailure && lastTree) {
      const suggestions = suggestSelectors(lastTree, sel)
      if (suggestions.length > 0) e.suggestions = suggestions
    }
    throw e
  }
}

async function waitVisible(driver: FlowDriver, sel: Selector, timeoutMs: number, pollIntervalMs: number): Promise<void> {
  const waitMs = normalizeTimeoutMs(sel.timeoutMs ?? timeoutMs, 'selector timeout')
  const deadline = Date.now() + waitMs
  let lastError: TransientQueryError | undefined
  let sawTree = false
  for (;;) {
    const q = await queryOrRetry(driver, deadline)
    if ('tree' in q) {
      sawTree = true
      lastError = undefined // a successful query clears any earlier transient error
      if (matchSelector(q.tree, sel).length > 0) return
    } else {
      lastError = latestError(lastError, q.transient)
    }
    const base = `no element matched ${describeSelector(sel)} within ${waitMs / 1000}s`
    if (Date.now() >= deadline) throw deadlineError(base, lastError, sawTree)
    await waitForNextPoll(deadline, pollIntervalMs, base, lastError, sawTree)
  }
}

async function waitNotVisible(driver: FlowDriver, sel: Selector, timeoutMs: number, pollIntervalMs: number): Promise<void> {
  const waitMs = normalizeTimeoutMs(sel.timeoutMs ?? timeoutMs, 'selector timeout')
  const deadline = Date.now() + waitMs
  let lastError: TransientQueryError | undefined
  let sawTree = false
  for (;;) {
    const q = await queryOrRetry(driver, deadline)
    if ('tree' in q) {
      sawTree = true
      lastError = undefined // a successful query clears any earlier transient error
      if (matchSelector(q.tree, sel).length === 0) return
    } else {
      // A transient failure means we can't confirm the element is gone — keep polling, don't return.
      lastError = latestError(lastError, q.transient)
    }
    const base = `element ${describeSelector(sel)} is still visible after ${waitMs / 1000}s`
    if (Date.now() >= deadline) throw deadlineError(base, lastError, sawTree)
    await waitForNextPoll(deadline, pollIntervalMs, base, lastError, sawTree)
  }
}

/**
 * After `launchApp`, wait for the app's first screen before the next step. A coordinate step sent before that —
 * `scroll`, `swipe`, `inputText`, `pressKey` — is acknowledged by the agent and dropped by the app, so it passed
 * while doing nothing and the flow failed one step later under the wrong name (seen on iOS: `scroll` right after
 * `launchApp`, 5 of 5). Selector steps never had this problem: they poll.
 *
 * **Ready is the tree's structure holding still for `SETTLE_MS`**, not the first tree that reads. An app that draws
 * its own splash answers with the splash first — measured on a Flutter iOS app: one element, then the real screen
 * 45–270 ms later — so a single read cannot tell the two apart. The structure is each element's role, label and
 * identifier, in order: frames are left out because an animating screen moves them forever. An empty tree is a
 * structure like any other, so a game, a canvas or a WebView-only screen is ready once it has read empty for a
 * second, instead of waiting out the timeout.
 *
 * It rests on what the agents promise (see `DeviceAgent.queryUITree`): a read fails until the launched app's UI is
 * up (iOS), or the launch reply already waited for the first frame (Android). An agent that answered an empty tree
 * before then would read as settled.
 *
 * **Best effort: it never fails the step.** A screen whose labels keep changing (a carousel, a running clock) never
 * holds still, so no new read starts once `SETTLE_CAP_MS` has passed since the first successful read; the one in
 * flight still counts. A query that fails is the next
 * step's to report, as it was before. A splash that holds still for longer than `SETTLE_MS` still reads as ready.
 */
async function waitForScreen(driver: FlowDriver, timeoutMs: number, pollIntervalMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let shape: string | undefined
  // When this structure was first read. Not the previous read's time: iOS reads land ~550 ms apart, so requiring
  // SETTLE_MS between two consecutive reads would never be met there.
  let shapeSince = 0
  let settleBy = deadline
  try {
    for (;;) {
      const started = Date.now()
      // Bounded by the step's deadline, not the cap: the cap only decides whether to start another read. Cutting a
      // read at the cap would abort every confirming read on a device whose dump takes close to it (~2.5 s on an
      // emulator), and a screen that holds still would always wait the full cap there.
      const q = await queryOrRetry(driver, deadline)
      const now = Date.now()
      // A failed read neither confirms nor resets: on iOS it means "not up yet", and on Android one costs a dump.
      if ('tree' in q) {
        if (shape === undefined) settleBy = Math.min(deadline, now + SETTLE_CAP_MS)
        const next = screenShape(q.tree)
        if (next !== shape) {
          shape = next
          shapeSince = now
        } else if (now - shapeSince >= SETTLE_MS) {
          return
        }
      }
      if (now >= settleBy) return
      // The poll interval counts from the read's start: an Android dump alone takes ~2.5 s.
      await delay(Math.min(Math.max(0, pollIntervalMs - (now - started)), settleBy - now))
    }
  } catch {
    // Not this step's to report, permanent errors included. `launchApp` never read the tree before, so failing
    // here would fail flows that use no selector on any agent whose tree is unusable — one predating the frame
    // clipping answers `invalid response shape`, permanently. A session that is really gone fails the next step,
    // which names it the same way.
  }
}

const SETTLE_MS = 1000
const SETTLE_CAP_MS = 3 * SETTLE_MS

// JSON, not a joined string: a label containing the separator would make two different screens equal.
function screenShape(tree: UIElement[]): string {
  return JSON.stringify(tree.map((e) => [e.role, e.label, e.identifier ?? '']))
}

// Resolves to what a launch applied; every other step to nothing.
async function executeStep(step: Step, flow: Flow, driver: FlowDriver, timeoutMs: number, pollIntervalMs: number): Promise<LaunchApplied | void> {
  switch (step.type) {
    case 'clearState': {
      // `parseFlow` rejects the bare form without a flow-level appId, but `runFlow` is exported and does not
      // parse — an embedder can hand it a `Flow` built by hand, and `flow.appId!` used to launder that into
      // `app:clear-state` with `payload: {}` on the wire for the device to answer 'bundleId missing'. Refuse
      // here instead, where the cause is still nameable. Empty string too: `''` type-checks all the way down.
      const appId = step.appId ?? flow.appId
      if (!appId) throw new StepFailure('clearState has no app id — set it on the step or as the flow-level "appId"')
      await driver.clearState(appId)
      return
    }
    case 'launchApp': {
      const applied = await driver.launchApp(step.options)
      // Never throws: an app that dies on a default fails the next step, and this one's name already says which.
      await waitForScreen(driver, timeoutMs, pollIntervalMs)
      return applied
    }
    case 'tapOn': {
      const el = await resolveOne(driver, step.selector, timeoutMs, pollIntervalMs)
      return driver.tap(round4(el.frame.x + el.frame.width / 2), round4(el.frame.y + el.frame.height / 2))
    }
    case 'inputText': return driver.inputText(step.text)
    case 'pressKey': return driver.pressKey(step.code)
    case 'swipe': return driver.swipe(step.from, step.to, step.durationMs)
    case 'scroll': {
      const g = SCROLL_GESTURES[step.direction]
      return driver.swipe(g.from, g.to, 300)
    }
    case 'openUrl': return driver.openUrl(step.url)
    case 'assertVisible': return waitVisible(driver, step.selector, timeoutMs, pollIntervalMs)
    case 'assertNotVisible': return waitNotVisible(driver, step.selector, timeoutMs, pollIntervalMs)
  }
}

export async function runFlow(flow: Flow, driver: FlowDriver, options: EngineOptions = {}): Promise<FlowResult> {
  const timeoutMs = normalizeTimeoutMs(options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS, 'default timeout')
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
  const started = Date.now()
  const steps: StepResult[] = []
  let failureMessage: string | undefined
  let failureKind: 'environment' | 'product' | undefined
  let failureScreenshot: Buffer | undefined

  for (const [index, step] of flow.steps.entries()) {
    const started = describeStep(step)
    if (failureMessage !== undefined) {
      steps.push({ index, name: started, status: 'skipped', durationMs: 0 })
      continue
    }
    const stepStart = Date.now()
    options.onStep?.({ index, name: started, phase: 'start', label: activityLabel(step) })
    try {
      const applied = await executeStep(step, flow, driver, timeoutMs, pollIntervalMs)
      // Known only once the launch answers, so the start mark carries the name without the relay's defaults.
      const name = step.type === 'launchApp' && applied ? describeLaunch(step.options, applied) : started
      steps.push({ index, name, status: 'passed', durationMs: Date.now() - stepStart })
      options.onStep?.({ index, name, phase: 'end', status: 'passed' })
    } catch (e) {
      const name = started
      const message = e instanceof Error ? e.message : String(e)
      failureMessage = `${name}: ${message}`
      if (failureKind === undefined) failureKind = isEnvironmentStepFailure(e) ? 'environment' : 'product'
      const suggestions = e instanceof StepFailure ? e.suggestions : undefined
      steps.push({ index, name, status: 'failed', durationMs: Date.now() - stepStart, message, ...(suggestions ? { suggestions } : {}) })
      options.onStep?.({ index, name, phase: 'end', status: 'failed' })
      failureScreenshot = await captureScreenshot(driver, FAILURE_SCREENSHOT_TIMEOUT_MS)
    }
  }

  const result: FlowResult = {
    name: flow.name,
    status: failureMessage === undefined ? 'passed' : 'failed',
    steps,
    // Before the last-screen capture: it is evidence taken after the flow, not part of how long the flow took.
    durationMs: Date.now() - started,
  }
  if (failureMessage === undefined && options.captureLastScreen) {
    const shot = await captureScreenshot(driver, LAST_SCREEN_TIMEOUT_MS)
    if (shot !== undefined) result.lastScreenshot = shot
  }
  if (flow.file !== undefined) result.file = flow.file
  if (failureMessage !== undefined) result.failureMessage = failureMessage
  if (failureKind !== undefined) result.failureKind = failureKind
  if (failureScreenshot !== undefined) result.failureScreenshot = failureScreenshot
  return result
}
