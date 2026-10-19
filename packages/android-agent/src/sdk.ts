import { accessSync, constants, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { ValidationError } from '@tapflowio/agent-core'

// The agent used to read `ANDROID_HOME` and nothing else, while it registers itself on `which adb`
// and `tapflow doctor` falls back to the standard SDK locations. An SDK installed by Android Studio,
// with `platform-tools` on PATH and no `ANDROID_HOME`, therefore passed doctor, connected, and
// reported 0 devices: every lookup threw inside a `catch` that returned an empty list (#903). The SDK
// candidates are the ones doctor and the relay's `findAapt` use. The order is not quite doctor's: adb
// is looked for in the SDK before PATH, while doctor's `resolveAdb` asks PATH first, so a machine with
// two adbs can see doctor report one and the agent run the other.
export function androidSdkCandidates(): string[] {
  return [
    process.env['ANDROID_HOME'],
    process.env['ANDROID_SDK_ROOT'],
    join(homedir(), 'Library', 'Android', 'sdk'), // macOS
    join(homedir(), 'Android', 'Sdk'), // Linux
  ].filter((c): c is string => Boolean(c))
}

// `which` semantics: a directory or a non-executable file of the right name is passed over, so
// `$ANDROID_HOME` on PATH next to a half-installed `emulator/` folder does not resolve to the folder.
function isExecutableFile(candidate: string): boolean {
  try {
    if (!statSync(candidate).isFile()) return false
    accessSync(candidate, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** The first SDK candidate holding `<subdir>/<name>`, then `name` on PATH — the PATH step is what
 *  the agent's own `canRun` checks, so an agent that registered can also find the binary. */
function resolveSdkTool(subdir: string, name: string): string | null {
  for (const sdk of androidSdkCandidates()) {
    const candidate = join(sdk, subdir, name)
    if (isExecutableFile(candidate)) return candidate
  }
  for (const dir of (process.env['PATH'] ?? '').split(delimiter)) {
    if (!dir) continue
    const candidate = join(dir, name)
    if (isExecutableFile(candidate)) return candidate
  }
  return null
}

function notFound(what: string): ValidationError {
  return new ValidationError(
    `${what} not found in ${androidSdkCandidates().join(', ')} or on PATH.\n` +
    'Set ANDROID_HOME to your Android SDK. Example: export ANDROID_HOME=$HOME/Library/Android/sdk',
  )
}

export function getAdbPath(): string {
  if (process.env['ADB_PATH']) return process.env['ADB_PATH']
  const adb = resolveSdkTool('platform-tools', 'adb')
  if (!adb) throw notFound('adb')
  return adb
}

export function getEmulatorPath(): string {
  const emulator = resolveSdkTool('emulator', 'emulator')
  if (!emulator) throw notFound('Android emulator')
  return emulator
}
