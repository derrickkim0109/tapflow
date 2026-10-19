import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'

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
  constructor(private readonly root = '/private/var/tmp') {}

  /**
   * Disable `labels` on a shut-down device. Safe to repeat: a label already recorded keeps its first
   * record, and one the marker does not have yet — a newer list booting a device an older one marked —
   * is recorded now, before it is overwritten.
   */
  apply(udid: string, labels: readonly string[]): void {
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
