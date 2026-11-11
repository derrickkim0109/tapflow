// `tapflow maestro` — Maestro's own command log, read back as
// the step list a run record shows.
import type { FlowReport } from '../lib/runRecorder.js'

type Step = FlowReport['steps'][number]
type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

/** The relay's caps: a step list over 1000 is refused whole, a message over 2000 characters is cut. */
const MAX_STEPS = 1000
const MAX_NAME = 200
const MAX_MESSAGE = 2000

/** The field of a command worth showing beside its name, first found wins. */
const DETAIL_KEYS = ['textRegex', 'idRegex', 'text', 'path', 'file', 'sourceDescription', 'link', 'appId', 'key', 'direction'] as const

function detail(v: unknown, depth = 0): string | undefined {
  if (!isObj(v) || depth > 3) return undefined
  for (const k of DETAIL_KEYS) if (typeof v[k] === 'string' && v[k] !== '') return v[k] as string
  for (const child of Object.values(v)) {
    const found = detail(child, depth + 1)
    if (found) return found
  }
  return undefined
}

/** `tapOnElement "Send"` from `{ tapOnElement: { selector: { textRegex: "Send" } } }`, the evaluated form when there is one. */
export function describeCommand(command: unknown): string {
  if (!isObj(command)) return 'command'
  const key = Object.keys(command)[0] ?? 'command'
  const name = key.replace(/Command$/, '')
  // A runFlow's selector is its condition, not its own: show the condition so `when: visible` is legible.
  const d = name === 'runFlow' && isObj(command[key]) ? detail((command[key] as Obj).condition) ?? detail((command[key] as Obj).sourceDescription) : detail(command[key])
  const text = d === undefined ? name : `${name} ${JSON.stringify(d)}`
  return text.length > MAX_NAME ? `${text.slice(0, MAX_NAME - 1)}…` : text
}

/**
 * What `commands-(<flow>).json` says each top-level command did. `SKIPPED` is a `when:` that did not hold, and
 * `WARNED` an `optional` command that failed — the flow went on, so it reads as passed with Maestro's message.
 * Anything else that is not `COMPLETED` or `FAILED` (a command never reached) is shown as skipped.
 */
export function stepsFromCommands(doc: unknown, redact: (text: string) => string = (t) => t): Step[] {
  if (!Array.isArray(doc)) return []
  const steps: Step[] = []
  for (const entry of doc) {
    if (steps.length === MAX_STEPS) break
    if (!isObj(entry)) continue
    const meta = isObj(entry.metadata) ? entry.metadata : {}
    const raw = typeof meta.status === 'string' ? meta.status : ''
    const status = raw === 'COMPLETED' || raw === 'WARNED' ? 'passed' : raw === 'FAILED' ? 'failed' : 'skipped'
    const err = isObj(meta.error) && typeof meta.error.message === 'string' ? meta.error.message : undefined
    const message = err ?? (raw === 'WARNED' ? 'optional — did not hold, flow went on' : undefined)
    steps.push({
      index: steps.length,
      // Redacted: `inputText: ${TEST_PIN}` is evaluated to the PIN itself.
      name: redact(describeCommand(meta.evaluatedCommand ?? entry.command)),
      status,
      durationMs: typeof meta.duration === 'number' && meta.duration >= 0 ? Math.round(meta.duration) : 0,
      ...(message ? { message: redact(message).slice(0, MAX_MESSAGE) } : {}),
    })
  }
  return steps
}

/** The last lines of Maestro's output that say why it failed, for the record's failure message. */
export function failureSummary(log: string, maxChars = 1500, redact: (text: string) => string = (t) => t): string {
  const lines = redact(log).split('\n').map((l) => l.trimEnd()).filter((l) => l.length > 0)
  const tail = lines.slice(-15).join('\n')
  return tail.length > maxChars ? tail.slice(tail.length - maxChars) : tail
}

/**
 * Lines in Maestro's output that mean it never had the app in hand — the phone, its driver or the port forward
 * failed — so a failure after them is the environment's, not the app's, however many steps had passed.
 */
const ENVIRONMENT_FAILURE = [
  /driver (?:is )?not ready/i,
  /Requested driver host port \d+ is not available/i,
  /Device .* (?:not connected|not found)/i,
  /(?:Connection|connect) (?:refused|reset)/i,
  /UNAVAILABLE: io exception/i,
  /XCTestDriver|iOS driver (?:did not start|not ready)/i,
  /adb: device .* not found|device offline/i,
  /Unable to launch app/i,
]

/**
 * Who a failed run is on, in the record's two kinds. `environment` — not the app: Maestro never reached it (no step
 * ran), lost the phone midway (a driver/connection line in its output), or refused the flow file itself
 * (YAML/syntax: the test's own fault, which the record has no kind for). Otherwise `product` — an assertion or tap
 * failed in the app.
 */
export function failureKindOf(log: string, stepCount: number): 'environment' | 'product' {
  if (/Parsing Failed|Invalid command|YAMLException|Flow file .* not found|Unknown property/i.test(log)) return 'environment'
  if (stepCount === 0) return 'environment'
  return ENVIRONMENT_FAILURE.some((re) => re.test(log)) ? 'environment' : 'product'
}
