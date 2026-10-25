import type { RunResetItem, RunResetReport } from '@tapflowio/protocol'

/**
 * An app id an agent will pass to a device command. On Android that command is `adb shell`, which hands its argv to
 * the device's `sh` as one string, so an id from a flow file must not be able to carry shell syntax, nor start with
 * `-` and be read as an option by `pm` or `simctl`. Real package and bundle ids start with a letter or digit. One rule
 * for both platforms, so a flow does not reset on one and fail on the other.
 */
export const RESETTABLE_APP_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/**
 * How long a whole run reset may take, the wait for the device's services included. It runs before `device:ready`, so
 * it adds to the boot a client is waiting on: `scripts/__tests__/bootDeadlineOutlivesAgent.test.mjs` holds the client
 * that asks for it (flow-runner) to the slowest boot poll plus this plus two steps' own timeouts (the one in flight,
 * and Android's wait for a `pm clear` it timed out on). A step not started by
 * then is reported failed rather than run.
 */
export const RUN_RESET_BUDGET_MS = 60_000

/** One item of a run reset, as an agent carries it out. `run` throws when the item could not be reset. */
export interface RunResetStep {
  item: RunResetItem
  run: () => Promise<void>
}

/**
 * Run each step and report what was done. **Each step on its own:** one that fails is reported and the rest still
 * run, because a keychain that would not reset says nothing about the app data, and a boot is never failed for it —
 * the run reads the report and decides. `isStale` stops early when a newer boot or a shutdown took over the device;
 * what had not run by then is in neither list. Past `deadline`, what has not started is failed without running.
 */
export async function runResetSteps(
  steps: readonly RunResetStep[],
  isStale: () => boolean,
  onError?: (item: RunResetItem, e: unknown) => void,
  deadline = Date.now() + RUN_RESET_BUDGET_MS,
): Promise<RunResetReport> {
  const report: RunResetReport = { done: [], failed: [] }
  for (const step of steps) {
    if (isStale()) break
    if (Date.now() >= deadline) {
      report.failed.push(step.item)
      onError?.(step.item, new Error('the run reset ran out of time'))
      continue
    }
    try {
      await step.run()
      report.done.push(step.item)
    } catch (e) {
      report.failed.push(step.item)
      onError?.(step.item, e)
    }
  }
  return report
}

/**
 * The app half of a reset: each id checked against `RESETTABLE_APP_ID`, then `act` on each that passes. Every app is
 * attempted; one id that fails the check or the command fails the item, since the item claims all of them. Stops,
 * failing the item, once `isStale` says the boot was superseded.
 */
export async function resetApps(appIds: readonly string[], act: (appId: string) => Promise<void>, isStale: () => boolean = () => false): Promise<void> {
  const failures: string[] = []
  for (const id of appIds) {
    // A newer boot owns the device now: an uninstall landing after its ready would remove the app its run installs.
    if (isStale()) throw new Error('stopped: superseded, or out of time')
    if (!RESETTABLE_APP_ID.test(id)) { failures.push(`${JSON.stringify(id)}: not an app id`); continue }
    try { await act(id) } catch (e) { failures.push(`${id}: ${(e as Error).message}`) }
  }
  if (failures.length > 0) throw new Error(failures.join('; '))
}
