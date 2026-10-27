import type { LaunchArgumentValue, LaunchOptions } from '@tapflowio/protocol'

// `adb shell` joins its arguments with spaces and the device shell parses the line again, so every value is
// single-quoted for that shell: inside single quotes nothing is special, and a quote itself is closed, escaped and
// reopened. Measured on API 28 and 34: a value `a'b; echo PWNED $(id) \`id\`` arrived as one extra and ran nothing.
// Keys need no quoting — the shared check limits them to letters, digits, "_", "." and "-" — but get it anyway, so
// this function is safe on its own.
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

const INT32_MIN = -(2 ** 31)
const INT32_MAX = 2 ** 31 - 1

function extra(key: string, v: LaunchArgumentValue): string[] {
  const k = shellQuote(key)
  if (typeof v === 'boolean') return ['--ez', k, String(v)]
  // By value, as Maestro does: an int when it fits, a long when it does not. An app reading it as a string gets
  // null, which is why the docs say to quote a number meant as one.
  if (typeof v === 'number') return [v >= INT32_MIN && v <= INT32_MAX ? '--ei' : '--el', k, String(v)]
  // The string-array extra splits on commas; the shared check refuses an item holding one.
  if (Array.isArray(v)) return ['--esa', k, shellQuote(v.join(','))]
  return ['--es', k, shellQuote(v)]
}

/** The arguments as `am start` intent extras, typed by value and quoted for the device shell. */
export function androidLaunchExtras(args: LaunchOptions['arguments']): string[] {
  return Object.entries(args ?? {}).flatMap(([k, v]) => extra(k, v))
}
