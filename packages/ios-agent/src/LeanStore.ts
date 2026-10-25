import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { ServiceTier } from '@tapflowio/protocol'

/**
 * A simulator's launchd disable overrides, and the record of which of them Lean mode set.
 *
 * **The overrides live on the host, not in the device.** `launchd_sim` is a host process and keeps
 * them in `/private/var/tmp/com.apple.CoreSimulator.SimDevice.<udid>/disabled.plist`, reading the file
 * when it starts. Writing it there while the device is shut down is how the labels are disabled: the
 * iOS 27 runtime has no `/bin/sh`, so the other route — one `simctl spawn launchctl disable` per
 * label, about 3.5s each — is the only one left inside the device, and it is slow.
 *
 * Three measured facts shape the rest (2026-09-25, macOS 26.5 and 27.0):
 * - The file survives `simctl erase` and `simctl delete`. Nothing undoes it but a write.
 * - A store written before a device's first boot is honoured, and the runtime merges its own entries
 *   in beside ours rather than replacing the file.
 * - Two of the labels are off by default in their own plists. Reverting by writing `false` would turn
 *   them on, so a revert puts back what each label was — which is why applying records it.
 */
export class LeanStore {
  /**
   * `managed` is every label a tier can disable (`LEAN_LABELS` ∪ `SLIM_LABELS`). Only used to recover from a marker
   * that cannot be read; without it that case throws, as before tiers.
   */
  constructor(
    private readonly root = '/private/var/tmp',
    private readonly managed: readonly string[] = [],
  ) {}

  /**
   * Put a shut-down device on `tier`: exactly `labels` disabled by us, nothing left from an earlier tier.
   *
   * **The one way in.** `apply` alone only adds, so a device left slim and then booted lean kept slim's extra
   * labels off — a person got a device without push or photos and nothing said so (L2 review R3-8, R4-S1). So
   * every change goes back to what the device had before tapflow touched it, then applies the new set, and the
   * marker names the tier so the next boot can tell whether anything needs to change. `stock` is the revert
   * alone. A crash between the two halves leaves the device stock, which is the safe side.
   */
  setTier(udid: string, tier: ServiceTier, labels: readonly string[]): void {
    this.revert(udid)
    if (labels.length === 0) return
    this.apply(udid, labels)
    const marker = JSON.parse(readFileSync(this.markerPath(udid), 'utf8')) as { prior: Record<string, boolean | null> }
    atomicWrite(this.markerPath(udid), JSON.stringify({ ...marker, tier }, null, 2) + '\n')
  }

  /**
   * The tier the device boots with, as the marker records it. No marker is `stock`. A marker from before tiers
   * carries none: only Lean mode wrote those, so it is `lean`.
   */
  currentTier(udid: string): ServiceTier {
    if (!existsSync(this.markerPath(udid))) return { name: 'stock', keep: [] }
    try {
      const { tier } = JSON.parse(readFileSync(this.markerPath(udid), 'utf8')) as { tier?: ServiceTier }
      return tier ?? { name: 'lean', keep: [] }
    } catch {
      // Unreadable: `revert` will clear it on the next change. Until then nobody can say what it disabled.
      return { name: 'lean', keep: [] }
    }
  }

  /**
   * Disable `labels` on a shut-down device. Safe to repeat: a label already recorded keeps its first
   * record, and one the marker does not have yet — a newer list booting a device an older one marked —
   * is recorded now, before it is overwritten. Private: callers change tiers through `setTier`.
   */
  private apply(udid: string, labels: readonly string[]): void {
    const dir = this.dir(udid)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const entries = this.readStore(udid)
    const marked = existsSync(this.markerPath(udid))
    const prior: Record<string, boolean | null> = marked
      ? (JSON.parse(readFileSync(this.markerPath(udid), 'utf8')) as { prior: Record<string, boolean | null> }).prior
      : {}
    const missing = labels.filter((label) => !(label in prior))
    for (const label of missing) prior[label] = label in entries ? entries[label] : null
    if (!marked || missing.length > 0) atomicWrite(this.markerPath(udid), JSON.stringify({ prior }, null, 2) + '\n')
    for (const label of labels) entries[label] = true
    atomicWrite(this.storePath(udid), renderDisabledStore(entries))
  }

