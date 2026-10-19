/**
 * Lean mode on Android: bundled Google apps nobody testing an app needs, kept disabled while Lean
 * mode is on and put back when it is turned off.
 *
 * **Why disabled, and why it has to last across boots.** The emulator has no memory balloon on
 * macOS, so a page the guest touched stays the host's until the process exits. Measured on API 34
 * (2026-09-25): these apps start at boot and account for about 350 MB of the ~2 GB the guest
 * touches, and restricting them to the background changed nothing — they start anyway, and the
 * guest fills the space with page cache. Disabling them works, but only if they are disabled
 * *before* the boot: the boot that disables them has already paid. So unlike iOS, where the
 * override is written before each boot and removed at shutdown, this state lives in the AVD for as
 * long as Lean mode is on.
 *
 * **Chosen for what an app under test can still do.** Measured by resolving intents before and
 * after: speech recognition is served by `com.google.android.tts` and `com.google.android.as`, not
 * the Google app, so voice input keeps working. The Google app is the only handler of
 * `ACTION_WEB_SEARCH` and holds the assistant role, and those two go while it is off (the role
 * returns when it is re-enabled). Photos was measured and left out: it is the only handler of
 * `ACTION_VIEW image/*`, so an app's "open photo" would fail. Messages, Gmail and Maps are left
 * out for the same reason — SMS, `mailto:` and `geo:` intents.
 *
 * **The same judgement scopes `StorageReclaim`**, which rolls back these apps' updates when an
 * install runs out of space. Adding a package here makes it a rollback target too.
 */
export const LEAN_PACKAGES = [
  'com.google.android.googlequicksearchbox',
  'com.google.android.youtube',
  'com.google.android.apps.youtube.music',
  'com.google.android.apps.wellbeing',
] as const

export const LEAN_MARKER_PATH = '/data/local/tmp/tapflow-lean.json'

/** What reconciling needs from a booted emulator. `AndroidAgent` adapts `AdbWrapper` to it. */
export interface LeanDevice {
  /** Package names by state. Not trusted unless it names `android` — see `readPackages`. */
  packages(): Promise<{ enabled: Set<string>; disabled: Set<string> }>
  setEnabled(pkg: string, enabled: boolean): Promise<void>
  /** The marker's text, `null` when there is none; throws when it could not be read. */
  readMarker(): Promise<string | null>
  /** Written atomically and synced, so it reaches disk before anything it describes can. */
  writeMarker(content: string): Promise<void>
  deleteMarker(): Promise<void>
}

type PackageState = 'enabled' | 'disabled'
interface Marker {
  /** What each package was before Lean mode first disabled it. Absent packages are not recorded. */
  prior: Record<string, PackageState>
  /** Lean mode was turned off and the packages re-enabled; removed once a later boot confirms it. */
  restoring?: true
}

/**
 * Bring the device to what `lean` asks for. Called after every boot through a session, the way
 * `resetNetworkForSession` is: a shutdown path does not run after a crash, a closed terminal or
 * `dev:down`, and a boot always comes.
 *
 * `launched` says this call started the emulator. Lean mode is applied only then — an emulator
 * the agent merely attached to may be someone's, mid-use, and disabling apps changes its screen at
 * once while the saving only arrives with the next boot. Restoring is allowed either way.
 *
 * Throws when the device cannot answer reliably; the caller logs it and the next boot tries again.
 */
