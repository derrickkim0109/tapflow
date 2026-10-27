import { compactLaunchOptions, type LaunchOptions } from '@tapflowio/protocol/launch'

/** What a device can take of the relay's launch defaults, read from its agent's capabilities. */
export interface LaunchTarget {
  options: boolean
  env: boolean
}

export interface MergedLaunch {
  options?: LaunchOptions
  /** Every option came from the defaults: the agent may launch without what it cannot deliver. */
  defaultsOnly: boolean
  /** Defaults left out for this target, for a warning. Never a caller's value — those are refused. */
  dropped?: 'all' | 'env'
}

/**
 * The relay's defaults for an app under the caller's options, per key, the caller winning. Defaults the target cannot
 * take are left out rather than refused: they were written once for every device the app runs on, while a caller's
 * options were asked for on this one.
 */
export function mergeLaunch(defaults: LaunchOptions | undefined, caller: LaunchOptions | undefined, target: LaunchTarget): MergedLaunch {
  let usable = defaults
  let dropped: MergedLaunch['dropped']
  if (usable && !target.options) {
    usable = undefined
    dropped = 'all'
  } else if (usable?.env && !target.env) {
    usable = { arguments: usable.arguments }
    dropped = 'env'
  }
  const options = compactLaunchOptions({
    arguments: { ...usable?.arguments, ...caller?.arguments },
    env: { ...usable?.env, ...caller?.env },
  })
  return { options, defaultsOnly: options !== undefined && caller === undefined, ...(dropped ? { dropped } : {}) }
}

/**
 * Warnings for configured bundle ids no build was uploaded with. A typo there is a default that never applies, with
 * nothing else to say so. A key that differs only in case is named, because bundle ids are compared exactly.
 */
export function unmatchedLaunchKeys(keys: Iterable<string>, uploaded: readonly string[]): string[] {
  const known = new Set(uploaded)
  const out: string[] = []
  for (const key of keys) {
    if (known.has(key)) continue
    const near = uploaded.find((b) => b.toLowerCase() === key.toLowerCase())
    out.push(near
      ? `launch.${key} in tapflow.config.json matches no build; did you mean ${near}? Bundle ids are compared exactly`
      : `launch.${key} in tapflow.config.json matches no uploaded build yet`)
  }
  return out
}
