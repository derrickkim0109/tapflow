import { createLogger } from '@tapflowio/agent-core'
import { StorageFullError } from './AdbWrapper.js'
import { LEAN_PACKAGES } from './LeanPackages.js'

const logger = createLogger('android-agent:storage')

/**
 * Waits before each retry once updates are rolled back. **The space does not come back at once:**
 * measured on API 35 (2026-10-02), rolling back YouTube freed 45 MB immediately and the other 113 MB
 * in one step about 5.5 s later — the package manager deletes the old code path on a delay. A failed
 * attempt is cheap: the size check refuses the install session before adb sends the APK.
 */
export const RETRY_DELAYS_MS: readonly number[] = [0, 3000, 6000]

/** Thrown by a `ReclaimDevice` whose boot was replaced mid-way: stop, rather than act on a device nobody is on. */
export class BootSupersededError extends Error {
  constructor() {
    super('the boot was superseded')
    this.name = 'BootSupersededError'
  }
}

/** What reclaiming needs from a booted emulator. `AndroidAgent` adapts `AdbWrapper` to it. */
export interface ReclaimDevice {
  installedPackages(): Promise<Set<string>>
  /** Whether the package's code lives under /data/app, i.e. an update over its /system version. */
  hasUpdates(pkg: string): Promise<boolean>
  uninstallUpdates(pkg: string): Promise<void>
}

/**
 * Install, and when the device is out of space, roll back the updates of the apps Lean mode already
 * judged unneeded for testing (`LEAN_PACKAGES`), then retry.
 *
 * **Why these apps and only these.** Play Store images fill /data on their own as Google apps
 * update in the background, and the partition cannot be grown without a wipe (#919). Rolling one of
 * these back frees its update — nearly 600 MB for the Google app alone — and resets its data, which
 * Lean mode already judged no test needs. This runs whether or not Lean mode is on: the list is the
 * judgement, not the setting. GMS, WebView and Play Store also carry large updates and are never touched: an app
 * under test signs in, renders and bills through them. A disabled package stays disabled, so Lean
 * mode's state is not disturbed.
 *
 * `owned` limits this to emulators tapflow launched; one a developer started is left as it is, and
 * they get the storage message instead. Returns the packages rolled back.
 */
export async function installReclaimingStorage(opts: {
  install: () => Promise<void>
  device: ReclaimDevice
  owned: boolean
  sleep?: (ms: number) => Promise<void>
}): Promise<string[]> {
  const { install, device, owned } = opts
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  try {
    await install()
    return []
  } catch (e) {
    if (!(e instanceof StorageFullError) || !owned) throw e
    let reclaimed: string[]
    try {
      reclaimed = await reclaim(device)
    } catch (reclaimError) {
      logger.warn('device storage is full and reclaiming it failed:', (reclaimError as Error).message)
      throw e
    }
    // Nothing left to roll back — retrying would only repeat the same failure. A second install racing
    // the first on the same device lands here too and gives up while the first one's space is still
    // arriving; harmless, and rare enough not to warrant a per-device lock.
    if (reclaimed.length === 0) throw e
    logger.info(`device storage was full: rolled back updates of ${reclaimed.join(', ')}; retrying the install`)
    let last: unknown = e
    for (const delay of RETRY_DELAYS_MS) {
      await sleep(delay)
      try {
        await install()
        return reclaimed
      } catch (retryError) {
        if (!(retryError instanceof StorageFullError)) throw retryError
        last = retryError
      }
    }
    throw last
  }
}

async function reclaim(device: ReclaimDevice): Promise<string[]> {
  const installed = await device.installedPackages()
  const rolledBack: string[] = []
  for (const pkg of LEAN_PACKAGES) {
    // `pm uninstall-system-updates` on a package the image lacks throws inside the package manager.
    // One package failing does not discard what the others freed — a rollback that already happened
    // has already reset that app's data, so the space it frees is used. A superseded boot stops it all.
    try {
      if (!installed.has(pkg) || !(await device.hasUpdates(pkg))) continue
      await device.uninstallUpdates(pkg)
      rolledBack.push(pkg)
    } catch (err) {
      if (err instanceof BootSupersededError) throw err
      logger.warn(`could not roll back ${pkg}:`, (err as Error).message)
    }
  }
  return rolledBack
}
