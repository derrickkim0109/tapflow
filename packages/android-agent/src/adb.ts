import { execFile, execFileSync } from 'child_process'
import { promisify } from 'util'
import { PlatformError, createLogger } from '@tapflowio/agent-core'
import { getAdbPath, getEmulatorPath } from './sdk.js'

const execFileAsync = promisify(execFile)
const logger = createLogger('android-agent:adb')

// `execFile` collects the child's stdout in memory and rejects with "stdout maxBuffer length exceeded"
// once it passes `maxBuffer`, which is 1 MiB unless set. `screencap -p` of a 1080×2424 screen with
// photos on it is larger than that, so every screenshot of such a screen failed inside the agent,
// while a flatter screen of the same size compressed under the limit and went through (#842). 64 MiB
// is what the iOS agent already gives `xcodebuild` in `XCUITreeReader`. `uiautomator dump` runs
// through `exec` and gets the same room: a large accessibility tree is the same failure one call over.
const ADB_MAXBUFFER = 64 * 1024 * 1024

/**
 * Where the scrcpy server is pushed on a device. tapflow's own name, not the scrcpy client's
 * (`/data/local/tmp/scrcpy-server.jar`): a developer mirroring the same phone with their own scrcpy would otherwise
 * have the jar under their server replaced by tapflow's version, and the other way round.
 */
export const SCRCPY_SERVER_DEVICE_PATH = '/data/local/tmp/tapflow-scrcpy-server.jar'

// An empty AVD list is otherwise indistinguishable from an SDK the agent cannot find (#903), so the
// failure is said once rather than on every device poll.
let warnedListAvds = false

/** An `adb` call that ran past its bound and was killed. */
export class AdbTimeoutError extends PlatformError {
  constructor(readonly timeoutMs: number, args: readonly string[]) {
    super(`adb ${args.join(' ')} did not answer within ${timeoutMs / 1000} s`)
  }
}

export interface AdbRunner {
  exec(...args: string[]): Promise<string>
  execBinary(...args: string[]): Promise<Buffer>
  listAvds(): Promise<string[]>
  /**
   * `exec`, killed after `timeoutMs` with an `AdbTimeoutError`. Only for calls a USB-connected device can hang — a
   * bad cable or a prompt on the phone — and that would hold something else up while it does. Optional so a test
   * runner need not have it; `AdbWrapper` then only stops waiting.
   */
  execWithin?(timeoutMs: number, ...args: string[]): Promise<string>
  /** The same, blocking: for the agent's exit, where nothing asynchronous runs before the process ends. */
  execSyncWithin?(timeoutMs: number, ...args: string[]): string
}

/** Whether `execFile` stopped the child for running past its `timeout`. */
function killedForTime(e: unknown): boolean {
  const err = e as { killed?: boolean; code?: string }
  return err.killed === true || err.code === 'ETIMEDOUT'
}

export const defaultRunner: AdbRunner = {
  async exec(...args: string[]): Promise<string> {
    const { stdout } = await execFileAsync(getAdbPath(), args, { maxBuffer: ADB_MAXBUFFER })
    return stdout
  },
  async execBinary(...args: string[]): Promise<Buffer> {
    const { stdout } = await execFileAsync(getAdbPath(), args, { encoding: 'buffer', maxBuffer: ADB_MAXBUFFER })
    return stdout
  },
  async execWithin(timeoutMs: number, ...args: string[]): Promise<string> {
    try {
      const { stdout } = await execFileAsync(getAdbPath(), args, { maxBuffer: ADB_MAXBUFFER, timeout: timeoutMs })
      return stdout
    } catch (e) {
      if (killedForTime(e)) throw new AdbTimeoutError(timeoutMs, args)
      throw e
    }
  },
  execSyncWithin(timeoutMs: number, ...args: string[]): string {
    try {
      return execFileSync(getAdbPath(), args, { encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (e) {
      if (killedForTime(e)) throw new AdbTimeoutError(timeoutMs, args)
      throw e
    }
  },
  async listAvds(): Promise<string[]> {
    try {
      const { stdout } = await execFileAsync(getEmulatorPath(), ['-list-avds'])
      warnedListAvds = false
      return stdout.split('\n').map((l) => l.trim()).filter(Boolean)
    } catch (err) {
      if (!warnedListAvds) {
        warnedListAvds = true
        logger.warn(`cannot list AVDs, so no Android devices will be reported: ${(err as Error).message}`)
      }
      return []
    }
  },
}
