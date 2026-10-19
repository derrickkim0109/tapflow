import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

/**
 * The iOS network filter — the one layer of the offline toggle that lives on the Mac rather than in
 * the simulator, and the only one a user has to install.
 *
 * **Three versions, not two, and the third is the one that matters.** The app the package ships, the
 * app in `/Applications`, and the extension macOS has *activated*. A design review found this the
 * hard way: on the ordinary upgrade path `--install` answers exit 5 (needs a reboot), which leaves
 * the first two matching while the kernel goes on running the old provider — so a check that compares
 * the files reports everything healthy while the dashboard says the Mac is not set up. The agent
 * confirms enforcement over XPC, and an older extension has no listener to answer it.
 *
 * So this module reads the activated version, and everything that installs goes through one routine
 * (`installNetFilter`) rather than being written twice.
 */

/** Where macOS expects the container app. Anywhere else and activation answers `code=3`. */
export const NET_FILTER_APP = '/Applications/TapflowNetFilter.app'
const EXT_BUNDLE_ID = 'dev.tapflow.netfilter.ext'

/** How long a read-only probe of this Mac may take before it is treated as unanswerable. Generous
 *  against a loaded machine, short against `doctor`'s promise to answer. */
const PROBE_TIMEOUT_MS = 10_000

/**
 * **Two versions, not one, and the names say which is which** (#724).
 *
 * `build.sh` used to stamp one number into the host app and the system extension alike, so a rebuild
 * that changed nothing but the host still bumped the extension and macOS replaced a provider for no
 * reason — three of the six filter rebuilds so far. They are now allowed to differ, and the moment
 * they do, comparing one against the other stops being harmless.
 *
 * It was not harmless before either, only invisible: `isNetFilterCurrent` compared the *host* app's
 * version against the *extension* macOS is running, and they only ever agreed because one number was
 * written into both. Fields called `shipped` and `installed` gave nothing away about which kind of
 * version they held, which is why the names carry it now.
 */
export interface NetFilterState {
  /** Host app version this CLI's `@tapflowio/ios-agent` carries, or null when the package has no app. */
  shippedHost: string | null
  /** Host app version in `/Applications`, or null when nothing is installed there. */
  installedHost: string | null
  /** System extension version the package carries. */
  shippedExt: string | null
  /** System extension version macOS reports as `[activated enabled]`, or null when none is. */
  activatedExt: string | null
}

/** Read `CFBundleVersion` from an app bundle. `null` for absent or unreadable — a bundle that cannot
 *  be read is not a version, and guessing one here would be the claim this whole feature avoids. */
export function bundleVersion(appPath: string): string | null {
  // `appPath` is a bundle root — the app, or the system extension nested inside it. Both keep their
  // plist at `Contents/Info.plist`, which is what lets one reader serve the two versions this module
  // now has to tell apart.
  const plist = join(appPath, 'Contents', 'Info.plist')
  if (!existsSync(plist)) return null
  try {
    const out = execFileSync('/usr/bin/defaults', ['read', plist, 'CFBundleVersion'], {
      // A read that hangs hangs `tapflow doctor ios` with it, and the command's whole job is to answer
      // quickly about a machine that may be in a bad state. The throw lands in the `catch` below, so a
      // hang reports the same "cannot tell" as a failure — which is what it is.
      timeout: PROBE_TIMEOUT_MS,
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    })
    return out.trim() || null
  } catch {
    return null
  }
}

/**
 * The app this CLI would install, found through the agent package rather than a relative path.
 *
 * `createRequire` resolution rather than `join(import.meta.dirname, '../..')`: the CLI is installed
 * as a dependency, run from a pnpm store with its own layout, and executed from a bin shim — the only
 * thing that holds across those is asking node where the package is.
 *
 * It resolves the **manifest**, which is why `@tapflowio/ios-agent` exports `./package.json`. Without
 * that entry the map's `.` is the only path out of the package and node answers
 * `ERR_PACKAGE_PATH_NOT_EXPORTED`; resolving the main entry and walking up a directory would work
 * today and encode where the entry happens to sit.
 */
export function shippedAppPath(): string | null {
  return shippedArtifact('TapflowNetFilter.app')
}

/**
 * The injected library — the offline toggle's **second** layer, and the one nothing reported on.
 *
 * It is not a second copy of the filter's problem. The filter is installed onto the Mac and can be
 * absent, stale or unapproved; this one only ever lives inside the package, so it is either there or
 * the install is damaged. What made it worth a check is the failure it produces when it is not:
 * `DYLD_INSERT_LIBRARIES` naming a path that does not exist is **ignored silently** by dyld, the app
 * launches with no hooks, and no verdict is ever written — so the control asks the tester to launch
 * an app through tapflow, forever, while the app they launched is running in front of them.
 */
export function shippedHookPath(): string | null {
  return shippedArtifact('libtapflow-nethook.dylib')
}

function shippedArtifact(name: string): string | null {
  try {
    const require = createRequire(import.meta.url)
    const pkg = require.resolve('@tapflowio/ios-agent/package.json')
    const p = join(dirname(pkg), 'bin', name)
    return existsSync(p) ? p : null
  } catch {
    return null
  }
}

/**
 * What macOS has *activated*, from `systemextensionsctl list`.
 *
 * The line looks like `*   *   TEAMID   dev.tapflow.netfilter.ext (1.0/1787585990)   name  [activated enabled]`.
 * Only a line that is both activated **and** enabled counts; a replaced extension sits in that list
 * as `terminated waiting to uninstall on reboot` and is exactly the state this exists to catch.
 */
export function activatedVersion(): string | null {
  // `execFileSync`, not `spawnSync`, and the distinction is this codebase's: reads go through the exec
  // family and `spawnSync` is what changes the machine. A setup run on a fully configured Mac asserts
  // that nothing was spawned, and asking macOS what it has activated must not break that.
  let out: string
  try {
    out = execFileSync('/usr/bin/systemextensionsctl', ['list'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: PROBE_TIMEOUT_MS,
    })
  } catch {
    return null
  }
  // Absent output is "cannot tell", which is what `null` means here — inventing a version would be
  // the claim this whole module exists to avoid.
  if (!out) return null
  for (const line of out.split('\n')) {
    if (!line.includes(EXT_BUNDLE_ID)) continue
    if (!line.includes('[activated enabled]')) continue
    const m = line.match(/\(([^)]*)\)/)
    if (!m) continue
    // `1.0/1787585990` — short version before the slash, build version after. The build version is
    // what `build.sh` makes unique per build, so it is the one that identifies a binary.
    //
    // **No slash means we cannot tell which half we are looking at**, and answering with the short
    // version puts an uncomparable `1.0` into a comparison against an epoch. That produced advice with
    // no exit: doctor says the versions differ, migrate installs, macOS skips the replace because the
    // bundle version did not change, and doctor says the same thing again.
    const parts = m[1].split('/')
    if (parts.length < 2) return null
    return parts[1].trim() || null
  }
  return null
}

/**
 * Is `candidate` a later build than `than`?
 *
 * **Anything that does not parse answers yes**, so an unreadable version refuses the install rather
 * than performing it. `Number('a') > Number('b')` is a NaN comparison and therefore `false`, which
 * would have made the downgrade guard fail *open* the day these stop being epoch seconds — the one
 * direction a guard must never fail in.
 */
