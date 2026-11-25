import { readFileSync } from 'fs'
import path from 'path'
import { LineCounter, isMap, isPair, isScalar, isSeq, parseAllDocuments, visit, type Node, type YAMLMap } from 'yaml'
import type { Flow, Selector, Step } from './schema.js'
import { launchOptionsProblem } from '@tapflowio/protocol/launch'
import type { ImportedFlow, ImportIssue } from './importReport.js'

/**
 * Converts a Maestro flow into a tapflow flow, or reports why it cannot (#1094).
 *
 * The rule the whole file follows: **a flow that cannot be carried over whole is not written at all.** A flow with
 * a command dropped can pass while missing the assertion that command made, and nothing on a green run would say
 * so. So every command that has no tapflow step is reported with its file and line, and the flow's only output is
 * that report. The one exception is a command whose whole effect tapflow already has (`waitForAnimationToEnd`:
 * every tapflow selector waits), reported as `dropped` so the report still says it was there.
 *
 * Maestro is read, not executed: `runFlow` subflows are inlined and `${NAME}` is substituted here, once, so the
 * written flow replays the same way every time and never needs Maestro's spec to run.
 */

export interface MaestroImportOptions {
  /** `${NAME}` values. They win over a flow's own `env`, as Maestro's `-e` does. */
  env?: Record<string, string>
  /** Injected for tests; defaults to reading from disk. */
  readFile?: (file: string) => string
}

class Problem extends Error {}

interface Context {
  issues: ImportIssue[]
  readFile: (file: string) => string
  /** Files being inlined, outermost first, to refuse a `runFlow` cycle. */
  stack: string[]
  appId?: string
  /** Options the command being converted dropped; turned into `dropped` issues at its line. */
  dropped: string[]
}

interface ParsedFile {
  header?: YAMLMap
  commands?: Node
  lines: LineCounter
}

const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/
// Maestro's own default is 50; past this the expansion into one key press per character stops being a flow step.
const MAX_ERASE_CHARACTERS = 1000

/** Whether `name` can be referenced as `${name}` in a Maestro flow, and so set with `--env`. */
export function isEnvName(name: string): boolean {
  return NAME_PATTERN.test(name)
}
const DEFAULT_ERASE_CHARACTERS = 50
// Maestro's own default, so a converted swipe moves as fast as the one it came from.
const DEFAULT_SWIPE_DURATION_MS = 400

// Maestro's swipe `direction` names the way the finger moves; these are the same gestures tapflow's `scroll` makes.
const SWIPE_DIRECTIONS: Record<string, { from: [number, number]; to: [number, number] }> = {
  UP: { from: [0.5, 0.7], to: [0.5, 0.3] },
  DOWN: { from: [0.5, 0.3], to: [0.5, 0.7] },
  LEFT: { from: [0.8, 0.5], to: [0.2, 0.5] },
  RIGHT: { from: [0.2, 0.5], to: [0.8, 0.5] },
}

// Only keys that mean the same thing on both sides. Maestro's `Home` and `Back` are the device's buttons, while
// tapflow's `Home` is the text caret key, so a same-named mapping would press something else.
const KEYS: Record<string, string> = { enter: 'Enter', backspace: 'Backspace', tab: 'Tab' }

export function convertMaestroFlow(file: string, options: MaestroImportOptions = {}): ImportedFlow {
  const ctx: Context = { issues: [], readFile: options.readFile ?? ((f) => readFileSync(f, 'utf-8')), stack: [path.resolve(file)], dropped: [] }
  const fail = (reason: string, line?: number, command = '(file)'): ImportedFlow => {
    ctx.issues.push({ file, ...(line !== undefined ? { line } : {}), command, kind: 'unconverted', reason })
    return { source: file, status: 'not-converted', issues: ctx.issues }
  }

  let parsed: ParsedFile
  try {
    parsed = parseMaestroFile(ctx.readFile(file))
  } catch (e) {
    return fail(e instanceof Problem ? e.message : `cannot read the file: ${(e as Error).message}`)
  }
  const { header, lines } = parsed

  let flowEnv: Record<string, string>
  try {
    flowEnv = stringEnv((header?.toJSON() as Record<string, unknown> | undefined)?.env)
  } catch (e) {
    return fail((e as Error).message, undefined, 'env')
  }
  const env = { ...flowEnv, ...(options.env ?? {}) }

  const { appId, name, tags } = readHeader(header, file, lines, env, ctx, false)
  ctx.appId = appId

  if (parsed.commands === undefined) return fail('no commands — a Maestro flow lists its commands after the "---" line')
  const steps = convertCommands(parsed.commands, file, lines, env, ctx)

  if (ctx.issues.some((i) => i.kind === 'unconverted')) return { source: file, status: 'not-converted', issues: ctx.issues }
  if (steps.length === 0) return fail('no command has a tapflow step, so the flow would do nothing')

  const flow: Flow = {
    name: name ?? path.basename(file).replace(/\.ya?ml$/i, ''),
    ...(appId !== undefined ? { appId } : {}),
    ...(tags !== undefined ? { tags: tags.map((t) => t.trim()) } : {}),
    steps,
  }
  return { source: file, status: 'converted', flow, issues: ctx.issues }
}

