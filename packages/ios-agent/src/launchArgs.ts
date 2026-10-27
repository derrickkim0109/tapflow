import type { LaunchArgumentValue, LaunchOptions } from '@tapflowio/protocol'

// Every value goes out as an old-style plist string, because that is how the `UserDefaults` argument domain reads
// what follows a `-key`. Unquoted, a value starting with "-" is taken for the next key and one that is not valid plist
// text (a lone "(") is dropped: measured on iOS 26.5, `-offset -1` and `-paren (` both read back as nil, while
// `"-1"` and `"("` read back as the strings. Quoting also keeps "true" a string, which `bool(forKey:)` reads as true.
// A raw newline, tab, Korean or emoji inside the quotes reads back unchanged (measured the same way), so only the
// backslash and the quote are escaped.
function plistString(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

function plistValue(v: LaunchArgumentValue): string {
  return Array.isArray(v) ? `(${v.map(plistString).join(',')})` : plistString(String(v))
}

/** The arguments as they follow the bundle id on `simctl launch`: `-key value` pairs, passed as argv with no shell. */
export function iosLaunchArgv(args: LaunchOptions['arguments']): string[] {
  return Object.entries(args ?? {}).flatMap(([k, v]) => [`-${k}`, plistValue(v)])
}

/** The env as simctl takes it: each name prefixed with `SIMCTL_CHILD_`, which simctl strips before the app sees it. */
export function simctlChildEnv(env: LaunchOptions['env']): Record<string, string> {
  return Object.fromEntries(Object.entries(env ?? {}).map(([k, v]) => [`SIMCTL_CHILD_${k}`, v]))
}