export function isNewer(candidate: string, than: string): boolean {
  const a = Number(candidate)
  const b = Number(than)
  if (!Number.isFinite(a) || !Number.isFinite(b)) return true
  return a > b
}

/**
 * Nothing to install: the app on disk and the extension macOS is running are both this build.
 *
 * Exported because `setup ios` asks before each install and must not ask about one that would do
 * nothing — and a second copy of this comparison in the caller is how the prompt and the installer
 * would come to disagree about whether there was anything to consent to.
 */
export function isNetFilterCurrent(s: NetFilterState): boolean {
  return s.shippedHost !== null && s.installedHost === s.shippedHost
    && s.shippedExt !== null && s.activatedExt === s.shippedExt
}

/**
 * Where the extension's own plist sits inside the app bundle.
 *
 * **`installedExt` is deliberately not read**, and that is a decision rather than an omission: the
 * two plists come out of one build and the host version is unique per build, so `installedHost`
 * matching already says the bundle is this build's — extension included. Reading a third plist would
 * buy a derivable value at the price of another 10-second probe and another way to answer `null`,
 * where "could not read it" and "it is not there" are the same answer.
 */
/**
 * The system extension's own bundle, nested inside an app bundle.
 *
 * **A bundle root, not a plist path** — `bundleVersion` appends `Contents/Info.plist` itself, and
 * handing it a path that already ends in `Contents` produced `Contents/Contents/Info.plist`, an
 * unreadable path that answered `null` for every install. Null there means "this package carries no
 * filter", so `setup ios` and `migrate net-filter` both refused with *reinstall tapflow*, which
 * cannot fix it. The mistake survived a full green suite because the fixtures matched paths by
 * substring and said yes to both.
 */
export function extensionBundle(appPath: string): string {
  return join(appPath, 'Contents', 'Library', 'SystemExtensions', 'dev.tapflow.netfilter.ext.systemextension')
}

export function readNetFilterState(): NetFilterState {
  const shipped = shippedAppPath()
  return {
    shippedHost: shipped ? bundleVersion(shipped) : null,
    installedHost: bundleVersion(NET_FILTER_APP),
    shippedExt: shipped ? bundleVersion(extensionBundle(shipped)) : null,
    activatedExt: activatedVersion(),
  }
}

/**
 * Where the provider publishes what it is enforcing, most likely first.
 *
 * Read rather than asked. Asking means running the host binary, and a stale one turns a flag it does
 * not know into a rule write — measured on 2026-09-02, `--confirm` against an older build erased the
 * rule and answered 0. A file read cannot change the Mac.
 */
const FILTER_STATE_FILES = [
  '/Library/Application Support/tapflow/tapflow-netfilter-state.json',
  '/tmp/tapflow-netfilter-state.json',
]

/**
 * Is a provider actually enforcing right now?
 *
 * **Not the question `activatedVersion()` answers, and conflating them is what this exists to stop.**
 * `systemextensionsctl` reports the *system extension*; `NEFilterManager.isEnabled` is a separate
 * preference, and a filter switched off leaves the extension listed `[activated enabled]` exactly as
 * before. So a Mac whose filter was disabled and never turned back on reads as fully current, and
 * `installNetFilter` returned `already-current` without running the step that would restore it —
 * network control dead, `doctor ios` all green, and nothing anywhere saying why.
 *
 * That state is not hypothetical: the disable-before-replace sequence below creates it whenever it is
 * interrupted after `--off` and before `--install`.
 *
 * Stale counts as stopped, on the agent's own rule — three missed pulses, with `pulseSeconds` taken
 * from the file rather than assumed, because the provider slows its pulse while nothing is offline.
 */
export function isFilterEnforcing(now = Date.now(), since = 0): boolean {
  for (const path of FILTER_STATE_FILES) {
    if (!existsSync(path)) continue
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8')) as { at?: unknown; pulseSeconds?: unknown }
      if (typeof raw.at !== 'number') continue
      const pulse = typeof raw.pulseSeconds === 'number' ? raw.pulseSeconds : 5
      // **A stale file is a reason to keep looking, not an answer.** The second path is where the
      // provider writes when it cannot write the first, so a Mac that failed over leaves an old file
      // at the first one and a live heartbeat at the second. Returning here read that Mac as stopped
      // and made every run pay the disable/enable cycle this module exists to make rare.
      // **`since` is how a caller asks "did somebody start *after* this moment".** Freshness alone
      // cannot tell a live provider from one that died inside the window — the file is written every
      // pulse and removed asynchronously two hops after `--off` returns, so a provider killed by an
      // activation leaves a file that is up to fifteen seconds young. A caller waiting for a filter to
      // come *back* would read that as success on its first look, which is the false report the wait
      // exists to prevent. `doctor` passes nothing, because it only asks whether anything is running
      // now.
      if (raw.at <= since) continue
      if (Math.floor(now / 1000) - raw.at <= 3 * Math.max(pulse, 1)) return true
      continue
    } catch {
      // Unreadable is not "enforcing". Keep looking; the second path is the fallback the provider
      // uses when it cannot write the first.
      continue
    }
  }
  return false
}

/**
 * What would be interrupted by a replace, in words a person can act on. Empty means nothing would.
 *
 * **All three, because the filter is host-wide.** It is `filterSockets`, so every new flow on the Mac
 * goes through the provider — an Android emulator's traffic included, even though nothing here can
 * take one offline. And a relay serving on :4000 means somebody may be testing through a browser from
 * another machine, which no device list can show.
 *
 * Best-effort by construction: a probe that cannot run reports nothing rather than blocking the
 * install. A missed device costs the interruption this refusal exists to avoid; a probe that throws
 * and stops the upgrade costs an upgrade nobody can perform.
 */
export function busyDevices(): string[] {
  const busy: string[] = []
  for (const name of bootedSimulators()) busy.push(`simulator ${name}`)
  for (const serial of attachedEmulators()) busy.push(`emulator ${serial}`)
  if (relayIsServing()) busy.push('a relay serving on :4000')
  return busy
}

function bootedSimulators(): string[] {
  try {
    const raw = execFileSync('/usr/bin/xcrun', ['simctl', 'list', 'devices', '--json'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: PROBE_TIMEOUT_MS,
    })
    const data = JSON.parse(raw) as { devices: Record<string, Array<{ name: string; state: string }>> }
    return Object.values(data.devices).flat().filter((d) => d.state === 'Booted').map((d) => d.name)
  } catch {
    return []
  }
}

function attachedEmulators(): string[] {
  try {
    // From `PATH`, unlike the absolute paths above: `adb` ships with the Android SDK and has no fixed
    // location. Absent is the common case on an iOS-only Mac and lands in the `catch`.
    const raw = execFileSync('adb', ['devices'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: PROBE_TIMEOUT_MS,
    })
    return raw.split('\n').slice(1)
      .map((l) => l.trim()).filter((l) => l.endsWith('device'))
      .map((l) => l.split(/\s+/)[0]).filter(Boolean)
  } catch {
    return []
  }
}

function relayIsServing(): boolean {
  try {
    const out = execFileSync('/usr/sbin/lsof', ['-nP', '-iTCP:4000', '-sTCP:LISTEN', '-t'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: PROBE_TIMEOUT_MS,
    })
    return out.trim().length > 0
  } catch {
    // `lsof` exits non-zero when nothing holds the port, which is the common case and not an error.
    return false
  }
}