export async function reconcileLean(device: LeanDevice, opts: { lean: boolean; launched: boolean }): Promise<string> {
  if (opts.lean && !opts.launched) return 'Lean mode applies from the next boot through tapflow'
  // With Lean mode off, a device it never touched costs one read, not a package listing.
  if (!opts.lean && (await device.readMarker()) === null) return 'Lean mode: off'
  const state = await readPackages(device)
  const read = await readMarkerFrom(device, state)
  let marker = read.marker

  if (opts.lean) {
    const prior = { ...(marker?.prior ?? {}) }
    for (const pkg of LEAN_PACKAGES) {
      const s = state.get(pkg)
      // A package the image lacks is decided again each boot rather than recorded as absent: one
      // installed later would otherwise be disabled with no record to re-enable it from.
      if (s && !(pkg in prior)) prior[pkg] = s
    }
    const next: Marker = { prior }
    if (!marker || marker.restoring || JSON.stringify(marker.prior) !== JSON.stringify(prior)) {
      await writeVerified(device, next)
      marker = next
    }
    const toDisable = LEAN_PACKAGES.filter((pkg) => prior[pkg] === 'enabled' && state.get(pkg) === 'enabled')
    for (const pkg of toDisable) await device.setEnabled(pkg, false)
    return toDisable.length > 0 ? `Lean mode: disabled ${toDisable.length} app(s); saves memory from the next boot` : 'Lean mode: on'
  }

  if (!marker) return 'Lean mode: off'
  // Just rebuilt from an unreadable one, so its re-enables are this boot's and not yet confirmed.
  if (read.rebuilt) return 'Lean mode: off, re-enabled after an unreadable marker'
  const toEnable = Object.entries(marker.prior)
    .filter(([pkg, was]) => was === 'enabled' && state.get(pkg) === 'disabled')
    .map(([pkg]) => pkg)
  if (toEnable.length === 0) {
    // The record goes only once every package it says was enabled is seen enabled. One in neither
    // list is unknown rather than restored, and deleting the record then could leave it off for good.
    const confirmed = Object.entries(marker.prior).every(([pkg, was]) => was !== 'enabled' || state.get(pkg) === 'enabled')
    if (!confirmed) return 'Lean mode: off, waiting to confirm the restore'
    await device.deleteMarker()
    return 'Lean mode: off, restored'
  }
  // Kept, marked restoring, until a later boot finds these enabled: the enable is written lazily
  // and an `emu kill` seconds from now would lose it — along with the only record, had it gone first.
  if (!marker.restoring) await writeVerified(device, { prior: marker.prior, restoring: true })
  for (const pkg of toEnable) await device.setEnabled(pkg, true)
  return `Lean mode: off, re-enabled ${toEnable.length} app(s)`
}

/** Package states, refusing an answer that cannot be real: every booted device has `android`. */
async function readPackages(device: LeanDevice): Promise<Map<string, PackageState>> {
  const { enabled, disabled } = await device.packages()
  if (!enabled.has('android')) throw new Error('the package manager gave no usable answer yet')
  const state = new Map<string, PackageState>()
  for (const pkg of enabled) state.set(pkg, 'enabled')
  for (const pkg of disabled) state.set(pkg, 'disabled')
  return state
}

/**
 * The marker, or `null` for none. One that is there but unparseable is not trusted and not deleted:
 * the packages it covered are enabled out of the box, so they are re-enabled and a fresh restoring
 * record is written in its place.
 */
async function readMarkerFrom(device: LeanDevice, state: Map<string, PackageState>): Promise<{ marker: Marker | null; rebuilt: boolean }> {
  const raw = await device.readMarker()
  if (raw === null) return { marker: null, rebuilt: false }
  try {
    const parsed = JSON.parse(raw) as Marker
    if (typeof parsed.prior !== 'object' || parsed.prior === null) throw new Error('no prior')
    return { marker: parsed, rebuilt: false }
  } catch {
    const prior: Record<string, PackageState> = {}
    for (const pkg of LEAN_PACKAGES) if (state.has(pkg)) prior[pkg] = 'enabled'
    const rebuilt: Marker = { prior, restoring: true }
    await writeVerified(device, rebuilt)
    for (const pkg of LEAN_PACKAGES) {
      if (state.get(pkg) === 'disabled') {
        await device.setEnabled(pkg, true)
        state.set(pkg, 'enabled')
      }
    }
    return { marker: rebuilt, rebuilt: true }
  }
}

/** Nothing is disabled on the strength of a record that did not land. */
async function writeVerified(device: LeanDevice, marker: Marker): Promise<void> {
  const text = JSON.stringify(marker)
  await device.writeMarker(text)
  if ((await device.readMarker()) !== text) throw new Error('the Lean mode marker did not read back as written')
}
