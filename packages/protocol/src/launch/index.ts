// The one check every producer of launch options applies: flow-runner when it loads a flow, mcp-server on tool input,
// the relay before it forwards, and each agent before it renders a command. One function so that a value one door
// accepts is never refused by the next with a different message — or, worse, accepted by an agent that a stricter
// door would have stopped. A subpath rather than the main entry, which must stay free of runtime values (see AGENTS.md).

import type { LaunchApplied, LaunchArgumentValue, LaunchOptions } from '../index.js'

export type { LaunchApplied, LaunchArgumentValue, LaunchOptions }

export const MAX_LAUNCH_KEYS = 32
/**
 * Every key and value together, in UTF-16 code units. Android sends the whole launch as one `adb shell` line, which
 * adb caps near 64 KB, and single-quote escaping can grow a value up to four times (`'` → `'\''`). 8192 stays under
 * that with room for the command itself, and applies to iOS too so the same flow is accepted on both.
 */
export const MAX_LAUNCH_TOTAL = 8192

// Leading alphanumeric: iOS prefixes the key with `-` itself, and a key that already starts with one would read as a
// different name on Android, where nothing is prefixed. The rest are characters an `adb shell` line passes unquoted.
const ARGUMENT_KEY = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/

/**
 * Names the app's environment must keep. tapflow's network hook reads `SIMULATOR_UDID` and `TAPFLOW_TARGET_BUNDLE`
 * from the app's own environment, and a per-launch value takes precedence over the simulator-wide one it sets: an
 * override turns the hook off, or points it at another simulator's offline switch. `DYLD_*` would replace the hook
 * itself, `HOME`/`TMPDIR`/`CFFIXED_USER_HOME` move the app out of its container, and a nested `SIMCTL_CHILD_` is
 * simctl's own prefix.
 */
const RESERVED_ENV_PREFIXES = ['DYLD_', 'TAPFLOW_', 'SIMULATOR_', 'SIMCTL_CHILD_', '__XPC_']
const RESERVED_ENV_NAMES = new Set(['HOME', 'TMPDIR', 'CFFIXED_USER_HOME'])

// C0 controls other than tab and newline, and DEL. NUL cannot be passed as an argument at all (Node throws), and the
// rest have no legitimate use in a flag value.
const CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F]/

function checkString(v: string, at: string): string | null {
  return CONTROL.test(v) ? `${at}: control characters are not allowed` : null
}

function checkArgument(key: string, value: unknown): string | null {
  const at = `arguments.${key}`
  if (key.startsWith('-')) return `${at}: write the key without the leading "-" (${key.replace(/^-+/, '')}); tapflow adds it on iOS`
  if (!ARGUMENT_KEY.test(key)) return `${at}: a key starts with a letter or digit and holds only letters, digits, "_", "." and "-"`
  if (typeof value === 'string') return checkString(value, at)
  if (typeof value === 'boolean') return null
  if (typeof value === 'number') {
    if (Number.isSafeInteger(value)) return null
    return `${at}: only whole numbers are passed as numbers; quote ${String(value)} to pass it as a string`
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return `${at}: a list needs at least one item`
    for (const [i, item] of value.entries()) {
      if (typeof item !== 'string') return `${at}[${i}]: list items are strings`
      // Android's string-array extra splits on commas, so the app would read a different list. It does not split on a
      // comma after a backslash (`Intent.parseCommandArgs`, `(?<!\\),`), so an item ending in one would swallow the
      // next. Refused on every item rather than all but the last, to keep one rule.
      if (item.includes(',')) return `${at}[${i}]: list items cannot contain ","`
      if (item.endsWith('\\')) return `${at}[${i}]: list items cannot end with "\\"`
      const bad = checkString(item, `${at}[${i}]`)
      if (bad) return bad
    }
    return null
  }
  return `${at}: a value is a string, a whole number, true/false, or a list of strings`
}

function checkEnv(name: string, value: unknown): string | null {
  const at = `env.${name}`
  if (!ENV_NAME.test(name)) return `${at}: a name starts with a letter or "_" and holds only letters, digits and "_"`
  if (RESERVED_ENV_NAMES.has(name) || RESERVED_ENV_PREFIXES.some((p) => name.startsWith(p))) {
    return `${at}: reserved — tapflow or the simulator depends on it`
  }
  if (typeof value !== 'string') return `${at}: an environment value is a string`
  return checkString(value, at)
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * Why these options cannot be launched with, or null when they can. Takes `unknown` members because the producers
 * hold parsed YAML and tool input, not values a compiler has seen. Platform does not enter into it: Android refusing
 * `env` is the agent's answer, since only the agent knows what it is.
 */
export function launchOptionsProblem(opts: { arguments?: unknown; env?: unknown }): string | null {
  let keys = 0
  let total = 0
  const measure = (k: string, v: unknown) => {
    keys++
    total += k.length + (Array.isArray(v) ? v.reduce((n: number, s: unknown) => n + String(s).length + 1, 0) : String(v).length)
  }
  if (opts.arguments !== undefined) {
    if (!isPlainObject(opts.arguments)) return 'arguments: a map of key to value'
    for (const [k, v] of Object.entries(opts.arguments)) {
      const bad = checkArgument(k, v)
      if (bad) return bad
      measure(k, v)
    }
  }
  if (opts.env !== undefined) {
    if (!isPlainObject(opts.env)) return 'env: a map of name to string'
    for (const [k, v] of Object.entries(opts.env)) {
      const bad = checkEnv(k, v)
      if (bad) return bad
      measure(k, v)
    }
  }
  if (keys > MAX_LAUNCH_KEYS) return `at most ${MAX_LAUNCH_KEYS} arguments and environment variables together (got ${keys})`
  if (total > MAX_LAUNCH_TOTAL) return `arguments and environment variables add up to ${total} characters; at most ${MAX_LAUNCH_TOTAL}`
  return null
}

/** True when the options carry anything to apply. An empty map is the same as none. */
export function hasLaunchOptions(opts: LaunchOptions | undefined): boolean {
  return Object.keys(opts?.arguments ?? {}).length > 0 || Object.keys(opts?.env ?? {}).length > 0
}

/** The `applied` an agent reports for these options: the names, never the values. */
export function appliedKeys(opts: LaunchOptions): LaunchApplied {
  return { arguments: Object.keys(opts.arguments ?? {}), env: Object.keys(opts.env ?? {}) }
}

/** The options with empty maps dropped, or undefined when nothing is left — what goes on the wire. */
export function compactLaunchOptions(opts: LaunchOptions | undefined): LaunchOptions | undefined {
  if (!hasLaunchOptions(opts)) return undefined
  const out: LaunchOptions = {}
  if (Object.keys(opts?.arguments ?? {}).length > 0) out.arguments = opts!.arguments
  if (Object.keys(opts?.env ?? {}).length > 0) out.env = opts!.env
  return out
}