/**
 * What the install is about to wait on. Reported **before** the call that waits, never after it.
 *
 * **Before, because this module is synchronous the whole way down** — `spawnSync` and
 * `Atomics.wait`. Nothing on the event loop runs between these steps, so a spinner cannot animate
 * (every `createSpinner` in this CLI wraps an `await`), and a report made *after* a step names a
 * wait the person has already sat through. That silence is the defect: `migrate net-filter` printed
 * nothing for up to three minutes and read as an error (#799).
 *
 * **There is no `awaiting-approval` stage, and that is a limit rather than an omission.** The host
 * logs `needs user approval` to its own file and then exits 4 — but only once its 120-second
 * approval deadline has passed. A blocking `spawnSync` cannot read that log in between, so the
 * approval warning is front-loaded into `activating` instead. Announcing it on the way out would
 * describe a wait that is already over.
 *
 * `activating-with-sheet` is the same step when the person has already accepted the approval screen
 * up front (`offerApprovalUpFront`), so the line says the screen is coming rather than where to go.
 *
 * `checking` covers `readNetFilterState`, which is not free: `systemextensionsctl list` plus three
 * `defaults read`, each bounded at `PROBE_TIMEOUT_MS`. On a wedged Mac that is 40 seconds before
 * anything else here has run.
 */
export type InstallStage =
  'checking' | 'disabling' | 'copying' | 'activating' | 'activating-with-sheet' | 'confirming'

/**
 * Where the approval lives, in words.
 *
 * Kept as one string because it is the fallback for `APPROVAL_SHEET_URL`: `open` answers 0 whether or
 * not the sheet appeared, so every message that offers the sheet also has to say where it is.
 */
export const APPROVAL_PATH = 'System Settings → General → Login Items & Extensions → Network Extensions'

/**
 * How to take the extension off this Mac, as the steps a person runs.
 *
 * **Not `systemextensionsctl uninstall`, which is what this used to say.** It refuses on any Mac with
 * System Integrity Protection on — measured on macOS 27, 2026-09-17 — so the advice worked only on a
 * Mac nobody runs this on. System Settings removes it instead (the ⋯ menu's item reads "확장 프로그램
 * 삭제" on a Korean Mac, measured; "Delete Extension" is the English label as published), including when the app is already gone
 * from `/Applications` (same measurement), and the removal finishes at the next restart: the list
 * reads `terminated waiting to uninstall on reboot` until then.
 *
 * **Off first.** Removing an extension whose filter is on stops the provider with nothing to restart
 * it, and that is the shape that left a Mac with no network until a restart during a replace (see
 * `installNetFilter`). Not measured for a removal. The measured removal ran after `--off`, and the
 * order costs one command.
 *
 * **With the binary this package carries**, because every caller is the state where `/Applications`
 * has none. `--off` run from the package reaches the existing configuration (the first disable in
 * `installNetFilter` records that measurement, taken with an app still in `/Applications`; from the
 * package with none there is the same bundle identifier and has not been measured as a pair).
 *
 * **`chmod +x` first**, because a registry install delivers that binary at `rw-r--r--` (see
 * `restoreExecutableBits`) and none of the callers get as far as restoring it — `refused-host-unknown`
 * returns before the install does. Printed rather than performed so `doctor` stays read-only.
 *
 * **Stopping tapflow is not a step here, and the guide's version has it.** A running iOS agent does
 * switch the filter back on — every rule write is `.configure` — but it only ever runs
 * `/Applications`' binary (`SimulatorNetwork`'s `DEFAULT_HOST_BINARY`, no override in production) and
 * returns without running anything when that file is missing. Every caller of this is that state. The
 * network control guide removes an extension whose app is still there, so it does say to stop tapflow.
 *
 * **Nothing here can say whether step 1 worked.** `--off` prints nothing and exits 0 for "nothing to
 * disable" as well; what it did is the last line of `/tmp/tapflow-netfilter-host.log`. No sequence is
 * known where it exits 0 over an enabled configuration, so the steps do not ask anyone to check.
 */
export function removalSteps(): string[] {
  const shipped = shippedAppPath()
  // The fallback is unreachable from today's callers — `doctor` and `installNetFilter` both answer an
  // absent artifact before reaching here — and kept so the function never prints a hollow step.
  const bin = shipped ? shellQuote(join(shipped, 'Contents', 'MacOS', 'TapflowNetFilter')) : null
  const off = bin
    ? `chmod +x ${bin} && ${bin} --off`
    : 'TapflowNetFilter --off, using the copy inside @tapflowio/ios-agent (bin/TapflowNetFilter.app/Contents/MacOS)'
  return [
    `1. Switch the filter off: ${off}`,
    `2. In ${APPROVAL_PATH}, click ⋯ beside TapflowNetFilter and choose Delete Extension`,
    '3. Restart the Mac. The removal finishes then',
  ]
}