/**
 * The config section, for a flow or a subflow alike. A subflow's section is read with the same rules, because its
 * hooks run with it in Maestro: skipping them would drop the commands they hold, assertions included.
 */
function readHeader(
  header: YAMLMap | undefined, file: string, lines: LineCounter, env: Record<string, string>, ctx: Context, subflow: boolean,
): { appId?: string; name?: string; tags?: string[] } {
  const out: { appId?: string; name?: string; tags?: string[] } = {}
  for (const pair of header?.items ?? []) {
    const key = isScalar(pair.key) ? String(pair.key.value) : String(pair.key)
    const line = lineOf(pair.key as Node, lines)
    const value: unknown = (pair.value as Node | null)?.toJSON() ?? null
    try {
      switch (key) {
        case 'appId': {
          const appId = requireString(substitute(value, env), 'appId')
          // A subflow for another app (Settings, say) would have its bare clearState and launchApp act on the app under test.
          if (subflow && ctx.appId !== undefined && appId !== ctx.appId) {
            throw new Problem(`subflow is for ${appId}, not ${ctx.appId} — tapflow drives only the app under test`)
          }
          out.appId = appId
          break
        }
        case 'name': out.name = requireString(substitute(value, env), 'name'); break
        case 'tags':
          if (!Array.isArray(value) || value.some((t) => typeof t !== 'string' || t.trim() === '' || t.includes(','))) {
            throw new Problem('"tags" must be a list of non-empty strings without commas')
          }
          out.tags = value as string[]
          break
        case 'env': break
        // Settings for Maestro's JavaScript, and free-form metadata; neither changes what the commands do.
        case 'jsEngine': case 'properties': break
        case 'onFlowStart': case 'onFlowComplete':
          if (Array.isArray(value) && value.length === 0) break
          throw new Problem(`"${key}" hooks have no tapflow equivalent — move their commands into the flow`)
        default:
          throw new Problem(`config key "${key}" has no tapflow equivalent`)
      }
    } catch (e) {
      if (!(e instanceof Problem)) throw e
      ctx.issues.push({ file, line, command: key, kind: 'unconverted', reason: e.message })
    }
  }
  return out
}

/** The files Maestro runs for a directory: the flows directly in it, not its subflows' folders, never its config. */
export function isMaestroFlowFile(name: string): boolean {
  return /\.ya?ml$/i.test(name) && !/^config\.ya?ml$/i.test(name)
}

function parseMaestroFile(text: string): ParsedFile {
  const lines = new LineCounter()
  const docs = parseAllDocuments(text, { lineCounter: lines })
  if (!Array.isArray(docs)) return { lines }
  for (const doc of docs) {
    const err = doc.errors[0]
    if (err) throw new Problem(`invalid YAML — ${err.message}`)
    // Maestro reads its fields as strings, so `inputText: 01012345678` types the leading zero and `PIN: 0000` is
    // four zeros. YAML would read both as numbers and lose that, so a number whose text says more keeps its text.
    // Launch arguments are the exception: Maestro hands them over as numbers, and an Android app reads them that way.
    visit(doc, {
      Scalar(_, node, ancestors) {
        if (typeof node.value !== 'number' || node.source === undefined || node.source === String(node.value)) return
        if (ancestors.some((a) => isPair(a) && isScalar(a.key) && a.key.value === 'arguments')) return
        node.value = node.source
      },
    })
  }
  const contents = docs.map((d) => d.contents).filter((c): c is NonNullable<typeof c> => c !== null)
  // `appId: x` / `---` / commands is the usual shape; a subflow may be the command list alone.
  if (contents.length === 1 && isSeq(contents[0])) return { commands: contents[0], lines }
  if (contents.length === 1 && isMap(contents[0])) return { header: contents[0], lines }
  if (contents.length === 2 && isMap(contents[0]) && isSeq(contents[1])) return { header: contents[0], commands: contents[1], lines }
  throw new Problem('expected a config section, a "---" line and a list of commands')
}