  /** Undo `apply` on a shut-down device. Returns false, touching nothing, when Lean mode never applied. */
  revert(udid: string): boolean {
    if (!existsSync(this.markerPath(udid))) return false
    let prior: Record<string, boolean | null>
    try {
      prior = (JSON.parse(readFileSync(this.markerPath(udid), 'utf8')) as { prior: Record<string, boolean | null> }).prior
      if (typeof prior !== 'object' || prior === null) throw new Error('no prior values')
    } catch (e) {
      // What each label was is gone with the marker. Without a recovery the next `setTier` would record what it finds
      // now — our own `true`s — as what the device had before, and those labels would stay off for good. So every label
      // a tier can touch loses its entry, which hands it back to its own plist's default: the runtime's state for a
      // label we never wrote, and correct for the two that are off by default, where writing `false` would not be.
      if (this.managed.length > 0) {
        try {
          const entries = this.readStore(udid)
          for (const label of this.managed) delete entries[label]
          atomicWrite(this.storePath(udid), renderDisabledStore(entries))
          rmSync(this.markerPath(udid))
          return true
        } catch (storeError) {
          // The store cannot be read either. **The marker stays**, unlike the branch below: this recovery needs nothing
          // from it, so the next revert can retry once the store reads again — while dropping it would leave the device
          // reported as stock with its overrides still on and nothing left to say so.
          throw new Error(`the Lean mode marker for ${udid} was unreadable and the store could not be repaired yet (${(storeError as Error).message})`)
        }
      }
      // Nothing can be put back without it, and keeping it would fail every revert from here on.
      rmSync(this.markerPath(udid))
      throw new Error(`the Lean mode marker for ${udid} was unreadable and has been removed; its services may still be disabled (${(e as Error).message})`)
    }
    // A store this cannot read is left exactly as it is, marker included: rewriting it would drop
    // entries, and dropping the marker would hide that the device is still lean.
    const entries = this.readStore(udid)
    for (const [label, was] of Object.entries(prior)) {
      if (was === null) delete entries[label]
      else entries[label] = was
    }
    atomicWrite(this.storePath(udid), renderDisabledStore(entries))
    rmSync(this.markerPath(udid))
    return true
  }

  isApplied(udid: string): boolean {
    return existsSync(this.markerPath(udid))
  }

  /** Every udid carrying the marker, including devices that no longer exist — callers intersect. */
  applied(): string[] {
    const prefix = 'com.apple.CoreSimulator.SimDevice.'
    if (!existsSync(this.root)) return []
    return readdirSync(this.root)
      .filter((name) => name.startsWith(prefix))
      .map((name) => name.slice(prefix.length))
      .filter((udid) => this.isApplied(udid))
  }

  private dir(udid: string): string {
    return join(this.root, `com.apple.CoreSimulator.SimDevice.${udid}`)
  }

  private storePath(udid: string): string {
    return join(this.dir(udid), 'disabled.plist')
  }

  private markerPath(udid: string): string {
    return join(this.dir(udid), 'tapflow-lean.json')
  }

  private readStore(udid: string): Record<string, boolean> {
    const path = this.storePath(udid)
    return existsSync(path) ? parseDisabledStore(readFileSync(path, 'utf8')) : {}
  }
}

/** The runtime renames nothing into place mid-read, so neither do we: launchd_sim must never read half a file. */
function atomicWrite(path: string, content: string): void {
  const tmp = `${path}.tapflow-${process.pid}`
  writeFileSync(tmp, content)
  renameSync(tmp, path)
}

const XML_ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" }

/**
 * The store is an XML plist holding one dict of label → bool, which is all the runtime writes.
 * **Anything else is refused rather than rewritten**: a file this cannot fully read is one it would
 * drop entries from on the way back out.
 */
export function parseDisabledStore(xml: string): Record<string, boolean> {
  const body = xml.match(/<plist[^>]*>\s*(<dict\s*\/>|<dict>([\s\S]*)<\/dict>)\s*<\/plist>/)
  if (!body) throw new Error('disabled.plist is not a plist holding one dict')
  const entries: Record<string, boolean> = {}
  const inner = body[2] ?? ''
  const pair = /\s*<key>([^<]*)<\/key>\s*<(true|false)\/>/y
  let at = 0
  for (let m = pair.exec(inner); m; m = pair.exec(inner)) {
    entries[m[1].replace(/&(amp|lt|gt|quot|apos);/g, (e) => XML_ENTITIES[e])] = m[2] === 'true'
    at = pair.lastIndex
  }
  if (inner.slice(at).trim() !== '') throw new Error('disabled.plist holds something other than label → bool')
  return entries
}

export function renderDisabledStore(entries: Record<string, boolean>): string {
  const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const rows = Object.entries(entries).map(([label, off]) => `\t<key>${escape(label)}</key>\n\t<${off}/>\n`).join('')
  return '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n'
    + '<plist version="1.0">\n'
    + (rows ? `<dict>\n${rows}</dict>\n` : '<dict/>\n')
    + '</plist>\n'
}
