import { describe, expect, it } from 'vitest'
import { LEAN_PACKAGES, reconcileLean, type LeanDevice } from '../LeanPackages.js'

const [GSA, YT] = LEAN_PACKAGES

/**
 * An emulator's package manager and its /data/local/tmp, in memory. `durable` models what Android
 * really does: package state is written lazily, so a `kill()` before `flush()` loses it — which is
 * what `adb emu kill` does to a change made seconds before.
 */
class FakeDevice implements LeanDevice {
  enabled = new Set<string>(['android', ...LEAN_PACKAGES])
  disabled = new Set<string>()
  marker: string | null = null
  writes: string[] = []
  readFails = false
  listFails = false
  private durable = { enabled: new Set(this.enabled), disabled: new Set(this.disabled) }

  async packages() {
    if (this.listFails) return { enabled: new Set<string>(), disabled: new Set<string>() }
    return { enabled: new Set(this.enabled), disabled: new Set(this.disabled) }
  }
  async setEnabled(pkg: string, on: boolean) {
    this.writes.push(`${on ? 'enable' : 'disable'} ${pkg}`)
    ;(on ? this.disabled : this.enabled).delete(pkg)
    ;(on ? this.enabled : this.disabled).add(pkg)
  }
  async readMarker() {
    if (this.readFails) throw new Error('cat: device offline')
    return this.marker
  }
  async writeMarker(content: string) { this.writes.push('marker'); this.marker = content }
  async deleteMarker() { this.writes.push('delete marker'); this.marker = null }

  /** Package state reaches disk. The marker is written with a sync, so it always has. */
  flush() { this.durable = { enabled: new Set(this.enabled), disabled: new Set(this.disabled) } }
  /** `adb emu kill`: whatever package state was not flushed is gone. */
  kill() { this.enabled = new Set(this.durable.enabled); this.disabled = new Set(this.durable.disabled) }
}

const on = (d: LeanDevice, launched = true) => reconcileLean(d, { lean: true, launched })
const off = (d: LeanDevice, launched = true) => reconcileLean(d, { lean: false, launched })

describe('Lean mode on', () => {
  it('records what each package was, then disables it', async () => {
    const d = new FakeDevice()
    await on(d)
    expect(d.writes[0]).toBe('marker')
    expect([...d.disabled].sort()).toEqual([...LEAN_PACKAGES].sort())
    expect(JSON.parse(d.marker!).prior[GSA]).toBe('enabled')
  })

  it('disables nothing when the marker did not land', async () => {
    const d = new FakeDevice()
    d.writeMarker = async () => { d.writes.push('marker') }
    await expect(on(d)).rejects.toThrow(/read back/)
    expect(d.disabled.size).toBe(0)
  })

  it('does not touch an emulator it only attached to', async () => {
    // Its screen would change mid-session while the memory saving only comes with the next boot.
    const d = new FakeDevice()
    await on(d, false)
    expect(d.writes).toEqual([])
  })

  it('does nothing when the package list is not a real answer', async () => {
    // Right after boot the package manager can answer empty; read as "every package absent" that
    // would leave the AVD un-lean for good.
    const d = new FakeDevice()
    d.listFails = true
    await expect(on(d)).rejects.toThrow()
    expect(d.writes).toEqual([])
  })

  it('does nothing when the marker cannot be read, rather than recording the lean state as the original', async () => {
    const d = new FakeDevice()
    await on(d)
    d.readFails = true
    await expect(on(d)).rejects.toThrow()
    expect(d.writes.filter((w) => w === 'marker')).toHaveLength(1)
  })

  it('leaves a package the image does not have out of the record, and takes it in once it appears', async () => {
    const d = new FakeDevice()
    d.enabled.delete(YT)
    await on(d)
    expect(JSON.parse(d.marker!).prior).not.toHaveProperty(YT)
    d.enabled.add(YT)
    await on(d)
    expect(JSON.parse(d.marker!).prior[YT]).toBe('enabled')
    expect(d.disabled.has(YT)).toBe(true)
  })

  it('re-applies after a kill lost the change, without recording the lost state as the original', async () => {
    const d = new FakeDevice()
    await on(d)
    d.kill()
    expect(d.disabled.size).toBe(0)
    await on(d)
    expect(d.disabled.has(GSA)).toBe(true)
    expect(JSON.parse(d.marker!).prior[GSA]).toBe('enabled')
  })
})

describe('Lean mode off', () => {
  it('leaves a device it never touched alone', async () => {
    const d = new FakeDevice()
    await off(d)
    expect(d.writes).toEqual([])
  })

  it('re-enables what it disabled, and keeps the marker until a later boot confirms it', async () => {
    // The twin of the case above. Deleting the marker now would lose the only record if the enable
    // itself is lost to a kill.
    const d = new FakeDevice()
    await on(d); d.flush()
    await off(d)
    expect(d.disabled.size).toBe(0)
    expect(JSON.parse(d.marker!).restoring).toBe(true)

    d.flush()
    await off(d)
    expect(d.marker).toBeNull()
  })

  it('enables again on the next boot when the kill lost the restore', async () => {
    const d = new FakeDevice()
    await on(d); d.flush()
    await off(d)
    d.kill()
    expect(d.disabled.has(GSA)).toBe(true)
    await off(d)
    expect(d.disabled.size).toBe(0)
    expect(d.marker).not.toBeNull()
  })

  it('does not enable a package that was already disabled before Lean mode', async () => {
    const d = new FakeDevice()
    await d.setEnabled(YT, false); d.writes = []
    await on(d); d.flush()
    await off(d)
    expect(d.disabled.has(YT)).toBe(true)
    expect(d.enabled.has(GSA)).toBe(true)
  })

  it('keeps the marker while a package it restored cannot be seen at all', async () => {
    // Neither enabled nor disabled is unknown, not restored.
    const d = new FakeDevice()
    await on(d); d.flush()
    await off(d); d.flush()
    d.enabled.delete(GSA)
    await off(d)
    expect(d.marker).not.toBeNull()
  })

  it('restores even on an emulator it only attached to', async () => {
    const d = new FakeDevice()
    await on(d); d.flush()
    await off(d, false)
    expect(d.disabled.size).toBe(0)
  })

  it('back on after being turned off drops the restoring state and disables again', async () => {
    const d = new FakeDevice()
    await on(d); d.flush()
    await off(d)
    await on(d)
    expect(JSON.parse(d.marker!).restoring).toBeUndefined()
    expect(d.disabled.has(GSA)).toBe(true)
  })
})

describe('an unreadable marker', () => {
  it('is replaced, and the packages it covered are turned back on, rather than trusted or deleted', async () => {
    // These packages are enabled out of the box, so enabling is the safe direction.
    const d = new FakeDevice()
    await on(d); d.flush()
    d.marker = '{not json'
    await off(d)
    expect(d.disabled.size).toBe(0)
    expect(JSON.parse(d.marker!).restoring).toBe(true)
    // And a later boot that finds them enabled is what retires it.
    d.flush()
    await off(d)
    expect(d.marker).toBeNull()
  })
})