function lineOf(node: Node | null | undefined, lines: LineCounter): number | undefined {
  const start = node?.range?.[0]
  return start === undefined ? undefined : lines.linePos(start).line
}

function convertCommands(commands: Node, file: string, lines: LineCounter, env: Record<string, string>, ctx: Context): Step[] {
  if (!isSeq(commands)) {
    ctx.issues.push({ file, line: lineOf(commands, lines), command: '(commands)', kind: 'unconverted', reason: 'commands must be a list' })
    return []
  }
  const steps: Step[] = []
  for (const item of commands.items as Node[]) {
    const line = lineOf(item, lines)
    const raw = item.toJSON() as unknown
    let name: string
    let arg: unknown
    if (typeof raw === 'string') {
      name = raw
      arg = undefined
    } else if (isRecord(raw) && Object.keys(raw).length === 1) {
      name = Object.keys(raw)[0]
      arg = raw[name]
    } else {
      ctx.issues.push({ file, line, command: '(unknown)', kind: 'unconverted', reason: 'a command must be a name or a single-key mapping' })
      continue
    }
    try {
      if (name === 'runFlow') {
        steps.push(...inlineSubflow(arg, file, line, env, ctx))
        continue
      }
      ctx.dropped = []
      const converted = convertCommand(name, substitute(arg, env), ctx)
      if (converted === 'dropped') {
        ctx.issues.push({ file, line, command: name, kind: 'dropped', reason: 'tapflow already waits for the screen before every selector' })
      } else {
        steps.push(...converted)
        for (const reason of ctx.dropped) ctx.issues.push({ file, line, command: name, kind: 'dropped', reason })
      }
    } catch (e) {
      if (!(e instanceof Problem)) throw e
      ctx.issues.push({ file, line, command: name, kind: 'unconverted', reason: e.message })
    }
  }
  return steps
}

function inlineSubflow(rawArg: unknown, file: string, line: number | undefined, env: Record<string, string>, ctx: Context): Step[] {
  let target: string | undefined
  let passedEnv: Record<string, string> = {}
  let inline: unknown
  if (typeof rawArg === 'string') {
    target = requireString(substitute(rawArg, env), 'runFlow file')
  } else if (isRecord(rawArg)) {
    const { file: subfile, env: subEnv, commands, when, label: _label, ...rest } = rawArg
    if (when !== undefined) throw new Problem('a conditional "runFlow" (when) has no tapflow step — tapflow flows have no branches')
    rejectKeys(rest, 'runFlow')
    if (subfile !== undefined && commands !== undefined) throw new Problem('"runFlow" takes "file" or "commands", not both')
    if (subfile !== undefined) target = requireString(substitute(subfile, env), 'runFlow file')
    inline = commands
    passedEnv = stringEnv(substitute(subEnv, env))
  } else {
    throw new Problem('"runFlow" takes a file path or { file, env } or { commands }')
  }

  if (target === undefined) {
    if (!Array.isArray(inline)) throw new Problem('"runFlow" needs "file" or a "commands" list')
    // Inline commands have no lines of their own in this file's counter beyond the runFlow, so re-read them as a
    // document; their issues point at the runFlow line.
    const lines = new LineCounter()
    const doc = parseAllDocuments(JSON.stringify(inline), { lineCounter: lines })
    const contents = Array.isArray(doc) ? doc[0]?.contents : undefined
    const before = ctx.issues.length
    const steps = convertCommands(contents as Node, file, lines, { ...env, ...passedEnv }, ctx)
    for (const issue of ctx.issues.slice(before)) if (issue.file === file) issue.line = line
    return steps
  }

  const subPath = path.resolve(path.dirname(file), target)
  if (ctx.stack.includes(subPath)) throw new Problem(`"runFlow" ${target} runs itself through ${ctx.stack.map((f) => path.basename(f)).join(' → ')}`)
  let parsed: ParsedFile
  try {
    parsed = parseMaestroFile(ctx.readFile(subPath))
  } catch (e) {
    throw new Problem(`subflow ${target}: ${e instanceof Problem ? e.message : `cannot read it (${(e as Error).message})`}`)
  }
  if (parsed.commands === undefined) throw new Problem(`subflow ${target} has no commands`)
  // The subflow's own env is its default; what the caller passes wins, then whatever was set for the whole import.
  const subHeader = (parsed.header?.toJSON() ?? {}) as Record<string, unknown>
  const subEnv = { ...stringEnv(subHeader.env), ...env, ...passedEnv }
  readHeader(parsed.header, subPath, parsed.lines, subEnv, ctx, true)
  ctx.stack.push(subPath)
  try {
    return convertCommands(parsed.commands, subPath, parsed.lines, subEnv, ctx)
  } finally {
    ctx.stack.pop()
  }
}

