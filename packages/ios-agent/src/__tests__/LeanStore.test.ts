import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LeanStore, parseDisabledStore, renderDisabledStore } from '../LeanStore.js'

const UDID = 'AAAAAAAA-1111-2222-3333-444444444444'
const LABELS = ['com.apple.assistantd', 'com.apple.intelligenceflowd', 'com.apple.triald']

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

describe('apply', () => {
  it('creates the directory and the store for a device that has never booted', () => {
    store.apply(UDID, LABELS)
    expect(read()).toEqual(Object.fromEntries(LABELS.map((l) => [l, true])))
    // launchd_sim creates it 0700; a store we create should not be wider than the runtime's own.
    expect(statSync(dir()).mode & 0o777).toBe(0o700)
    expect(store.isApplied(UDID)).toBe(true)
  })

  it('keeps every entry it does not manage', () => {
    seed({ 'com.apple.nanonewscd': false, 'com.apple.otpaird': true })
    store.apply(UDID, LABELS)
    expect(read()).toMatchObject({ 'com.apple.nanonewscd': false, 'com.apple.otpaird': true })
  })
})

describe('revert', () => {
  it('puts back what each label was, including labels that had no entry', () => {
    // `intelligenceflowd` is off by default in its plist; writing `false` on revert would turn it on.
    seed({ 'com.apple.intelligenceflowd': true, 'com.apple.triald': false, 'com.apple.nanonewscd': false })
    store.apply(UDID, LABELS)
    expect(store.revert(UDID)).toBe(true)
    expect(read()).toEqual({ 'com.apple.intelligenceflowd': true, 'com.apple.triald': false, 'com.apple.nanonewscd': false })
    expect(store.isApplied(UDID)).toBe(false)
  })

  it('a second apply does not record its own values as what was there before', () => {
    seed({ 'com.apple.triald': false })
    store.apply(UDID, LABELS)
    store.apply(UDID, LABELS)
    store.revert(UDID)
    expect(read()).toEqual({ 'com.apple.triald': false })
  })

  it('records labels a later list adds, so they are put back too', () => {
    // A device marked by one version and booted by a newer one whose list is longer: the new
    // labels were not in the marker, and without this they stayed disabled after the revert.
    seed({ 'com.apple.nanonewscd': false })
    store.apply(UDID, LABELS.slice(0, 2))
    store.apply(UDID, [...LABELS, 'com.apple.nanonewscd'])
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
    store.apply(UDID, LABELS)
    writeFileSync(join(dir(), 'tapflow-lean.json'), '{not json')
    expect(() => store.revert(UDID)).toThrow(/marker/)
    expect(store.isApplied(UDID)).toBe(false)
  })

  it('keeps the marker when the store itself cannot be read, rather than rewriting it', () => {
    // The twin of the case above: rewriting a store it cannot fully read would drop the runtime's
    // entries, and dropping the marker would hide that the device is still lean.
    store.apply(UDID, LABELS)
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
    store.apply(UDID, LABELS)
    seed({})
    mkdirSync(join(root, 'com.apple.CoreSimulator.SimDevice.BBBBBBBB-5555-6666-7777-888888888888'))
    expect(store.applied()).toEqual([UDID])
  })
})