/** Quoted only when it has to be, so the common path still reads as a path. Exported for its test. */
export function shellQuote(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`
}

/**
 * What each stage says.
 *
 * **One map rather than a sentence in each command**, for the reason `isNetFilterCurrent` is
 * exported: `setup ios` and `migrate net-filter` run the identical routine, and two callers wording
 * the same step differently is how they come to describe different installs.
 *
 * `activating` carries the approval warning because nothing later can — see `InstallStage`.
 */
export const INSTALL_STAGE_MESSAGE: Record<InstallStage, string> = {
  checking: 'Checking what this Mac already has…',
  disabling: 'Taking the current filter out of the path…',
  copying: `Copying the filter to ${NET_FILTER_APP}…`,
  // **Names the button, because the dialog's default is the wrong one.** macOS 27 asks with OK
  // highlighted and Open System Settings beside it, and OK only dismisses the dialog: the extension
  // stays unapproved and nothing on screen says so (measured 2026-09-17).
  activating:
    'Activating the system extension. If macOS asks, choose Open System Settings (not OK) and switch'
    + ` TapflowNetFilter on in ${APPROVAL_PATH}. Waiting up to two minutes.`,
  'activating-with-sheet':
    'Activating the system extension. The approval screen opens once macOS asks: switch TapflowNetFilter'
    + ` on there, or go to ${APPROVAL_PATH} if it does not appear. Waiting up to two minutes.`,
  confirming: 'Waiting for the filter to report itself running…',
}

export interface InstallOptions {
  /** Replace even though devices are in use. The refusal exists because a replace interrupts every
   *  new connection on the Mac; this is the caller saying they know and want it anyway. */
  ignoreRunningDevices?: boolean
  /**
   * Called before each step that blocks, naming what it is waiting on.
   *
   * **Optional because every caller predates it** — two commands and this package's tests. An absent
   * callback leaves the install exactly as silent as it was, which is the old behaviour rather than
   * a broken one.
   *
   * **Wrapped so it cannot abort the install — and the reason is the cost, not the likelihood.**
   * Two independent reviews raised this and neither found a reaching path: both callers pass `step`,
   * which is a `console.log`, and node's console swallows write errors rather than raising them. It
   * is guarded anyway, through `reportProgress`, because a callback that threw after `disabling`
   * would leave the Mac with its filter switched off, no outcome, and no banner saying why. Four
   * lines against that is not a trade worth thinking about twice.
   */
  onProgress?: (stage: InstallStage) => void
  /**
   * How long to wait for a filter to report itself running, in milliseconds.
   *
   * A parameter rather than a constant because a test that means "it never came back" would otherwise
   * spend the real deadline proving it — 60 seconds across two cases, measured. Passing `0` asks once
   * and answers, which is the same code path a slow provider takes on its last poll.
   */
  confirmDeadlineMs?: number
  /**
   * Open the approval sheet as soon as macOS starts waiting for it, while the host waits.
   *
   * Only for someone who said yes to `offerApprovalUpFront`: it puts a window on the Mac's screen, and
   * the switch it leads to drops connections.
   */
  openApprovalSheet?: boolean
}

export type InstallOutcome =
  | { status: 'installed' }
  | { status: 'installed-unconfirmed' }
  | { status: 'already-current' }
  | { status: 'needs-approval'; filterLeftDisabled: boolean }
  | { status: 'needs-reboot' }
  | { status: 'not-macos' }
  | { status: 'no-artifact' }
  | { status: 'refused-downgrade'; installed: string; shipped: string }
  | { status: 'refused-host-unknown'; activated: string }
  // `filterLeftDisabled` is present only when the refusal came after an approval — the install had run
  // and the filter was waiting to be switched on — which is how the two commands tell it apart from a
  // refusal before anything happened.
  | { status: 'refused-devices-busy'; busy: string[]; filterLeftDisabled?: boolean }
  | { status: 'failed'; code: number; detail: string; filterLeftDisabled: boolean }

/** What the host binary's exit codes mean. The table lives in `ios-netfilter/README.md`; these are the
 *  three that are not failures. */
const EXIT_APPROVAL_TIMEOUT = 4
const EXIT_NEEDS_REBOOT = 5

/** How long `--off` gets. It is one `NEFilterManager` save and was measured at 31ms; this is a bound
 *  on a wedged run, not a budget. */
const OFF_TIMEOUT_MS = 15_000

/** How long the copy gets. `ditto` moves a few megabytes off local disk, so this bounds a wedged run
 *  rather than a slow one — and after the disable above, a copy that never returns is what leaves the
 *  filter off with nothing said. */
const COPY_TIMEOUT_MS = 60_000

/**
 * How long the filter gets to come back up before the run says it could not tell.
 *
 * The provider writes its state file once from `startFilter`, so this is the time between the
 * preference save being accepted and settings actually being applied. Measured on this Mac: about
 * four seconds for a provider that was already resident, and `SimulatorNetwork.ts` records 5.8s for
 * one launched fresh, with one run in five taking 21.3. Thirty is that worst case with room.
 *
 * **The successful path does not wait**, so this is only ever spent on a run that has something to
 * report. Waiting is what makes the report possible.
 */
export const CONFIRM_DEADLINE_MS = 30_000

/** How often to look. The file is written once and then pulsed, so this only decides how quickly a
 *  success is noticed. */
const CONFIRM_POLL_MS = 500

/** How long `--install` gets. Generous because it can be waiting on a macOS approval dialog — the
 *  host has its own approval and stall deadlines (exit 4 and 6) and this is only the backstop for a
 *  run that reaches neither. Without it the CLI waits forever on a completion handler that never
 *  fires, which is how an interrupted sequence leaves the filter off. */
const INSTALL_TIMEOUT_MS = 180_000

/**
 * Put the shipped app in `/Applications` and activate it. **The one routine both `setup ios` and
 * `migrate net-filter` call** — they exist for different people (first run vs an upgrade that
 * introduced the feature) and must not drift into two answers for one question.
 *
 * No `sudo`: `/Applications` is writable by an admin user, and `ditto` preserves the signature, which
 * a plain copy does not. Measured.
 */
/**
 * Report a stage, and never let that reporting change the install.
 *
 * **The whole point is the `catch`.** Every call below sits between steps that leave the Mac in an
 * intermediate state — the filter is switched off before the copy and stays off until `--install`
 * turns it back on — so an exception escaping here would abandon the run at exactly the moment it
 * has something to clean up, with no `InstallOutcome` for either command to render a banner from.
 * The reasoning about whether a caller can actually throw is on `InstallOptions.onProgress`.
 */
function reportProgress(opts: InstallOptions, stage: InstallStage): void {
  try {
    opts.onProgress?.(stage)
  } catch {
    // Reporting is not the job. A reporter that cannot report is not a reason to stop installing.
  }
}

export function installNetFilter(opts: InstallOptions = {}): InstallOutcome {
  if (process.platform !== 'darwin') return { status: 'not-macos' }
  const shipped = shippedAppPath()
  if (!shipped) return { status: 'no-artifact' }

  // Ahead of the probes rather than after them: this is the first thing that can take time, and the
  // refusals below all return without ever reaching a report.
  reportProgress(opts, 'checking')
  const state = readNetFilterState()
  const { shippedHost, installedHost, shippedExt, activatedExt } = state
  // **An unreadable version refuses too.** Under `if (shippedVersion)` the whole guard below was
  // skipped whenever the shipped app would not say what it was, so the one artifact no comparison can
  // judge was the one that installed unconditionally — over a newer filter that was working.
  if (!shippedHost || !shippedExt) return { status: 'no-artifact' }
  // **Current *and* running.** The version check alone answers a different question than the one the
  // caller is asking, and the gap between them is a state this function creates: interrupt the
  // sequence below between `--off` and `--install` and the Mac has the right app, the right activated
  // extension, and no filter. Returning `already-current` there makes the condition permanent, because
  // the only thing that would turn it back on is the run that just declined to do anything.
  if (isNetFilterCurrent(state) && isFilterEnforcing()) {
    return { status: 'already-current' }
  }
  // **A downgrade is refused rather than performed.** `/Applications` holds one copy for the whole
  // Mac while the version each checkout judges it by comes from its own `node_modules`, so an older
  // checkout running this would replace the app a newer agent depends on and break it.
  //
  // **Each kind against its own kind.** This used to fall back to the activated *extension* version
  // when the app was gone, which worked only because one number was written into both. Once they are
  // allowed to differ, that comparison is between two things that were never the same measurement.
  if (installedHost && isNewer(installedHost, shippedHost)) {
    return { status: 'refused-downgrade', installed: installedHost, shipped: shippedHost }
  }
  if (activatedExt && isNewer(activatedExt, shippedExt)) {
    return { status: 'refused-downgrade', installed: activatedExt, shipped: shippedExt }
  }

  // **What is protected is what the Mac is running, not the file on disk**, and with the app gone
  // there is no longer anything that says what that is.
  //
  // macOS keeps an extension activated and enforcing when its container app is deleted, and the
  // agent's whole layer-1 path is the binary in `/Applications`. The extension's version used to
  // stand in for the host's; now it only gives a lower bound, because a host-only build moves one and
  // not the other. So this Mac may be running a *newer* host than this checkout carries and nothing
  // here can tell.
  //
  // Refusing costs a repair that would usually have been fine. Guessing costs a working install,
  // silently, for whoever set it up — and `doctor` already answers this state with the same two
  // remedies rather than offering to reinstall.
  if (installedHost === null && activatedExt !== null) {
    return { status: 'refused-host-unknown', activated: activatedExt }
  }

  // **Refused rather than forced, and it belongs here rather than in either command.** Both `setup
  // ios` and `migrate net-filter` reach this function, so a gate on one of them protects half the
  // callers — and the destructive part is here, not there.
  //
  // Refusing rather than shutting the devices down is the other half of the decision. `/Applications`
  // holds one filter for the whole Mac, which is already this module's reason for the downgrade
  // guard: the people affected by a replace are not necessarily the person running the command.
  const busy = opts.ignoreRunningDevices ? [] : busyDevices()
  if (busy.length > 0) return { status: 'refused-devices-busy', busy }

  // **Switch the filter off before the copy as well, and do it with the binary this package carries.**
  //
  // `ditto` into `/Applications` makes macOS post an installed-apps change, and `nesessionmanager`
  // restarts every filter session on it. That restart is not free: a `filterSockets` session going
  // down arms a kernel-wide `applyIPDefaultDrop: IP Drop-All`, which is why the failure looks like an
  // instant `No route to host` rather than a hang.
  //
  // Measured 2026-09-03, with the disable happening after the copy: `configuration is now disabled` at
  // 00:23:01.965 and `Handling installed apps change` at 00:23:02.034. **69 milliseconds.** The
  // restart landed on a session that was already disabled and cost two probes out of 468. On
  // 2026-09-02, with no disable anywhere in this path, the same notification landed on an *enabled*
  // session, armed Drop-All twice, and the plugin was disposed with nothing restarting it: 2m34s with
  // no network on the Mac, ended by a reboot.
  //
  // 69ms is a race won, not a margin. The notification trails the copy by about 130ms and the copy is
  // the slow part, so a slower disk or a larger bundle reorders them and the 2026-09-02 shape is back.
  // Disabling first removes the race rather than winning it.
  //
  // **From `shipped`, and that is the whole reason this is safe now when it was not before.** The
  // recorded objection to disabling first was that it meant asking whatever binary happened to be
  // installed, and a build older than the flag does not refuse it — every unrecognised argument fell
  // through to `.configure`, which writes `isEnabled = true`, so "switch off" switched it on and
  // answered 0. The binary here is the one this package ships and always understands the flag.
  // Measured 2026-09-03: run from the package directory it disabled the **existing** configuration
  // (same `NEFilterManager` UUID, session `disconnected — Configuration was disabled`) rather than
  // creating a second one, and the heartbeat file went away. `/Applications` is required for
  // *system-extension activation*, not for `NEFilterManager`.
  //
  // Best effort on purpose: it is an early disable, and `off` below is the gate that must hold.
  // Nothing here can distinguish "already off" from "could not ask", and both are fine to continue on.
  restoreExecutableBits(shipped)
  const wasEnforcing = isFilterEnforcing()
  reportProgress(opts, 'disabling')
  const preOff = spawnSync(join(shipped, 'Contents', 'MacOS', 'TapflowNetFilter'), ['--off'], {
    encoding: 'utf8', timeout: OFF_TIMEOUT_MS,
  })
  // **Exit 0 is not "a filter was switched off".** `--off` treats an absent configuration as a
  // success on purpose (`Host/main.swift`: "Nothing to turn off is a success, not a failure"), so
  // on a Mac that never had a filter this would answer yes — and `filterLeftDisabled` is what both
  // commands print *"the filter is switched off"* from. Telling someone that about a filter they
  // never had is a smaller lie than the one this flag exists to stop, and still a wrong diagnosis.
  const preOffTook = wasEnforcing && preOff?.status === 0

  reportProgress(opts, 'copying')
  const copy = spawnSync('/usr/bin/ditto', [shipped, NET_FILTER_APP], {
    encoding: 'utf8', timeout: COPY_TIMEOUT_MS,
  })
  if (!copy || copy.status !== 0) {
    return {
      status: 'failed',
      code: copy?.status ?? -1,
      detail: (copy?.stderr || 'ditto failed').trim(),
      // **Reports the disable above, because by now it may have happened.** Answering a flat `false`
      // here would tell someone their network is unaffected while their filter is switched off, and
      // that sentence is what `migrate` and `setup` print from this flag.
      filterLeftDisabled: preOffTook,
    }
  }

  restoreExecutableBits(NET_FILTER_APP)

  // **Take the filter out of the flow path before activating, and do it with the binary just copied
  // in.**
  //
  // **macOS fails a filter session closed, and that is the mechanism — not flows queueing for an
  // absent provider.** When a `filterSockets` session goes down, `nesessionmanager` arms a
  // kernel-wide drop: `applyIPDefaultDrop: IP Drop-All enabled <Last>`, `Persistent IP Drop-All level
  // <5>`. So the symptom is an instant `No route to host` on every new connection, in 1–2ms, rather
  // than the hang the shape of the problem suggests — worth knowing before reading a bug report about
  // it, because someone looking for stuck sockets will not find any.
  //
  // Reconstructed from the unified log for 2026-09-02: the replace stopped the plugin at 14:01:56
  // with nothing restarting it, the armed drop stayed armed, and the Mac had no network for 2m34s
  // until a restart (`nesessionmanager` pid 381 → 403 at 14:04:30). Disabling first means the session
  // is already down when the activation touches it, and a disabled configuration takes the drop back
  // down with it.
  //
  // What is left is the window while the filter comes back up, measured across ~300 probes: about
  // four seconds of raised latency (10-30ms to 200-400ms) and **no failures**, because the kernel
  // passes traffic a provider has not applied settings for yet. Measured again through a real
  // extension replace on 2026-09-03: 2 failed probes out of 468, and the whole command took 2.8s.
  //
  // **This is the second disable, and it is the one that gates the activation.** The first ran before
  // the copy, from `shipped`, against the installed-apps notification `ditto` triggers; see there for
  // why that one is best-effort and this one is not.
  //
  // Both exist because they answer different things. That one is about a *restart* macOS performs on
  // its own timing, so it has to be earlier than an event nothing here controls. This one is about the
  // *activation* on the line below, which is ours, so it can be immediately before it — and it must be
  // the last word, because the window between here and `--install` is the one thing this function is
  // ordering. The earlier call may also have found nothing to do: a Mac with no filter installed yet
  // has no configuration to switch off, and the copy is what makes the rest of this possible.
  //
  // Asking the binary the copy just landed keeps working the way it always did — it is the one that
  // understands the flag, and it is there because `ditto` put it there. A build older than the flag
  // does not refuse it (every unrecognised argument fell through to `.configure`, which writes
  // `isEnabled = true`), which is why neither call asks whatever happened to be installed already.
  //
  // `--install` turns it back on by itself: with no `--add`/`--remove` it takes `clearAll`, and
  // `configureFilter` ends with `isEnabled = true`. So there is no re-enable step to forget.
  // Snapshotted so the failure below cannot be explained by a line the *earlier* disable wrote. The
  // host appends to one log, so once two runs share it, "the last line" stops meaning "this run".
  // **One report for the disable and the activation together**, because they are one sequence to the
  // person waiting: the filter comes out of the path and the extension goes in. Reporting the second
  // `--off` on its own would say `disabling` twice for what reads as a single step.
  reportProgress(opts, opts.openApprovalSheet ? 'activating-with-sheet' : 'activating')
  const logBeforeOff = hostLogTail()
  const off = spawnSync(join(NET_FILTER_APP, 'Contents', 'MacOS', 'TapflowNetFilter'), ['--off'], {
    encoding: 'utf8', timeout: OFF_TIMEOUT_MS,
  })
  // **Stop rather than continue.** A disable that did not take leaves the filter enabled, which is
  // exactly the state the activation must not meet. The copy has landed but nothing is activated yet,
  // so stopping costs an upgrade and continuing costs the Mac's network.
  if (!off || off.status !== 0) {
    return {
      status: 'failed',
      code: off?.status ?? -1,
      detail: (hostLogTail() === logBeforeOff ? '' : hostLogTail()) || (off?.stderr || '').trim()
        || 'could not switch the filter off before replacing it',
      // The earlier call may have already taken it off, and if it did, saying otherwise here is the
      // same false reassurance as on the `ditto` failure above.
      filterLeftDisabled: preOffTook,
    }
  }

  // After every refusal and the gate disable, so nothing opens for an install that did not happen.
  if (opts.openApprovalSheet) openApprovalSheetWhenAsked()
  const run = spawnSync(join(NET_FILTER_APP, 'Contents', 'MacOS', 'TapflowNetFilter'), ['--install'], {
    encoding: 'utf8', timeout: INSTALL_TIMEOUT_MS,
  })
  if (!run) {
    return { status: 'failed', code: -1, detail: 'the filter host did not run', filterLeftDisabled: true }
  }
  switch (run.status) {
    // **Exit 0 is "nothing refused", which is smaller than "it works"** — `Host/main.swift` says so
    // itself. The framework hands the configuration to the provider afterwards with nothing coming
    // back, and this run has just switched the filter off on the strength of that report. So the last
    // thing it does is look.
    // **From a baseline, not from freshness.** The heartbeat this is waiting for has to have been
    // written after the activation returned; the previous provider's last one can still be inside the
    // freshness window, and reading it would report success over a Mac where nothing came back.
    //
    // The second is exclusive, so a provider that came up inside the same second waits one more —
    // cheaper than the ambiguity, since the file only carries whole seconds.
    case 0: {
      // Only this branch waits. The approval and reboot paths below return with nothing left to
      // watch, so reporting `confirming` there would name a wait that never happens.
      reportProgress(opts, 'confirming')
      return waitForEnforcing(opts.confirmDeadlineMs ?? CONFIRM_DEADLINE_MS, Math.floor(Date.now() / 1000))
        ? { status: 'installed' }
        : { status: 'installed-unconfirmed' }
    }
    // **Approval and reboot differ in whether the filter came back**, which is why only one of them
    // carries the flag. The approval path dies before `configureFilter` runs, so the filter is still
    // off; the reboot path runs it — deliberately, since this binary is the only way a device is put
    // back online — so the filter is on and the *old* provider is enforcing until the restart.
    case EXIT_APPROVAL_TIMEOUT: return { status: 'needs-approval', filterLeftDisabled: true }
    case EXIT_NEEDS_REBOOT: return { status: 'needs-reboot' }
    default:
      return {
        status: 'failed',
        code: run.status ?? -1,
        detail: hostLogTail() || (run.stderr || '').trim() || `exit ${run.status}`,
        filterLeftDisabled: true,
      }
  }
}