function convertCommand(name: string, arg: unknown, ctx: Context): Step[] | 'dropped' {
  switch (name) {
    case 'launchApp': return convertLaunch(arg, ctx)
    case 'clearState': {
      let appId: string | undefined
      if (arg === undefined || arg === null) appId = undefined
      else if (typeof arg === 'string') appId = arg
      else if (isRecord(arg)) {
        const { appId: id, label: _label, ...rest } = arg
        rejectKeys(rest, 'clearState')
        appId = id === undefined ? undefined : requireString(id, 'clearState appId')
      } else throw new Problem('"clearState" takes an app id or nothing')
      if (appId === undefined && ctx.appId === undefined) throw new Problem('"clearState" needs an app id — set "appId" in the config section')
      return [appId === undefined || appId === ctx.appId ? { type: 'clearState' } : { type: 'clearState', appId }]
    }
    case 'tapOn': return [{ type: 'tapOn', selector: convertSelector(arg, 'tapOn', ctx, TAP_RETRY_OPTIONS) }]
    case 'assertVisible': return [{ type: 'assertVisible', selector: convertSelector(arg, 'assertVisible', ctx) }]
    case 'assertNotVisible': return [{ type: 'assertNotVisible', selector: convertSelector(arg, 'assertNotVisible', ctx) }]
    case 'extendedWaitUntil': {
      if (!isRecord(arg)) throw new Problem('"extendedWaitUntil" takes { visible | notVisible, timeout }')
      const { visible, notVisible, timeout, label: _label, ...rest } = arg
      rejectKeys(rest, 'extendedWaitUntil')
      if ((visible === undefined) === (notVisible === undefined)) throw new Problem('"extendedWaitUntil" needs exactly one of "visible" or "notVisible"')
      const selector = withTimeout(convertSelector(visible ?? notVisible, 'extendedWaitUntil', ctx), timeout)
      return [{ type: visible !== undefined ? 'assertVisible' : 'assertNotVisible', selector }]
    }
    case 'waitForAnimationToEnd': return 'dropped'
    case 'inputText': {
      let text: unknown = arg
      if (isRecord(arg)) {
        const { text: t, label: _label, ...rest } = arg
        rejectKeys(rest, 'inputText')
        text = t
      }
      // Maestro types whatever scalar it is given, `true` and the empty string included.
      if (typeof text === 'number' || typeof text === 'boolean') text = String(text)
      if (typeof text !== 'string') throw new Problem('"inputText" takes text')
      return [{ type: 'inputText', text }]
    }
    case 'eraseText': {
      let count: unknown = arg
      if (isRecord(arg)) {
        const { charactersToErase, label: _label, ...rest } = arg
        rejectKeys(rest, 'eraseText')
        count = charactersToErase
      }
      const n = count === undefined || count === null ? DEFAULT_ERASE_CHARACTERS : Number(count)
      if (!Number.isInteger(n) || n < 1) throw new Problem('"eraseText" takes a positive number of characters')
      if (n > MAX_ERASE_CHARACTERS) throw new Problem(`"eraseText" ${n} is over ${MAX_ERASE_CHARACTERS} characters, each of which would be its own key press`)
      return Array.from({ length: n }, (): Step => ({ type: 'pressKey', code: 'Backspace' }))
    }
    case 'pressKey': {
      const key = typeof arg === 'string' ? KEYS[arg.trim().toLowerCase()] : undefined
      if (key === undefined) throw new Problem(`key "${String(arg)}" has no tapflow pressKey equivalent (supported: Enter, Backspace, Tab)`)
      return [{ type: 'pressKey', code: key }]
    }
    case 'openLink': {
      let link: unknown = arg
      if (isRecord(arg)) {
        const { link: l, autoVerify, browser, label: _label, ...rest } = arg
        if (autoVerify === true) throw new Problem('"openLink" autoVerify has no tapflow equivalent')
        if (browser === true) throw new Problem('"openLink" browser has no tapflow equivalent')
        rejectKeys(rest, 'openLink')
        link = l
      }
      return [{ type: 'openUrl', url: requireString(link, 'openLink') }]
    }
    case 'scroll': {
      if (arg !== undefined && arg !== null && !(isRecord(arg) && Object.keys(arg).every((k) => k === 'label'))) {
        throw new Problem('"scroll" options have no tapflow equivalent')
      }
      return [{ type: 'scroll', direction: 'down' }]
    }
    case 'swipe': return [convertSwipe(arg)]
    default:
      throw new Problem(`Maestro command "${name}" has no tapflow step`)
  }
}

