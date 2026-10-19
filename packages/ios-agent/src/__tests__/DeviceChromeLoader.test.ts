import { describe, it, expect } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { DeviceChromeLoader, screenSizeFromDeviceType, type ChromeRunner } from '../DeviceChromeLoader'

// Shapes as `plutil -convert json` reads the real files. The Xcode 26.6 ones are an iPhone 17 Pro's;
// the Xcode 27 entries are an iPad Pro 11-inch (M4)'s on Xcode 27.0 (27A266a), trimmed to the keys read.
// There every one of 129 device types lists `displays` and none keeps the profile keys.
const xcode26Profile = {
  mainScreenWidth: 1206, mainScreenHeight: 2622, mainScreenScale: 3,
  mainScreenWidthDPI: 460, mainScreenHeightDPI: 460,
}
// Xcode 26.6 already ships capabilities.plist. Where it states the screen at all (116 of 124 types),
// that is under a key nothing reads.
const xcode26Capabilities = {
  capabilities: {
    idiom: 'phone',
    ScreenDimensionsCapability: { 'main-screen-width': 1206, 'main-screen-height': 2622, 'main-screen-scale': 3 },
  },
}
const xcode27Profile = { chromeIdentifier: 'com.apple.dt.devicekit.chrome.tablet5' }
const tvOut = { displayType: 'tvOut', displayName: 'TVOut', width: 720, height: 480, scale: 1 }
const integrated = { displayType: 'integrated', displayName: 'LCD', width: 1668, height: 2420, scale: 2 }
const scene = { displayType: 'scene', displayName: 'Resizable', width: 7680, height: 4320, scale: 3 }
// `integrated` is deliberately not first, so picking the first display gets a different answer.
const xcode27Capabilities = { capabilities: { displays: [tvOut, integrated, scene] } }
// The iPad panel above is @2, so on it alone a scale fixed at 2 would pass. This is iPhone 17e's
// integrated display on Xcode 27.0, @3, which loads there at 390×844.
const phonePanel = { displayType: 'integrated', displayName: 'LCD', width: 1170, height: 2532, scale: 3 }

describe('screenSizeFromDeviceType', () => {
  it('reads the profile on Xcode 26', () => {
    expect(screenSizeFromDeviceType(xcode26Profile, xcode26Capabilities)).toEqual({ width: 402, height: 874 })
  })

  it('reads the integrated display on Xcode 27, wherever it sits in the list', () => {
    expect(screenSizeFromDeviceType(xcode27Profile, xcode27Capabilities)).toEqual({ width: 834, height: 1210 })
  })

  it("divides by the display's own scale", () => {
    expect(screenSizeFromDeviceType(xcode27Profile, { capabilities: { displays: [tvOut, phonePanel] } }))
      .toEqual({ width: 390, height: 844 })
  })

  // No measured install carries both (26.6 has no `displays`, 27 no profile keys): this pins the
  // order, not a shape that occurs.
  it('prefers the profile when both plists carry a size', () => {
    expect(screenSizeFromDeviceType(xcode26Profile, xcode27Capabilities)).toEqual({ width: 402, height: 874 })
  })

  it('has no size when the profile has none and capabilities lists no displays', () => {
    expect(screenSizeFromDeviceType(xcode27Profile, xcode26Capabilities)).toBeNull()
    expect(screenSizeFromDeviceType(xcode27Profile, null)).toBeNull()
  })

  it('has no size when no listed display is integrated', () => {
    expect(screenSizeFromDeviceType(xcode27Profile, { capabilities: { displays: [tvOut, scene] } })).toBeNull()
  })

  it('has no size for a zero scale or a missing dimension', () => {
    expect(screenSizeFromDeviceType({ ...xcode26Profile, mainScreenScale: 0 }, null)).toBeNull()
    const { width: _w, ...noWidth } = phonePanel
    const { height: _h, ...noHeight } = phonePanel
    const { scale: _s, ...noScale } = phonePanel
    for (const panel of [noWidth, noHeight, noScale]) {
      expect(screenSizeFromDeviceType(xcode27Profile, { capabilities: { displays: [panel] } })).toBeNull()
    }
  })
})