/**
 * Wait for a provider to start enforcing, or give up.
 *
 * **Reading the heartbeat rather than asking over `--confirm`**, and the reason is agreement rather
 * than cost. `doctor ios` answers "is it running" from `isFilterEnforcing`, and two commands
 * answering one question from two sources eventually answer it differently — the same shape as
 * comparing a host version against an extension one. It is also a file read, so it cannot change the
 * Mac, which is not nothing on a path whose neighbours run a binary that once erased a rule when
 * handed a flag it did not know.
 *
 * `Atomics.wait` on a throwaway buffer, not a busy loop: `installNetFilter` is synchronous, and making
 * it async to sleep would change its signature and every one of its call sites for a pause. Both
 * commands are async — for a prompt — and that does not reach in here.
 */
function waitForEnforcing(deadlineMs: number, since: number): boolean {
  const until = Date.now() + deadlineMs
  for (;;) {
    if (isFilterEnforcing(Date.now(), since)) return true
    if (Date.now() >= until) return false
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, CONFIRM_POLL_MS)
  }
}

/**
 * The approval sheet: Login Items & Extensions with the Network Extensions sheet already presented and
 * tapflow's toggle in it.
 *
 * **Measured, and the obvious candidates are wrong.** On macOS 27.0 three URLs that look right land on
 * the wrong screen. `contributing/macos-settings-deep-link-diagnosis.md` has them, and has why the
 * result of opening this cannot be checked.
 */
