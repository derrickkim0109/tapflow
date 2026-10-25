import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ServiceTier } from '@tapflowio/protocol'
import { LeanStore, parseDisabledStore, renderDisabledStore } from '../LeanStore.js'

const UDID = 'AAAAAAAA-1111-2222-3333-444444444444'
const LABELS = ['com.apple.assistantd', 'com.apple.intelligenceflowd', 'com.apple.triald']
const LEAN: ServiceTier = { name: 'lean', keep: [] }
const SLIM: ServiceTier = { name: 'slim', keep: [] }

let root: string
let store: LeanStore
const dir = () => join(root, `com.apple.CoreSimulator.SimDevice.${UDID}`)
const storePath = () => join(dir(), 'disabled.plist')
const read = () => parseDisabledStore(readFileSync(storePath(), 'utf8'))
/** What the runtime leaves behind on its own: explicit entries for labels we never touch. */
const seed = (entries: Record<string, boolean>) => {
  mkdirSync(dir(), { recursive: true })
  writeFileSync(storePath(), renderDisabledStore(entries))
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tapflow-lean-'))
  store = new LeanStore(root)
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('the store format', () => {
  it('reads what the runtime writes and writes it back the same', () => {
    const xml = renderDisabledStore({ 'com.apple.a': false, 'com.apple.b': true })
    expect(xml).toContain('<!DOCTYPE plist')
    expect(parseDisabledStore(xml)).toEqual({ 'com.apple.a': false, 'com.apple.b': true })
    expect(parseDisabledStore(renderDisabledStore({}))).toEqual({})
  })

  it('refuses a store it does not fully understand rather than rewriting it', () => {
    const odd = renderDisabledStore({ 'com.apple.a': true }).replace('<true/>', '<string>x</string>')
    expect(() => parseDisabledStore(odd)).toThrow()
  })
})

describe('setTier', () => {
  it('creates the directory and the store for a device that has never booted', () => {
    store.setTier(UDID, LEAN, LABELS)
    expect(read()).toEqual(Object.fromEntries(LABELS.map((l) => [l, true])))
    // launchd_sim creates it 0700; a store we create should not be wider than the runtime's own.
    expect(statSync(dir()).mode & 0o777).toBe(0o700)
    expect(store.isApplied(UDID)).toBe(true)
  })

  it('keeps every entry it does not manage', () => {
    seed({ 'com.apple.nanonewscd': false, 'com.apple.otpaird': true })
    store.setTier(UDID, LEAN, LABELS)
    expect(read()).toMatchObject({ 'com.apple.nanonewscd': false, 'com.apple.otpaird': true })
  })
})

describe('revert', () => {
  it('puts back what each label was, including labels that had no entry', () => {
    // `intelligenceflowd` is off by default in its plist; writing `false` on revert would turn it on.
    seed({ 'com.apple.intelligenceflowd': true, 'com.apple.triald': false, 'com.apple.nanonewscd': false })
    store.setTier(UDID, LEAN, LABELS)
    expect(store.revert(UDID)).toBe(true)
    expect(read()).toEqual({ 'com.apple.intelligenceflowd': true, 'com.apple.triald': false, 'com.apple.nanonewscd': false })
    expect(store.isApplied(UDID)).toBe(false)
  })

  it('a second change does not record its own values as what was there before', () => {
    seed({ 'com.apple.triald': false })
    store.setTier(UDID, LEAN, LABELS)
    store.setTier(UDID, LEAN, LABELS)
    store.revert(UDID)
    expect(read()).toEqual({ 'com.apple.triald': false })
  })

  it('puts back labels a later, longer list added', () => {
    // A device on one list and then another: the second list's extra labels must come back on revert too.
    seed({ 'com.apple.nanonewscd': false })
    store.setTier(UDID, LEAN, LABELS.slice(0, 2))
    store.setTier(UDID, LEAN, [...LABELS, 'com.apple.nanonewscd'])
    store.revert(UDID)
    expect(read()).toEqual({ 'com.apple.nanonewscd': false })
  })

  it('leaves a device it never applied to exactly as it is', () => {
    // The twin of the case above: another tool (simslim) disabled these, and they are not ours to undo.
    seed({ 'com.apple.assistantd': true })
    const before = readFileSync(storePath(), 'utf8')
    expect(store.revert(UDID)).toBe(false)
    expect(readFileSync(storePath(), 'utf8')).toBe(before)
  })

  it('clears a marker it cannot read, so the device is not stuck behind it', () => {
    // What was there before is lost with the marker; keeping it would fail every revert after this one.
    store.setTier(UDID, LEAN, LABELS)
    writeFileSync(join(dir(), 'tapflow-lean.json'), '{not json')
    expect(() => store.revert(UDID)).toThrow(/marker/)
    expect(store.isApplied(UDID)).toBe(false)
  })

  it('with the managed labels known, recovers an unreadable marker instead of stranding the labels', () => {
    // The labels lose their entries (their plist defaults), the runtime's own entries stay, and the next change
    // starts clean — rather than recording our own `true`s as what the device had.
    const managed = new LeanStore(root, [...LABELS, 'com.apple.apsd'])
    seed({ 'com.apple.nanonewscd': false })
    managed.setTier(UDID, SLIM, [...LABELS, 'com.apple.apsd'])
    writeFileSync(join(dir(), 'tapflow-lean.json'), '{not json')
    expect(managed.revert(UDID)).toBe(true)
    expect(read()).toEqual({ 'com.apple.nanonewscd': false })
    managed.setTier(UDID, LEAN, LABELS)
    managed.setTier(UDID, { name: 'stock', keep: [] }, [])
    expect(read()).toEqual({ 'com.apple.nanonewscd': false })
  })

  it('with the managed labels known but the store unreadable too, keeps the marker so a later revert can finish', () => {
    const managed = new LeanStore(root, LABELS)
    seed({ 'com.apple.nanonewscd': false })
    managed.setTier(UDID, LEAN, LABELS)
    writeFileSync(join(dir(), 'tapflow-lean.json'), '{not json')
    const good = readFileSync(storePath(), 'utf8')
    writeFileSync(storePath(), good.replace('<true/>', '<string>x</string>'))
    expect(() => managed.revert(UDID)).toThrow(/could not be repaired yet/)
    expect(managed.isApplied(UDID)).toBe(true)
    // The store reads again: the same revert now completes.
    writeFileSync(storePath(), good)
    expect(managed.revert(UDID)).toBe(true)
    expect(read()).toEqual({ 'com.apple.nanonewscd': false })
    expect(managed.isApplied(UDID)).toBe(false)
  })

  it('keeps the marker when the store itself cannot be read, rather than rewriting it', () => {
    // The twin of the case above: rewriting a store it cannot fully read would drop the runtime's
    // entries, and dropping the marker would hide that the device is still lean.
    store.setTier(UDID, LEAN, LABELS)
    writeFileSync(storePath(), readFileSync(storePath(), 'utf8').replace('<true/>', '<string>x</string>'))
    const before = readFileSync(storePath(), 'utf8')
    expect(() => store.revert(UDID)).toThrow()
    expect(store.isApplied(UDID)).toBe(true)
    expect(readFileSync(storePath(), 'utf8')).toBe(before)
  })

  it('does not write a store for a device that has none', () => {
    expect(store.revert(UDID)).toBe(false)
    expect(existsSync(dir())).toBe(false)
  })
})

describe('applied', () => {
  it('names the devices carrying the marker, and only those', () => {
    store.setTier(UDID, LEAN, LABELS)
    seed({})
    mkdirSync(join(root, 'com.apple.CoreSimulator.SimDevice.BBBBBBBB-5555-6666-7777-888888888888'))
    expect(store.applied()).toEqual([UDID])
  })
})

describe('changing tiers', () => {
  it('leaves exactly the new tier\'s labels, nothing from the last one (lean → slim → lean)', () => {
    seed({ 'com.apple.nanonewscd': false })
    const slimOnly = ['com.apple.apsd', 'com.apple.chronod']
    store.setTier(UDID, LEAN, LABELS)
    store.setTier(UDID, SLIM, [...LABELS, ...slimOnly])
    expect(read()).toMatchObject(Object.fromEntries(slimOnly.map((l) => [l, true])))
    store.setTier(UDID, LEAN, LABELS)
    // slim's extra labels are gone, not left disabled under a lean marker
    for (const l of slimOnly) expect(read()).not.toHaveProperty(l)
    expect(read()).toMatchObject({ ...Object.fromEntries(LABELS.map((l) => [l, true])), 'com.apple.nanonewscd': false })
    expect(store.currentTier(UDID)).toEqual(LEAN)
  })

  it('stock is the revert: the runtime\'s own entries and nothing of ours', () => {
    seed({ 'com.apple.nanonewscd': false })
    store.setTier(UDID, SLIM, LABELS)
    store.setTier(UDID, { name: 'stock', keep: [] }, [])
    expect(read()).toEqual({ 'com.apple.nanonewscd': false })
    expect(store.isApplied(UDID)).toBe(false)
    expect(store.currentTier(UDID)).toEqual({ name: 'stock', keep: [] })
  })

  it('records the tier with its exceptions', () => {
    const tier: ServiceTier = { name: 'slim', keep: ['push'] }
    store.setTier(UDID, tier, LABELS)
    expect(store.currentTier(UDID)).toEqual(tier)
  })

  it('reads a marker from before tiers as lean, since only Lean mode wrote one', () => {
    store.setTier(UDID, LEAN, LABELS)
    const marker = join(dir(), 'tapflow-lean.json')
    const { prior } = JSON.parse(readFileSync(marker, 'utf8')) as { prior: unknown }
    writeFileSync(marker, JSON.stringify({ prior }))
    expect(store.currentTier(UDID)).toEqual(LEAN)
  })
})