function convertLaunch(arg: unknown, ctx: Context): Step[] {
  if (arg === undefined || arg === null) return [{ type: 'launchApp' }]
  if (typeof arg === 'string') {
    if (ctx.appId !== undefined && arg !== ctx.appId) throw new Problem(`"launchApp" ${arg} is another app — tapflow launches the build under test`)
    return [{ type: 'launchApp' }]
  }
  if (!isRecord(arg)) throw new Problem('"launchApp" takes an app id, options, or nothing')
  const { appId, clearState, clearKeychain, stopApp, permissions, arguments: args, label: _label, ...rest } = arg
  rejectKeys(rest, 'launchApp')
  if (appId !== undefined && ctx.appId !== undefined && appId !== ctx.appId) throw new Problem(`"launchApp" ${String(appId)} is another app — tapflow launches the build under test`)
  if (clearKeychain === true) throw new Problem('"launchApp" clearKeychain has no tapflow equivalent')
  if (stopApp === false) throw new Problem('"launchApp" stopApp: false has no tapflow equivalent — tapflow always relaunches')
  if (permissions !== undefined) throw new Problem('"launchApp" permissions have no tapflow equivalent')
  const steps: Step[] = []
  if (clearState === true) {
    if (ctx.appId === undefined) throw new Problem('"launchApp" clearState needs an app id — set "appId" in the config section')
    steps.push({ type: 'clearState' })
  }
  if (args !== undefined) {
    if (!isRecord(args)) throw new Problem('"launchApp" arguments must be a mapping')
    const problem = launchOptionsProblem({ arguments: args })
    if (problem) throw new Problem(`"launchApp" ${problem}`)
    steps.push({ type: 'launchApp', options: { arguments: args as Record<string, string | number | boolean | string[]> } })
  } else {
    steps.push({ type: 'launchApp' })
  }
  return steps
}

function convertSwipe(arg: unknown): Step {
  if (!isRecord(arg)) throw new Problem('"swipe" takes { direction } or { start, end }')
  const { direction, start, end, duration, from, label: _label, ...rest } = arg
  if (from !== undefined) throw new Problem('"swipe" from an element has no tapflow equivalent — tapflow swipes between points')
  rejectKeys(rest, 'swipe')
  const durationMs = duration === undefined ? DEFAULT_SWIPE_DURATION_MS : Number(duration)
  if (!Number.isFinite(durationMs) || durationMs <= 0) throw new Problem('"swipe" duration must be a positive number of milliseconds')
  if (direction !== undefined) {
    const g = typeof direction === 'string' ? SWIPE_DIRECTIONS[direction.toUpperCase()] : undefined
    if (!g) throw new Problem(`"swipe" direction must be UP, DOWN, LEFT or RIGHT (got ${String(direction)})`)
    return { type: 'swipe', from: g.from, to: g.to, durationMs }
  }
  return { type: 'swipe', from: percentPoint(start, 'start'), to: percentPoint(end, 'end'), durationMs }
}

function percentPoint(v: unknown, key: string): [number, number] {
  const m = typeof v === 'string' ? /^\s*(\d+(?:\.\d+)?)%\s*,\s*(\d+(?:\.\d+)?)%\s*$/.exec(v) : null
  if (!m) throw new Problem(`"swipe" ${key} must be percentages like "50%, 80%" — tapflow has no pixel coordinates`)
  const x = Number(m[1]) / 100
  const y = Number(m[2]) / 100
  if (x > 1 || y > 1) throw new Problem(`"swipe" ${key} must be within 0%–100%`)
  return [x, y]
}

// tapOn options that only tune how Maestro retries a tap. Without them a tap that missed fails the next step,
// so the flow fails louder rather than passing; each is still reported as dropped.
const TAP_RETRY_OPTIONS: ReadonlySet<string> = new Set(['retryTapIfNoChange', 'waitToSettleTimeoutMs'])