export const APPROVAL_SHEET_URL =
  'x-apple.systempreferences:com.apple.ExtensionsPreferences'
  + '?extensionPointIdentifier=com.apple.system_extension.network_extension.extension-point'

/**
 * How long to wait, once the sheet is offered, for someone to switch tapflow on.
 *
 * The host's own approval deadline, reused on purpose: the person has already had that long once
 * without knowing where to go, and is now being shown. Longer keeps a terminal hanging over a window
 * that was dismissed; shorter gives up on someone typing an administrator password.
 */
export const APPROVAL_WAIT_MS = 120_000

/** How often to ask whether it happened. `systemextensionsctl list` answers locally in tens of
 *  milliseconds, so a second between looks is a person's pace rather than the machine's. */
const APPROVAL_POLL_MS = 1_000

/**
 * How long the switch-on run gets. **A person's scale, not a preference save's.**
 *
 * On a first install nothing has written a filter configuration yet — `--off` finds none to disable,
 * and the approval run died before `configureFilter` — so this save is the one that creates it, and
 * that is where macOS asks whether to allow tapflow to filter network content. The save waits on the
 * answer (`Host/main.swift`: declining makes it fail). The prompt is recorded in the content-filter
 * research; that it lands on this save on macOS 27 is inferred, not measured. A long bound costs only
 * time on a wedged run, and a short one kills the host while someone reads the dialog.
 */
const SWITCH_ON_TIMEOUT_MS = APPROVAL_WAIT_MS

/**
 * What the approval step says. One map, for the same reason as `INSTALL_STAGE_MESSAGE`.
 *
 * **`opening` never says the sheet is open**, because nothing can know that — see
 * `APPROVAL_SHEET_URL`. It says where it is going and keeps the path for when it does not arrive.
 *
 * **`prompt` carries the warning, not only `switching`.** A yes to "open the screen" is carried
 * through to switching the filter on, which drops connections; asking about one and doing the other is
 * consent to something else. `switching` repeats it at the moment itself, but by then System Settings
 * has focus and the line may never be read — and over SSH the switch closes the session that would
 * have printed anything after it.
 */
export const APPROVAL_MESSAGE = {
  upfront: 'macOS will ask you to allow tapflow\'s network extension. Open the approval screen for you when'
    + ' it does? Once you switch it on there, tapflow turns the filter on, and connections this Mac already'
    + ' has open may drop for a moment — SSH sessions included.',
  prompt: 'macOS is waiting for you to allow tapflow\'s network extension. Open the approval screen?'
    + ' Once you switch it on there, tapflow turns the filter on, and connections this Mac already has'
    + ' open may drop for a moment — SSH sessions included.',
  opening: `Opening ${APPROVAL_PATH} — switch TapflowNetFilter on there. If nothing appears, go there by that path.`,
  waiting: `Waiting up to ${APPROVAL_WAIT_MS / 60_000} minutes for it to be switched on…`,
  switching: 'Allowed. Switching the filter on — if macOS asks whether to allow tapflow to filter network'
    + ' content, allow it. Connections this Mac already has open may drop for a moment, SSH sessions'
    + ' included.',
} as const