// ── Loading off the event loop ─────────────────────────────────────────────
//
// A fake Xcode: a chrome directory on disk (chrome.json and an empty composite PDF, which only has to exist)
// and a runner answering the tools the loader calls. Every external call goes through the runner, so these
// tests see each one — the synchronous `execFileSync` calls they replaced froze the whole agent.
describe('DeviceChromeLoader.load', () => {
  function fixture(opts: { types?: object[]; swift?: ChromeRunner; cacheDir?: string; button?: boolean } = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-chrome-'))
    const res = path.join(root, 'chrome', 'phone.devicechrome', 'Contents', 'Resources')
    fs.mkdirSync(res, { recursive: true })
    const inputs = opts.button ? [{ name: 'power', image: 'Power', anchor: 'right', offsets: { normal: { x: 0, y: 100 } } }] : []
    fs.writeFileSync(path.join(res, 'chrome.json'), JSON.stringify({ images: { sizing: { leftWidth: 10, rightWidth: 10, topHeight: 10, bottomHeight: 10 } }, inputs }))
    fs.writeFileSync(path.join(res, 'PhoneComposite.pdf'), '')
    if (opts.button) fs.writeFileSync(path.join(res, 'Power.pdf'), '')
    const cacheDir = opts.cacheDir ?? path.join(root, 'cache'); fs.mkdirSync(cacheDir, { recursive: true })
    const calls: string[][] = []
    const run: ChromeRunner = async (cmd, args, timeoutMs, signal) => {
      calls.push([cmd, ...args])
      if (cmd === 'xcrun') return Buffer.from(JSON.stringify({ devicetypes: opts.types ?? [{ identifier: 'T', modelIdentifier: 'M', name: 'N' }] }))
      if (cmd === 'plutil') return Buffer.from(JSON.stringify({ M: { ChromeIdentifier: 'com.apple.phone' } }))
      if (cmd === 'sips') return Buffer.from('pixelWidth: 400\npixelHeight: 800\n')
      if (cmd === 'swift') {
        if (opts.swift) return opts.swift(cmd, args, timeoutMs, signal)
        fs.writeFileSync(args[args.length - 1], 'PNG')
        return Buffer.alloc(0)
      }
      throw new Error(`unexpected ${cmd}`)
    }
    const loader = new DeviceChromeLoader({ run, chromeMapPath: path.join(root, 'map.plist'), chromeDir: path.join(root, 'chrome'), cacheDir, loadBudgetMs: 200 })
    return { loader, calls, cacheDir }
  }

  it('renders through the runner and leaves only the cached frame behind', async () => {
    const { loader, calls, cacheDir } = fixture()
    const chrome = await loader.load('T')
    expect(chrome?.framePng).toBe(Buffer.from('PNG').toString('base64'))
    expect(calls.filter((c) => c[0] === 'xcrun')).toHaveLength(1)
    // The script and the temporary image are removed; the frame was renamed into place.
    expect(fs.readdirSync(cacheDir)).toEqual(['tapflow-frame-v3-phone-c400x800.png'])
  })

  it('runs nothing the second time a device type loads', async () => {
    const { loader, calls } = fixture()
    await loader.load('T')
    const after = calls.length
    await loader.load('T')
    expect(calls.length).toBe(after)
  })

  it('shares one load between two boots of the same type that overlap', async () => {
    const { loader, calls } = fixture()
    const [a, b] = await Promise.all([loader.load('T'), loader.load('T')])
    expect(a).toBe(b)
    expect(calls.filter((c) => c[0] === 'swift')).toHaveLength(1)
  })

  // The dashboard mounts no viewer without chrome, so a remembered failure would blank that model until the
  // agent restarted.
  it('does not remember a failed load', async () => {
    const f = fixture({ swift: async () => { throw new Error('swift failed') } })
    expect(await f.loader.load('T')).toBeNull()
    const before = f.calls.length
    expect(await f.loader.load('T')).toBeNull()
    expect(f.calls.length).toBeGreaterThan(before)
  })

  it('gives up on a render that never finishes, within the load budget', async () => {
    const hang: ChromeRunner = (_c, _a, _t, signal) => new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')))
    })
    const { loader, cacheDir } = fixture({ swift: hang })
    const started = Date.now()
    expect(await loader.load('T')).toBeNull()
    expect(Date.now() - started).toBeLessThan(2000)
    // No half-written image is left to be served as cache next time.
    expect(fs.readdirSync(cacheDir).some((f) => f.endsWith('.png'))).toBe(false)
  })

  // The render scripts carry per-device numbers in their text; a shared path let two loads swap them.
  it('gives each render its own script file', async () => {
    const seen: string[] = []
    const record: ChromeRunner = async (_c, args) => { seen.push(args[0]); fs.writeFileSync(args[args.length - 1], 'PNG'); return Buffer.alloc(0) }
    // One cache directory, as on a real Mac where every load shares $TMPDIR.
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-chrome-shared-'))
    const a = fixture({ swift: record, cacheDir, types: [{ identifier: 'T', modelIdentifier: 'M' }] })
    const b = fixture({ swift: record, cacheDir, types: [{ identifier: 'T', modelIdentifier: 'M' }] })
    await Promise.all([a.loader.load('T'), b.loader.load('T')])
    expect(new Set(seen).size).toBe(seen.length)
  })

  // A render killed half-way used to leave a truncated PNG at the cache path, and the mtime check then served
  // it on every later boot.
  it('never leaves a half-written image at the cache path', async () => {
    const dies: ChromeRunner = async (_c, args) => { fs.writeFileSync(args[args.length - 1], 'PN'); throw new Error('killed') }
    const { loader, cacheDir } = fixture({ swift: dies })
    expect(await loader.load('T')).toBeNull()
    expect(fs.readdirSync(cacheDir).some((f) => f.startsWith('tapflow-frame-v3-phone'))).toBe(false)
  })

  it('lists device types once for the process, not once per load', async () => {
    const { loader, calls } = fixture({ types: [{ identifier: 'T', modelIdentifier: 'M' }, { identifier: 'T2', modelIdentifier: 'M' }] })
    await loader.load('T')
    await loader.load('T2')
    expect(calls.filter((c) => c[0] === 'xcrun')).toHaveLength(1)
  })

  // The budget usually runs out in the button renders, after the frame: a load that skipped a button used to
  // be remembered, and that model showed no side buttons until the agent restarted.
  it('does not remember a load that skipped a button, and keeps the one that finished', async () => {
    let swiftCalls = 0
    const flaky: ChromeRunner = async (_c, args) => {
      if (++swiftCalls === 2) throw new Error('killed')
      fs.writeFileSync(args[args.length - 1], 'PNG')
      return Buffer.alloc(0)
    }
    const { loader } = fixture({ swift: flaky, button: true })
    const partial = await loader.load('T')
    expect(partial?.buttons).toHaveLength(1)
    expect(partial?.buttons[0].buttonPng).toBeUndefined()
    const complete = await loader.load('T')
    expect(complete?.buttons[0].buttonPng).toBeDefined()
    // Only the button rendered again: the frame was already on disk.
    expect(swiftCalls).toBe(3)
    expect(await loader.load('T')).toBe(complete)
  })

  // A frame rendered with a button missing has narrower margins than one with all of them.
  it('keys the cached frame by its canvas size', async () => {
    const { loader, cacheDir } = fixture({ button: true })
    await loader.load('T')
    expect(fs.readdirSync(cacheDir).filter((f) => f.startsWith('tapflow-frame-v3-'))).toEqual(['tapflow-frame-v3-phone-c800x800.png'])
  })
})