function convertSelector(arg: unknown, command: string, ctx: Context, droppable: ReadonlySet<string> = new Set()): Selector {
  if (typeof arg === 'number') arg = String(arg)
  if (typeof arg === 'string') return { text: literalText(arg) }
  if (!isRecord(arg)) throw new Problem(`"${command}" takes text or a selector`)
  const { text, id, index, optional, label: _label, ...rest } = arg
  if (optional === true) {
    throw new Problem(`"optional: true" has no tapflow equivalent — a tapflow step either runs or fails the flow`)
  }
  for (const key of Object.keys(rest)) {
    if (!droppable.has(key)) throw new Problem(`selector option "${key}" has no tapflow equivalent`)
    ctx.dropped.push(`"${key}" tunes how Maestro retries a tap; tapflow taps once and the next step fails if it missed`)
  }
  if (text === undefined && id === undefined) throw new Problem(`"${command}" selector needs "text" or "id"`)
  const selector: Selector = {}
  if (id !== undefined) selector.id = literalText(String(id))
  if (text !== undefined) selector.label = literalText(String(text))
  if (index !== undefined) {
    const n = Number(index)
    if (!Number.isInteger(n) || n < 0) throw new Problem('"index" must be a non-negative integer')
    selector.index = n
  }
  // Text alone keeps tapflow's bare form, which also reads a field's placeholder as Maestro's text does.
  if (selector.label !== undefined && selector.id === undefined && selector.index === undefined) return { text: selector.label }
  return selector
}

function withTimeout(sel: Selector, timeout: unknown): Selector {
  if (timeout === undefined) return sel
  const ms = Number(timeout)
  if (!Number.isFinite(ms) || ms <= 0) throw new Problem('"timeout" must be a positive number of milliseconds')
  // A timeout needs the object form, which reads `text` as a label.
  const { text, ...rest } = sel
  return { ...rest, ...(text !== undefined ? { label: text } : {}), timeoutMs: Math.round(ms) }
}

/**
 * Maestro matches `text` and `id` as a regular expression over the whole value; tapflow matches literally. A pattern
 * that is a literal once its escapes are read converts; anything that matches by pattern does not. `.` is kept as a
 * literal dot: as a pattern it matches any character, but in UI text it is almost always the dot itself.
 */
function literalText(pattern: string): string {
  let out = ''
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]
    if (c === '\\') {
      const next = pattern[i + 1]
      if (next === undefined || /[A-Za-z0-9]/.test(next)) throw new Problem(`"${pattern}" is a regular expression — tapflow matches text literally`)
      out += next
      i++
    } else if ('^$*+?()[]{}|'.includes(c)) {
      throw new Problem(`"${pattern}" is a regular expression — tapflow matches text literally`)
    } else {
      out += c
    }
  }
  if (out.length === 0) throw new Problem('selector text must not be empty')
  return out
}

function substitute(value: unknown, env: Record<string, string>): unknown {
  if (typeof value === 'string') {
    return value.replace(/\$\{([^}]*)\}/g, (_, expr: string) => {
      const key = expr.trim()
      if (!NAME_PATTERN.test(key)) throw new Problem(`"\${${expr}}" is a JavaScript expression — tapflow substitutes only \${NAME} from env`)
      if (!Object.hasOwn(env, key)) throw new Problem(`\${${key}} is not set — define it in the flow's env or pass --env ${key}=…`)
      // A value that still holds `\${…}` — Maestro's `\${USER || 'guest'}` default — would be typed literally.
      if (env[key].includes('${')) throw new Problem(`\${${key}} is "${env[key]}", which tapflow cannot evaluate — pass --env ${key}=… to set it`)
      return env[key]
    })
  }
  if (Array.isArray(value)) return value.map((v) => substitute(v, env))
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substitute(v, env)]))
  return value
}

function stringEnv(v: unknown): Record<string, string> {
  if (v === undefined || v === null) return {}
  if (!isRecord(v)) throw new Problem('"env" must be a mapping')
  return Object.fromEntries(Object.entries(v).map(([k, val]) => [k, val === null ? '' : String(val)]))
}

function requireString(v: unknown, what: string): string {
  if (typeof v !== 'string' || v.length === 0) throw new Problem(`"${what}" must be a non-empty string`)
  return v
}

function rejectKeys(rest: Record<string, unknown>, command: string): void {
  const keys = Object.keys(rest)
  if (keys.length > 0) throw new Problem(`"${command}" option "${keys[0]}" has no tapflow equivalent`)
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}