/**
 * What the approval step needs from whoever runs it.
 *
 * Parameters rather than imports, so this module stays free of anything that reads a keyboard and the
 * flow can be handed a person who answers yes or no. The terminal's version is
 * `terminalApprovalDeps` in `approval-prompt.ts`.
 */
export interface ApprovalDeps {
  /** Only an interactive terminal is asked. Anything else keeps the `needs-approval` banner, which
   *  already says what to do. */
  interactive: boolean
  /** A yes/no question. `'cancelled'` is someone backing out (Ctrl-C, Esc), which is not a no. */
  confirm: (message: string) => Promise<boolean | 'cancelled'>
  /** One line of what is happening. */
  say: (line: string) => void
  /** Overridable so a test that means "nobody approved" does not spend two minutes proving it. */
  approvalWaitMs?: number
}

/** The one outcome `followThroughApproval` starts from. */
export type NeedsApproval = Extract<InstallOutcome, { status: 'needs-approval' }>

/**
 * What `offerApprovalUpFront` got, which decides whether `followThroughApproval` asks again.
 *
 * `cancelled` is its own answer because the question comes before anything has changed. A no still
 * installs; backing out of the question must not, or the person who read "connections may drop — SSH
 * included" and pressed Ctrl-C gets exactly that.
 */
export type ApprovalOffer = 'accepted' | 'declined' | 'cancelled' | 'not-asked'

/**
 * Ask **before** installing whether to open the approval screen when macOS asks for it.
 *
 * **Why before, when `followThroughApproval` already offers it.** That offer comes only after the host
 * has waited out its 120 seconds, and a blocking `spawnSync` cannot act sooner. Measured on macOS 27
 * (2026-09-17), those two minutes are where people get lost: the dialog's default button is OK, which
 * dismisses it and leaves the extension unapproved, and a rerun shows no dialog at all because macOS
 * does not ask twice about a request already waiting. Both left someone watching one line for two
 * minutes, and pressing ^C.
 *
 * **Predicted rather than detected.** No tapflow extension `[activated enabled]` means macOS will ask:
 * a first install, a rerun over a request still waiting, and a reinstall after a removal all read that
 * way. A replace by the same team is not asked about, so an activated extension is not offered here
 * and keeps the offer that comes after the wait. A wrong prediction — a Mac whose MDM pre-approves —
 * costs one question, and the sheet then never opens because nothing waits.
 *
 * Asked before the install's own checks run, so its device check still sees a simulator somebody
 * started while this question was on screen.
 */
export async function offerApprovalUpFront(deps: ApprovalDeps): Promise<ApprovalOffer> {
  if (process.platform !== 'darwin' || !deps.interactive) return 'not-asked'
  if (!shippedAppPath() || activatedVersion() !== null) return 'not-asked'
  const answer = await deps.confirm(APPROVAL_MESSAGE.upfront)
  return answer === 'cancelled' ? 'cancelled' : answer ? 'accepted' : 'declined'
}

/**
 * Take an install that stopped at approval the rest of the way, in the same run (#799).
 *
 * `installNetFilter` answers `needs-approval` once the host has given up waiting for macOS. The
 * activation request stays pending after the host exits — #799 records someone approving after the
 * command had finished and the extension activating — which is why finishing later is possible at
 * all. Until now the command then said where to go and exited with the filter still switched off, so
 * even a prompt approval needed a second run to take effect. This offers the sheet, waits for the
 * switch, and turns the filter on.
 *
 * **Ways out before anything has waited return the outcome they were handed** — not interactive, no
 * version to recognise the approval by, or the offer declined. Nothing has changed since
 * `installNetFilter` decided it, so there is nothing newer to say.
 *
 * **An answer already given up front is not asked for again** (`offerApprovalUpFront`). A yes goes
 * straight to the sheet; a no returns the outcome it was handed, since the person has already said
 * they will approve it their own way.
 *
 * **Ways out after the wait report what they observe instead.** Minutes have passed, and something
 * else may have written the filter configuration meanwhile — a tapflow agent arming a simulator it
 * booted, for one — so "still switched off" is no longer a thing to assume.
 */
export async function followThroughApproval(
  handed: NeedsApproval, deps: ApprovalDeps, opts: InstallOptions = {}, offer: ApprovalOffer = 'not-asked',
): Promise<InstallOutcome> {
  if (!deps.interactive || offer === 'declined' || offer === 'cancelled') return handed

  // **Read before asking, not after.** Without a version there is nothing to recognise the approval by,
  // and offering a screen the command cannot then follow through on is worse than not offering it. Not
  // unreachable, either: `bundleVersion` answers null when `defaults read` times out.
  const shipped = shippedAppPath()
  const shippedExt = shipped ? bundleVersion(extensionBundle(shipped)) : null
  if (!shippedExt) return handed

  // Only a literal yes: a cancel here comes after the install, so it is a no rather than a way out.
  if (offer === 'not-asked' && (await deps.confirm(APPROVAL_MESSAGE.prompt)) !== true) return handed

  // Said first, so the line is on screen before a window takes focus.
  //
  // **Opened again after a yes up front, on purpose.** By now the opener showed the sheet about two
  // minutes ago and the person may be mid-way through the administrator password. Measured on macOS 27
  // (2026-09-17): the password prompt stays open through this `open` and through the rest of the wait,
  // so the reopen costs nothing there, and it restores a window someone closed.
  deps.say(APPROVAL_MESSAGE.opening)
  openApprovalSheet()

  deps.say(APPROVAL_MESSAGE.waiting)
  if (!waitForApproval(shippedExt, deps.approvalWaitMs ?? APPROVAL_WAIT_MS)) {
    return { status: 'needs-approval', filterLeftDisabled: !isFilterEnforcing() }
  }

  // **Asked again, because time has passed.** The install's own check ran before a prompt that waits for
  // as long as nobody answers, and before a two-minute wait. Switching the filter on drops connections
  // — #799 records an SSH session closed by exactly this — so a simulator somebody started meanwhile is
  // refused here for the same reason a replace is.
  //
  // **`filterLeftDisabled` rides along, and its presence is the point.** The install has already run
  // here, so this refusal is not "nothing was done" — both commands tell the two refusals apart by it.
  const busy = opts.ignoreRunningDevices ? [] : busyDevices()
  if (busy.length > 0) {
    return { status: 'refused-devices-busy', busy, filterLeftDisabled: !isFilterEnforcing() }
  }

  deps.say(APPROVAL_MESSAGE.switching)
  return switchFilterOn(opts)
}

/**
 * Open the approval sheet, and return nothing, because nothing can be known.
 *
 * `open` answers 0 and launches System Settings for a pane id that does not exist, so its status says
 * nothing about whether the sheet appeared. A `spawnSync` by this module's convention, since it changes
 * what is on the screen.
 */
function openApprovalSheet(): void {
  spawnSync('/usr/bin/open', [APPROVAL_SHEET_URL], { stdio: 'ignore', timeout: PROBE_TIMEOUT_MS })
}

