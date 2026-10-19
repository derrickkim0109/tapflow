import { execSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'

export const DEFAULT_XCODE_APP = '/Applications/Xcode.app'

const SELECT_TIMEOUT_MS = 10_000

/**
 * What `xcode-select -p` prints, or null when it fails, which it does only when no developer
 * directory exists at all: it falls back to `/Applications/Xcode.app` and then to the Command Line
 * Tools on its own. With none, the `/usr/bin` shims (`xcrun`, `xcodebuild`) raise the Command Line
 * Tools install dialog, so a caller about to run one checks this first.
 *
 * `xcode-select` is a real binary, not one of those shims, so calling it raises no dialog. It also
 * honours `DEVELOPER_DIR`.
 */
export function activeDeveloperDir(): string | null {
  try {
    return String(execSync('xcode-select -p', { encoding: 'utf8', stdio: 'pipe', timeout: SELECT_TIMEOUT_MS }) ?? '').trim()
  } catch {
    return null
  }
}

/**
 * The Xcode bundle the active developer directory points into, or null when it points at the
 * Command Line Tools, at nothing, or at a bundle that is gone or has no `Contents/Developer`.
 */
export function selectedXcodeApp(): string | null {
  const app = /^(.+\.app)\/Contents\/Developer\/?$/.exec(activeDeveloperDir() ?? '')?.[1]
  return app && hasDeveloperDir(app) ? app : null
}

function hasDeveloperDir(app: string): boolean {
  return existsSync(`${app}/Contents/Developer`)
}

/**
 * The Xcode bundle to use: the selected one, then `/Applications/Xcode.app`, then the first
 * `Xcode*.app` in `/Applications` by name. Each must have a `Contents/Developer` — the `xcodes` GUI
 * is `Xcodes.app`, which matches the name and is not an Xcode.
 *
 * Not only `Xcode.app`, because installers that keep several versions side by side name the bundle
 * after its version (`xcodes` installs `Xcode-27.0.0.app`).
 *
 * **This is not the helpers' order.** `touch-helper` and `screencapture-helper` also start from the
 * selected Xcode, but then scan `/Applications` by name with no `Xcode.app` step, and `-` sorts
 * before `.`, so with the Command Line Tools selected they take `Xcode-beta.app` or
 * `Xcode-27.0.0.app` over `Xcode.app`. Preferring `Xcode.app` here is deliberate: `setup ios`
 * selects what this returns, and Apple's own beta is `Xcode-beta.app`, which the scan alone would
 * select over the release. Once `setup` has selected it, the helpers start from it too, so the two
 * disagree only on a Mac where nothing has selected an Xcode yet.
 */
export function findXcodeApp(): string | null {
  const selected = selectedXcodeApp()
  if (selected) return selected
  if (hasDeveloperDir(DEFAULT_XCODE_APP)) return DEFAULT_XCODE_APP
  try {
    const app = readdirSync('/Applications')
      .sort()
      .find((name) => /^Xcode.*\.app$/.test(name) && hasDeveloperDir(`/Applications/${name}`))
    return app ? `/Applications/${app}` : null
  } catch {
    return null
  }
}