/**
 * Opens the sheet once `$2` shows as waiting for the user in `$1 list`, then stops; gives up after
 * `$5` looks `$6` seconds apart. `$3 $4` is the open.
 *
 * Everything arrives as a positional parameter, so no value is ever parsed as shell. The commands are
 * parameters too, which is what lets a test run this very script against stand-ins.
 */
export const SHEET_OPENER_SCRIPT =
  'i=0; while [ "$i" -lt "$5" ]; do '
  + 'if "$1" list 2>/dev/null | grep -F "$2" | grep -q "waiting for user"; then exec "$3" "$4"; fi; '
  + 'i=$((i+1)); sleep "$6"; done'

/**
 * Looks and spacing for the opener: 45 seconds, the host's own bound for `sysextd` to answer at all
 * (exit 6). A request that has not reached "waiting" by then is not going to.
 */
export const SHEET_OPENER_LOOKS = 90
export const SHEET_OPENER_INTERVAL_S = '0.5'

/**
 * Open the approval sheet when macOS starts waiting, from a process that outlives nothing it needs.
 *
 * **A separate process because this one is about to block.** `--install` runs under `spawnSync` for up
 * to three minutes and nothing on this event loop moves meanwhile, so the only thing that can act
 * during the host's approval wait is something already running. Detached and unreferenced, and bounded
 * by its own loop, so it neither holds the command open nor lingers.
 *
 * **Waits for the request rather than opening at once.** Whether the sheet lists an entry that
 * appears after it opened is not measured; opening after `waiting for user` shows is the order that
 * was (#806). A rerun over a request already waiting opens on the first look.
 *
 * Best effort: when it cannot start, the offer after the host's wait still opens the sheet.
 */
function openApprovalSheetWhenAsked(): void {
  try {
    const child = spawn('/bin/sh', [
      '-c', SHEET_OPENER_SCRIPT, 'tapflow-sheet-opener',
      '/usr/bin/systemextensionsctl', EXT_BUNDLE_ID, '/usr/bin/open', APPROVAL_SHEET_URL,
      String(SHEET_OPENER_LOOKS), SHEET_OPENER_INTERVAL_S,
    ], { detached: true, stdio: 'ignore' })
    child.on('error', () => {})
    child.unref()
  } catch {
    // Nothing to report: the wait after this is unchanged, and so is the offer at its end.
  }
}

/**
 * Wait for macOS to report **this build's** extension activated.
 *
 * **Against the shipped version, not against "anything activated".** `installNetFilter` does not refuse
 * an older activated extension, so a Mac can arrive here with a previous version still
 * `[activated enabled]` — and a check for non-null would read that as approval given before anyone
 * touched the switch.
 *
 * Synchronous, like `waitForEnforcing`, and for the same reason.
 */
function waitForApproval(shippedExt: string, deadlineMs: number): boolean {
  const until = Date.now() + deadlineMs
  for (;;) {
    if (activatedVersion() === shippedExt) return true
    if (Date.now() >= until) return false
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, APPROVAL_POLL_MS)
  }
}

/**
 * Switch the filter on without activating anything: the host's plain configure mode.
 *
 * **Not `--install` again.** The extension has just been approved, and activating it once more brings in
 * the replace machinery — the conflict question, a possible reboot answer — for what is one preference
 * save. With no flags the host writes an empty rule with `isEnabled = true` and exits 0
 * (`Host/main.swift`, `case .configure`).
 *
 * **The rule is emptied, and that is what `--install` would have done** — it takes `clearAll` too. A
 * device can only be offline here if `--ignore-running-devices` was passed, since the busy check refuses
 * otherwise, and that flag already accepts interrupting it.
 */
function switchFilterOn(opts: InstallOptions): InstallOutcome {
  // Snapshotted for the same reason as the gate `--off`: the exit-4 run that led here left its own last
  // line in the shared log, and a failure below must not be explained by it.
  const logBefore = hostLogTail()
  const run = spawnSync(join(NET_FILTER_APP, 'Contents', 'MacOS', 'TapflowNetFilter'), [], {
    encoding: 'utf8', timeout: SWITCH_ON_TIMEOUT_MS,
  })
  if (!run || run.status !== 0) {
    // **A run that was cut off is not a save that failed**, and the two are reported apart. The likely
    // cause of the first is a person still reading macOS's content-filter question.
    const timedOut = (run?.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT'
    return {
      status: 'failed',
      code: run?.status ?? -1,
      detail: timedOut
        ? `nothing answered within ${SWITCH_ON_TIMEOUT_MS / 60_000} minutes — macOS may still be asking`
          + ' whether to allow tapflow to filter network content'
        : (hostLogTail() === logBefore ? '' : hostLogTail()) || (run?.stderr || '').trim()
          || run?.error?.message || 'could not switch the filter on',
      // A save that exited non-zero did not land, so the filter is off: the approval run died before
      // writing it. One that was cut off may have landed after all, and the heartbeat is what knows.
      filterLeftDisabled: timedOut ? !isFilterEnforcing() : true,
    }
  }
  // A save accepted is not a provider enforcing — the same look `installNetFilter` takes on exit 0.
  reportProgress(opts, 'confirming')
  return waitForEnforcing(opts.confirmDeadlineMs ?? CONFIRM_DEADLINE_MS, Math.floor(Date.now() / 1000))
    ? { status: 'installed' }
    : { status: 'installed-unconfirmed' }
}

/** The host binary logs its own exit reason; a bare code says which preference failed but not what the
 *  framework said about it. Best-effort — the log is not load-bearing. */
function hostLogTail(): string {
  try {
    const lines = readFileSync('/tmp/tapflow-netfilter-host.log', 'utf8').trim().split('\n')
    return lines.slice(-1)[0] ?? ''
  } catch {
    return ''
  }
}

/**
 * Put the executable bit back on everything under a `Contents/MacOS` inside the bundle.
 *
 * **Measured, not defensive.** A tarball does not have to carry file modes, and pnpm's does not: the
 * app arrives from the registry with its binaries at `rw-r--r--`, and `ditto` faithfully copies that
 * into `/Applications`, where `--install` then fails to execute. The package's `postinstall` chmods
 * `bin/` one level deep, which for a bundle sets the mode of the *directory* and never reaches
 * `Contents/MacOS/` — so the five flat helpers beside it are covered and this is not.
 *
 * Done here rather than only in `postinstall` because that script does not always run: `--ignore-scripts`
 * is a normal thing for a CI install to pass.
 *
 * Changing the mode does not disturb the signature: code signing seals contents, and `codesign
 * --verify --deep --strict` and `stapler validate` both still pass afterwards (measured).
 */
function restoreExecutableBits(appPath: string): void {
  const walk = (dir: string, inMacOS: boolean): void => {
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    // A listing that is not a listing — an unreadable directory, or a stubbed `fs` — is nothing to
    // walk. Trusting the shape here turns a missing directory into a TypeError three frames away.
    if (!Array.isArray(entries)) return
    for (const name of entries) {
      const p = join(dir, name)
      let isDir: boolean
      try {
        isDir = statSync(p).isDirectory()
      } catch {
        continue
      }
      if (isDir) walk(p, inMacOS || name === 'MacOS')
      else if (inMacOS) {
        try {
          chmodSync(p, 0o755)
        } catch {
          // Best effort. A file we cannot chmod is one `--install` will report on with a real code.
        }
      }
    }
  }
  walk(appPath, false)
}
